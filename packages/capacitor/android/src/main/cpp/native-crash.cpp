// Edge RUM — Android NDK signal handler.
//
// Catches the signal class normally fatal to JNI/native code (SIGSEGV/SIGBUS/SIGILL/SIGFPE/SIGABRT),
// writes a minimal binary record to a pre-opened file descriptor, and re-raises the signal so the
// OS still kills the process (and the platform's tombstone capture / Crashlytics if any still runs).
//
// IMPORTANT — async-signal-safety constraints:
//   - No malloc / new / free.
//   - No printf / fprintf / NSLog / __android_log_print.
//   - No JNI calls.
//   - Only POSIX async-signal-safe functions: write(), _exit(), sigaction(), etc.
//
// Frame capture uses libunwind via __builtin_frame_address — minimal, no allocation, works on all ABIs.

#include <jni.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <unwind.h>

static constexpr uint32_t MAGIC = 0xED9E51DE;
static constexpr uint32_t END_MARKER = 0xEEEEEEEE;
static constexpr size_t MAX_FRAMES = 32;

static int g_record_fd = -1;  // Pre-opened on install; written to from the signal handler.
static struct sigaction g_old_handlers[NSIG];

struct BacktraceState {
    uintptr_t* frames;
    size_t count;
    size_t cap;
};

static _Unwind_Reason_Code unwind_cb(struct _Unwind_Context* ctx, void* arg) {
    BacktraceState* state = (BacktraceState*)arg;
    if (state->count >= state->cap) return _URC_END_OF_STACK;
    uintptr_t pc = _Unwind_GetIP(ctx);
    if (pc != 0) {
        state->frames[state->count++] = pc;
    }
    return _URC_NO_REASON;
}

// Write all bytes or give up — partial writes leave the record corrupt and the
// Kotlin reader will skip it on next launch.
static void write_all(int fd, const void* buf, size_t len) {
    const char* p = (const char*)buf;
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n <= 0) return;
        p += n;
        len -= (size_t)n;
    }
}

static void crash_handler(int signum, siginfo_t* info, void* /*ctx*/) {
    if (g_record_fd < 0) {
        goto restore;
    }

    {
        uintptr_t frame_buf[MAX_FRAMES];
        BacktraceState state = { frame_buf, 0, MAX_FRAMES };
        _Unwind_Backtrace(unwind_cb, &state);

        uint32_t magic = MAGIC;
        uint32_t signal_int = (uint32_t)signum;
        uint64_t fault_addr = info != nullptr ? (uint64_t)(uintptr_t)info->si_addr : 0;

        // CLOCK_REALTIME is async-signal-safe on POSIX. ms since epoch.
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        uint64_t ts_millis = (uint64_t)ts.tv_sec * 1000ULL + (uint64_t)(ts.tv_nsec / 1000000);

        uint16_t frame_count = (uint16_t)state.count;
        uint32_t end = END_MARKER;

        write_all(g_record_fd, &magic, sizeof(magic));
        write_all(g_record_fd, &signal_int, sizeof(signal_int));
        write_all(g_record_fd, &fault_addr, sizeof(fault_addr));
        write_all(g_record_fd, &ts_millis, sizeof(ts_millis));
        write_all(g_record_fd, &frame_count, sizeof(frame_count));
        for (size_t i = 0; i < state.count; i++) {
            uint64_t f = (uint64_t)state.frames[i];
            write_all(g_record_fd, &f, sizeof(f));
        }
        write_all(g_record_fd, &end, sizeof(end));
        // fsync is signal-safe; ensures record is on disk before the OS pulls the rug.
        fsync(g_record_fd);
    }

restore:
    // Restore the original handler and re-raise so the OS / Crashlytics still capture.
    if (signum > 0 && signum < NSIG) {
        sigaction(signum, &g_old_handlers[signum], nullptr);
    }
    raise(signum);
}

static void install_signal_handler(int signum) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_sigaction = crash_handler;
    action.sa_flags = SA_SIGINFO | SA_RESETHAND;
    sigemptyset(&action.sa_mask);
    sigaction(signum, &action, &g_old_handlers[signum]);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_nathanclaire_rum_NativeCrashBridge_nativeInstall(JNIEnv* env, jobject /*thiz*/, jstring jPath) {
    if (g_record_fd >= 0) return JNI_TRUE;

    const char* path = env->GetStringUTFChars(jPath, nullptr);
    if (path == nullptr) return JNI_FALSE;
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    env->ReleaseStringUTFChars(jPath, path);
    if (fd < 0) return JNI_FALSE;
    g_record_fd = fd;

    // Catch the common fatal signals.
    install_signal_handler(SIGSEGV);
    install_signal_handler(SIGBUS);
    install_signal_handler(SIGILL);
    install_signal_handler(SIGFPE);
    install_signal_handler(SIGABRT);
    return JNI_TRUE;
}

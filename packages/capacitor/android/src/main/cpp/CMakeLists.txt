cmake_minimum_required(VERSION 3.22.1)

project(edge-rum-native LANGUAGES CXX)

add_library(edge-rum-native SHARED
    native-crash.cpp
)

# Async-signal-safe code only — no STL allocations in the signal path.
# Keep symbols hidden by default; we expose only the JNI entry point.
target_compile_options(edge-rum-native PRIVATE
    -fvisibility=hidden
    -fno-exceptions
    -fno-rtti
    -Wall
    -Wextra
)

# Needed for _Unwind_Backtrace.
target_link_libraries(edge-rum-native
    log
)

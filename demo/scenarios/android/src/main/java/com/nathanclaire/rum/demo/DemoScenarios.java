package com.nathanclaire.rum.demo;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Demo app only: native scenarios + the `scenario` intent extra (`am start … --es scenario <name>`). */
@CapacitorPlugin(name = "DemoScenarios")
public class DemoScenarios extends Plugin {
    // listen (plugin thread) and deliver (UI thread) synchronize on this plugin.
    private boolean listening;
    private String pending;

    @Override
    public synchronized void load() {
        pending = getActivity().getIntent().getStringExtra("scenario");
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String s = intent.getStringExtra("scenario");
        if (s != null) deliver(s);
    }

    /** Hands over a deep link that arrived before the web app was listening. */
    @PluginMethod
    public synchronized void listen(PluginCall call) {
        listening = true;
        JSObject r = new JSObject();
        r.put("scenario", pending == null ? "" : pending);
        pending = null;
        call.resolve(r);
    }

    @PluginMethod
    public void slow(PluginCall call) {
        long ms = call.getInt("ms", 0);
        new Thread(() -> {
            sleep(ms);
            call.resolve();
        }).start();
    }

    @PluginMethod
    public void hang(PluginCall call) {
        long ms = call.getInt("ms", 0);
        call.resolve();
        getActivity().runOnUiThread(() -> sleep(ms));
    }

    @PluginMethod
    public void crash(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            throw new IllegalStateException("Demo native crash");
        });
    }

    @PluginMethod
    public void killRenderer(PluginCall call) {
        call.resolve(); // answered first: the call must not outlive the renderer
        getActivity().runOnUiThread(() -> getBridge().getWebView().loadUrl("chrome://crash"));
    }

    /** Pushed by eval, not a listener: deep links are untrusted input, so names only. */
    private synchronized void deliver(String scenario) {
        if (!scenario.matches("[a-z-]+")) return;
        if (!listening) {
            pending = scenario;
            return;
        }
        String js = "window.runScenario('" + scenario + "')";
        getActivity().runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(js, null));
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}

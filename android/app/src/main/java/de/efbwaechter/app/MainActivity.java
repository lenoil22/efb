package de.efbwaechter.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/** Oberfläche: die Handy-Seite des EFB (GitHub Pages) in einer WebView, mit Zugriff auf die Wecker-Funktionen. */
public class MainActivity extends Activity {
    static final String UI_URL = "https://lenoil22.github.io/efb/handy/";
    static final String UI_HOST = "lenoil22.github.io";
    private WebView web;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(Color.rgb(10, 15, 22));
        getWindow().setNavigationBarColor(Color.rgb(10, 15, 22));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(10, 15, 22));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Js(), "EFBApp");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (UI_HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/efb/")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;                                  // fremde Seiten im Browser, nicht in der App
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadUrl("file:///android_asset/offline.html");
            }
        });
        setContentView(web);
        web.loadUrl(UI_URL);

        java.util.ArrayList<String> need = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        // neuere Android-Versionen: Zugriff aufs Heimnetz (WLAN direkt zum PC) braucht eine Erlaubnis
        if (Build.VERSION.SDK_INT >= 36 && checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED)
            need.add("android.permission.ACCESS_LOCAL_NETWORK");
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 1);
        pairFrom(getIntent());
        WatchService.start(this);
    }

    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); pairFrom(i); }

    @Override protected void onResume() {
        super.onResume();
        WatchService.uiListener = () -> web.evaluateJavascript("window.efbUpdate&&efbUpdate()", null);
        WatchService.liveListener = () -> web.evaluateJavascript("window.efbLive&&efbLive()", null);
        web.evaluateJavascript("window.efbUpdate&&efbUpdate()", null);
    }
    @Override protected void onPause() { WatchService.uiListener = null; WatchService.liveListener = null; super.onPause(); }

    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }

    /** efbwaechter://pair?topic=efb-… (QR-Code aus der PC-Bridge) */
    private void pairFrom(Intent i) {
        Uri d = i == null ? null : i.getData();
        if (d == null || !"efbwaechter".equals(d.getScheme())) return;
        String t = d.getQueryParameter("topic");
        if (t == null || !t.matches("efb-[A-Za-z0-9]{8,64}")) { Toast.makeText(this, "Ungültiger Kopplungs-Code", Toast.LENGTH_LONG).show(); return; }
        Prefs.topic(this, t);
        WatchService.reconnect();
        Toast.makeText(this, "Mit dem PC gekoppelt", Toast.LENGTH_LONG).show();
        web.evaluateJavascript("window.efbUpdate&&efbUpdate()", null);
    }

    /** Schnittstelle für die Seite: window.EFBApp */
    class Js {
        @JavascriptInterface public String state() {
            try {
                JSONObject o = new JSONObject();
                o.put("topic", Prefs.topic(MainActivity.this));
                JSONObject modes = new JSONObject();
                for (String k : Prefs.KINDS) modes.put(k, Prefs.mode(MainActivity.this, k));
                o.put("modes", modes);
                o.put("history", new JSONArray(Prefs.history(MainActivity.this)));
                String st = Prefs.status(MainActivity.this);
                o.put("status", st.isEmpty() ? JSONObject.NULL : new JSONObject(st));
                o.put("connected", WatchService.connected);
                o.put("lan", WatchService.lanConnected);
                NotificationManager nm = getSystemService(NotificationManager.class);
                o.put("notif", nm.areNotificationsEnabled());
                o.put("fsi", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent());
                o.put("battery", getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName()));
                o.put("version", BuildConfigVersion.NAME);
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }
        /** Live-Daten aus dem Sim (WLAN direkt), sonst "" */
        @JavascriptInterface public String live() { return WatchService.lanConnected ? WatchService.live : ""; }
        @JavascriptInterface public void setTopic(String t) {
            Prefs.topic(MainActivity.this, t == null ? "" : t.trim());
            WatchService.reconnect();
        }
        @JavascriptInterface public void setMode(String kind, int mode) { Prefs.mode(MainActivity.this, kind, Math.max(0, Math.min(3, mode))); }
        @JavascriptInterface public void send(String cmd) { if ("weg".equals(cmd) || "da".equals(cmd)) WatchService.sendCmd(MainActivity.this, cmd); }
        @JavascriptInterface public void testAlarm(String kind) {
            runOnUiThread(() -> { WatchService s = WatchService.inst; if (s != null) s.ring("test", "Wecker-Test", "So klingt der Wecker. Tippe „Bin dran“."); });
        }
        @JavascriptInterface public void openFsi() {
            if (Build.VERSION.SDK_INT >= 34) open(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
        }
        @JavascriptInterface public void openBattery() {
            open(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        }
        @JavascriptInterface public void openNotif() {
            open(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        }
        private void open(Intent i) { runOnUiThread(() -> { try { startActivity(i); } catch (Exception e) { Toast.makeText(MainActivity.this, "Einstellung nicht gefunden", Toast.LENGTH_SHORT).show(); } }); }
    }
}

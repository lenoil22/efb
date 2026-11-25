package de.efbwaechter.app;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.OpenableColumns;
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
    private static final int REQ_SYS = 10, REQ_FILE = 11;
    private String pickKind = "*";
    private MediaPlayer preview;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable stopPrev = this::stopPreview;

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
    @Override protected void onPause() { WatchService.uiListener = null; WatchService.liveListener = null; stopPreview(); super.onPause(); }

    /* ---------- Weckerton: Handy-Ton oder eigene Datei wählen, kurz probehören ---------- */
    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK || data == null) return;
        try {
            if (req == REQ_SYS) {
                Uri u = data.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
                if (u == null) return;
                String name = "Handy-Ton";
                try { name = RingtoneManager.getRingtone(this, u).getTitle(this); } catch (Exception ignored) { }
                Prefs.sound(this, pickKind, u.toString(), name);
                playPreview(u.toString());
            } else if (req == REQ_FILE) {
                Uri u = data.getData();
                if (u == null) return;
                try { getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
                String name = "Eigene Datei";
                try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (c != null && c.moveToFirst()) name = c.getString(0).replaceAll("\\.[A-Za-z0-9]{2,4}$", "");
                } catch (Exception ignored) { }
                Prefs.sound(this, pickKind, u.toString(), name);
                playPreview(u.toString());
            }
        } catch (Exception e) { Toast.makeText(this, "Ton konnte nicht übernommen werden", Toast.LENGTH_SHORT).show(); }
        web.evaluateJavascript("window.efbUpdate&&efbUpdate()", null);
    }
    void playPreview(String uri) {
        stopPreview();
        try { preview = WatchService.play(this, Uri.parse(uri), true); h.postDelayed(stopPrev, 6000); }
        catch (Exception e) { Toast.makeText(this, "Ton lässt sich nicht abspielen", Toast.LENGTH_SHORT).show(); }
    }
    void stopPreview() {
        h.removeCallbacks(stopPrev);
        if (preview != null) { try { preview.stop(); preview.release(); } catch (Exception ignored) { } preview = null; }
    }

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
                o.put("logbook", new JSONArray(Prefs.logbook(MainActivity.this)));
                o.put("liveNotif", Prefs.liveNotif(MainActivity.this));
                JSONObject snd = new JSONObject();                // Weckerton je Alarmart: gesetzt? + was wirklich spielt
                String[] all = Prefs.soundFor(MainActivity.this, "*");
                snd.put("*", new JSONObject().put("set", Prefs.sound(MainActivity.this, "*")).put("uri", all[0]).put("name", all[1]));
                for (String k : Prefs.KINDS) {
                    String[] e = Prefs.soundFor(MainActivity.this, k);
                    snd.put(k, new JSONObject().put("set", Prefs.sound(MainActivity.this, k)).put("uri", e[0]).put("name", e[1]));
                }
                o.put("sounds", snd);
                JSONArray bi = new JSONArray();
                for (String[] b : Prefs.BUILTIN) bi.put(new JSONObject().put("uri", Prefs.builtinUri(MainActivity.this, b[0])).put("name", b[1]));
                o.put("builtin", bi);
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
        /** Befehle an die PC-Bridge: weg/da, Sim pausieren/weiter, IDENT, Antwort an Lotsen, ATIS/METAR abfragen */
        @JavascriptInterface public void send(String cmd) {
            if (cmd == null) return;
            String c = cmd.trim();
            boolean ok = c.matches("weg|da|pause|resume|ident")
                    || c.matches("pm:[A-Za-z0-9_]{2,20}:.{1,240}")
                    || c.matches("(atis|metar):[A-Za-z0-9_]{3,12}");
            if (ok) WatchService.sendCmd(MainActivity.this, c);
        }
        /** kind "*" = für alle; uri "" = Standard, "inherit" = wie alle */
        @JavascriptInterface public void setSound(String kind, String uri, String name) { Prefs.sound(MainActivity.this, kind, uri, name); }
        @JavascriptInterface public void preview(String uri) { runOnUiThread(() -> playPreview(uri)); }
        @JavascriptInterface public void stopPreview() { runOnUiThread(MainActivity.this::stopPreview); }
        @JavascriptInterface public void pickSystem(String kind) {
            runOnUiThread(() -> {
                pickKind = kind; stopPreview();
                Intent i = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
                        .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_ALARM)
                        .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
                        .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, false)
                        .putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Weckerton");
                String cur = Prefs.sound(MainActivity.this, kind);
                if (cur.startsWith("content://")) i.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, Uri.parse(cur));
                try { startActivityForResult(i, REQ_SYS); } catch (Exception e) { Toast.makeText(MainActivity.this, "Ton-Auswahl nicht gefunden", Toast.LENGTH_SHORT).show(); }
            });
        }
        @JavascriptInterface public void pickFile(String kind) {
            runOnUiThread(() -> {
                pickKind = kind; stopPreview();
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*");
                try { startActivityForResult(i, REQ_FILE); } catch (Exception e) { Toast.makeText(MainActivity.this, "Dateiauswahl nicht gefunden", Toast.LENGTH_SHORT).show(); }
            });
        }
        @JavascriptInterface public void setLiveNotif(boolean on) { Prefs.liveNotif(MainActivity.this, on); WatchService.liveSetting(); }
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

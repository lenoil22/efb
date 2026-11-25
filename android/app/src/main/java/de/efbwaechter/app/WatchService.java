package de.efbwaechter.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.wifi.WifiManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Hält im Hintergrund die Verbindung zum ntfy-Kanal der PC-Bridge (Alarme + Status-Kanal)
 * und löst je nach Einstellung eine Nachricht oder den Wecker aus.
 */
public class WatchService extends Service {
    static volatile WatchService inst;
    static volatile boolean connected;
    static volatile Runnable uiListener;           // MainActivity: Oberfläche neu laden

    static final String CH_SVC = "svc", CH_MSG = "msg", CH_ALARM = "wecker", CH_LIVE = "live";
    static final int ID_SVC = 1, ID_ALARM = 2, ID_LIVE = 3;
    /** Schnell-Antworten an den Lotsen (Privatnachricht über vPilot) */
    static final String[] QUICK = {"Roger", "Back at the controls in 2 min", "Wilco"};
    private static int nextId = 100;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Thread worker;
    private volatile boolean running;
    private volatile HttpURLConnection con;
    private MediaPlayer player;
    private PowerManager.WakeLock wake;
    private String ringingKind = "";
    private final Runnable autoStop = () -> stopRing(false);

    static void start(Context c) {
        Intent i = new Intent(c, WatchService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }
    static void reconnect() { WatchService s = inst; if (s != null) s.dropConnection(); }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        inst = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel svc = new NotificationChannel(CH_SVC, "Verbindung zum PC", NotificationManager.IMPORTANCE_LOW);
        svc.setShowBadge(false);
        NotificationChannel msg = new NotificationChannel(CH_MSG, "Alarme als Nachricht", NotificationManager.IMPORTANCE_HIGH);
        NotificationChannel alarm = new NotificationChannel(CH_ALARM, "Wecker", NotificationManager.IMPORTANCE_HIGH);
        alarm.setSound(null, null);                  // Ton spielt die App selbst (Wecker-Lautstärke, Dauerschleife)
        alarm.enableVibration(false);
        alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel lv = new NotificationChannel(CH_LIVE, "Flug live (Sperrbildschirm)", NotificationManager.IMPORTANCE_DEFAULT);
        lv.setSound(null, null); lv.enableVibration(false); lv.setShowBadge(false);
        lv.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(svc); nm.createNotificationChannel(msg); nm.createNotificationChannel(alarm); nm.createNotificationChannel(lv);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = svcNotification("Verbindet …");
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_SVC, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID_SVC, n);
        if (worker == null) {
            running = true;
            worker = new Thread(this::loop, "ntfy");
            worker.start();
            lanWorker = new Thread(this::lanLoop, "wlan");
            lanWorker.start();
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false; dropConnection(); stopRing(false); inst = null;
        super.onDestroy();
    }

    /* ---------- Verbindung zum ntfy-Kanal (JSON-Stream) ---------- */
    private void loop() {
        while (running) {
            String topic = Prefs.topic(this);
            if (topic.isEmpty()) { setConnected(false, "Nicht gekoppelt – App öffnen"); sleep(3000); continue; }
            try {
                String last = Prefs.lastId(this);
                String url = Prefs.SERVER + "/" + enc(topic) + "," + enc(topic + "-status") + "/json?since=" + (last.isEmpty() ? "12h" : enc(last));
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(100000);                 // ntfy schickt alle ~45 s ein keepalive
                con = c;
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                setConnected(true, "Verbunden mit dem PC-Kanal");
                String line;
                while (running && (line = r.readLine()) != null) {
                    if (line.isEmpty()) continue;
                    try { handle(new JSONObject(line)); } catch (Exception ignored) { }
                    if (!topic.equals(Prefs.topic(this))) break;   // neu gekoppelt
                }
            } catch (Exception e) {
                // Netz weg, Timeout, neu gekoppelt …
            } finally {
                HttpURLConnection c = con; con = null; if (c != null) c.disconnect();
            }
            if (running) { setConnected(false, "Verbindung getrennt – neuer Versuch …"); sleep(5000); }
        }
    }
    private void dropConnection() {
        HttpURLConnection c = con; if (c != null) try { c.disconnect(); } catch (Exception ignored) { }
        HttpURLConnection l = lanCon; if (l != null) try { l.disconnect(); } catch (Exception ignored) { }
    }

    /* ---------- WLAN direkt: PC per UDP-Rundruf finden, Server-Sent Events empfangen ---------- */
    static volatile boolean lanConnected;
    static volatile String live = "";                 // letzte Live-Daten aus dem Sim (JSON)
    static volatile Runnable liveListener;
    private Thread lanWorker;
    private volatile HttpURLConnection lanCon;
    private WifiManager.MulticastLock mlock;

    private void lanLoop() {
        int fails = 0;
        while (running) {
            String topic = Prefs.topic(this);
            if (topic.isEmpty()) { sleep(3000); continue; }
            String hp = discover(sha12(topic));
            if (hp != null) {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL("http://" + hp + "/events?k=" + enc(topic)).openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(45000);                     // Bridge schickt alle 20 s ein Lebenszeichen
                    lanCon = c;
                    BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                    setLan(true); fails = 0;
                    String ev = "message", line; StringBuilder data = new StringBuilder();
                    while (running && (line = r.readLine()) != null) {
                        if (line.isEmpty()) { if (data.length() > 0) lanEvent(ev, data.toString()); ev = "message"; data.setLength(0); continue; }
                        if (line.startsWith(":")) continue;
                        if (line.startsWith("event:")) ev = line.substring(6).trim();
                        else if (line.startsWith("data:")) data.append(line.substring(5).trim());
                        if (!topic.equals(Prefs.topic(this))) break;
                    }
                } catch (Exception ignored) {
                } finally { HttpURLConnection c = lanCon; lanCon = null; if (c != null) c.disconnect(); }
            }
            setLan(false);
            fails++;
            sleep(Math.min(30000, 3000L * fails));          // nicht im Heim-WLAN → seltener suchen (Akku)
        }
    }

    /** Wartet bis 6 s auf den Rundruf der eigenen PC-Bridge; sonst letzte bekannte Adresse. */
    private String discover(String id) {
        DatagramSocket s = null;
        try {
            if (mlock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                mlock = wm.createMulticastLock("efb"); mlock.setReferenceCounted(false);
            }
            mlock.acquire();
            s = new DatagramSocket(null);
            s.setReuseAddress(true); s.setBroadcast(true);
            s.bind(new InetSocketAddress(8791));
            s.setSoTimeout(6000);
            byte[] b = new byte[512];
            long end = System.currentTimeMillis() + 6000;
            while (System.currentTimeMillis() < end) {
                DatagramPacket p = new DatagramPacket(b, b.length);
                s.receive(p);
                JSONObject o = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                if (id.equals(o.optString("id"))) {
                    String hp = p.getAddress().getHostAddress() + ":" + o.optInt("port", 8790);
                    Prefs.p(this).edit().putString("lanHost", hp).apply();
                    return hp;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (s != null) s.close();
            if (mlock != null && mlock.isHeld()) mlock.release();
        }
        String last = Prefs.p(this).getString("lanHost", "");
        return last.isEmpty() ? null : last;
    }

    private void lanEvent(String ev, String data) {
        try {
            if ("alarm".equals(ev)) {
                JSONObject o = new JSONObject(data);
                alarm(o.optString("aid"), o.optLong("t", System.currentTimeMillis()), o.optString("kind", "info"), o.optString("title", "EFB"), o.optString("message", ""), o.optString("from", ""));
            } else if ("status".equals(ev)) {
                JSONObject s = new JSONObject(data);
                if (!s.has("rx")) s.put("rx", System.currentTimeMillis());
                Prefs.status(this, s.toString()); ui();
            } else if ("live".equals(ev)) {
                live = data;
                Runnable r = liveListener; if (r != null) main.post(r);
                updateLive(data);
            } else if ("logbook".equals(ev)) {
                new JSONArray(data);                       // nur gültiges JSON speichern
                Prefs.logbook(this, data); ui();
            }
        } catch (Exception ignored) { }
    }
    private void setLan(boolean c) { boolean ch = lanConnected != c; lanConnected = c; if (!c) { live = ""; updateLive(""); } if (ch) ui(); }

    static String sha12(String s) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder h = new StringBuilder(); for (byte x : d) h.append(String.format("%02x", x));
            return h.substring(0, 12);
        } catch (Exception e) { return ""; }
    }

    private void handle(JSONObject m) throws Exception {
        if (!"message".equals(m.optString("event"))) return;
        String id = m.optString("id"), topic = m.optString("topic");
        long t = m.optLong("time") * 1000L;
        Prefs.lastId(this, id);
        if (topic.endsWith("-status")) {
            JSONObject s = new JSONObject(m.optString("message", "{}"));
            s.put("rx", t);
            Prefs.status(this, s.toString());
            ui(); return;
        }
        String kind = "info", aid = "", from = "";
        JSONArray tags = m.optJSONArray("tags");
        if (tags != null) for (int i = 0; i < tags.length(); i++) {
            String g = tags.optString(i);
            if (g.startsWith("efb-")) kind = g.substring(4);
            if (g.startsWith("aid-")) aid = g.substring(4);
            if (g.startsWith("from-")) from = g.substring(5).toUpperCase();
        }
        alarm(aid.isEmpty() ? id : aid, t, kind, m.optString("title", "EFB"), m.optString("message", ""), from);
    }

    /** Ein Alarm – egal ob über ntfy oder WLAN direkt. Gleiche ID (aid) → nur einmal. */
    private synchronized void alarm(String hid, long t, String kind, String title, String msg, String from) {
        int set = Prefs.mode(this, kind);
        // 2 = Wecker nur, wenn du weg bist (Weg-Modus der PC-Bridge) – am PC reicht eine Nachricht
        int mode = set == 3 ? 2 : set == 2 ? (Prefs.away(this) ? 2 : 1) : set;
        boolean fresh = Prefs.addHistory(this, hid, t, kind, title, msg, mode, from);
        ui();
        if (!fresh || System.currentTimeMillis() - t > 120000) return;   // alte Meldungen beim Wiederverbinden: nur in den Verlauf
        final String k = kind;
        final String fr = "contact".equals(kind) ? from : "";
        if (mode == 2) main.post(() -> ring(k, title, msg, fr));
        else if (mode == 1) message(title, msg, fr);
    }

    /* ---------- Nachricht ---------- */
    private void message(String title, String msg, String from) {
        int id = nextId++;
        Notification.Builder b = new Notification.Builder(this, CH_MSG)
                .setSmallIcon(R.drawable.ic_plane).setContentTitle(title).setContentText(msg)
                .setStyle(new Notification.BigTextStyle().bigText(msg))
                .setContentIntent(openApp()).setAutoCancel(true);
        replyActions(b, from, id);
        getSystemService(NotificationManager.class).notify(id, b.build());
    }

    /** Lotsen-Nachricht: „Antworten“ (eigener Text direkt in der Benachrichtigung) + zwei Schnell-Antworten */
    private void replyActions(Notification.Builder b, String from, int nid) {
        if (from == null || from.isEmpty()) return;
        Intent ri = new Intent(this, ActionReceiver.class).setAction(ActionReceiver.REPLY).putExtra("from", from).putExtra("nid", nid);
        PendingIntent rp = PendingIntent.getBroadcast(this, nid * 10, ri, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        b.addAction(new Notification.Action.Builder(null, "Antworten", rp)
                .addRemoteInput(new RemoteInput.Builder(ActionReceiver.KEY_TEXT).setLabel("Antwort an " + from).build()).build());
        for (int i = 0; i < 2; i++) {
            Intent qi = new Intent(this, ActionReceiver.class).setAction(ActionReceiver.REPLY).putExtra("from", from).putExtra("nid", nid).putExtra("text", QUICK[i]);
            b.addAction(new Notification.Action.Builder(null, QUICK[i], PendingIntent.getBroadcast(this, nid * 10 + 1 + i, qi, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)).build());
        }
    }

    /* ---------- Live-Status auf dem Sperrbildschirm: „TOD in 12 min“ (nur in der Luft, nur mit WLAN-Live-Daten) ---------- */
    private String liveShown = "";
    private long liveAt;
    private synchronized void updateLive(String data) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            JSONObject o = data == null || data.isEmpty() ? null : new JSONObject(data);
            if (o == null || !Prefs.liveNotif(this) || o.optBoolean("gnd", true)) {
                if (!liveShown.isEmpty()) { nm.cancel(ID_LIVE); liveShown = ""; }
                return;
            }
            long now = System.currentTimeMillis();
            int tod = o.isNull("todMin") ? -1 : o.optInt("todMin", -1), eta = o.isNull("etaMin") ? -1 : o.optInt("etaMin", -1);
            int alt = o.optInt("alt", 0), gs = o.optInt("gs", 0);
            String title = tod >= 0 ? "TOD in " + tod + " min" : eta >= 0 ? "Landung in " + eta + " min" : "Im Flug";
            String chip = tod >= 0 ? "TOD " + tod + "′" : eta >= 0 ? eta + " min" : "";
            java.text.SimpleDateFormat hm = new java.text.SimpleDateFormat("HH:mm", java.util.Locale.GERMANY);
            String text = (alt >= 10000 ? "FL" + Math.round(alt / 100f) : alt + " ft") + " · " + gs + " kt"
                    + (tod >= 0 ? " · TOD " + hm.format(new java.util.Date(now + tod * 60000L)) : "")
                    + (eta >= 0 ? " · ETA " + hm.format(new java.util.Date(now + eta * 60000L)) : "");
            String key = title + "|" + text;
            if (key.equals(liveShown) || (!liveShown.isEmpty() && now - liveAt < 10000)) return;
            liveShown = key; liveAt = now;
            Notification.Builder b = new Notification.Builder(this, CH_LIVE)
                    .setSmallIcon(R.drawable.ic_plane).setContentTitle(title).setContentText(text)
                    .setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
                    .setVisibility(Notification.VISIBILITY_PUBLIC).setCategory(Notification.CATEGORY_STATUS)
                    .setContentIntent(openApp());
            if (Build.VERSION.SDK_INT >= 36) {                   // Android 16+: „Live-Update“ als Chip oben in der Statusleiste
                try { Notification.Builder.class.getMethod("setRequestPromotedOngoing", boolean.class).invoke(b, true); } catch (Exception ignored) { }
                if (!chip.isEmpty()) try { Notification.Builder.class.getMethod("setShortCriticalText", String.class).invoke(b, chip); } catch (Exception ignored) { }
            }
            nm.notify(ID_LIVE, b.build());
        } catch (Exception ignored) { }
    }
    /** Einstellung geändert: sofort zeigen bzw. weg */
    static void liveSetting() { WatchService s = inst; if (s != null) { s.liveAt = 0; s.updateLive(lanConnected ? live : ""); } }

    /* ---------- Wecker: Vollbild, Dauerklingeln über die Wecker-Lautstärke, Vibration ---------- */
    void ring(String kind, String title, String msg) { ring(kind, title, msg, ""); }
    void ring(String kind, String title, String msg, String from) {
        stopRing(false);
        ringingKind = kind;
        try {
            PowerManager pm = getSystemService(PowerManager.class);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "efb:wecker");
            wake.acquire(6 * 60 * 1000L);
        } catch (Exception ignored) { }
        // gewählter Ton → sonst eingebauter Gong (z. B. eigene Datei gelöscht) → sonst Weckerton des Handys
        String[] snd = Prefs.soundFor(this, kind);
        try { player = play(this, Uri.parse(snd[0]), true); }
        catch (Exception e) {
            try { player = play(this, Uri.parse(Prefs.builtinUri(this, "efb_gong")), true); }
            catch (Exception e2) {
                try {
                    Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
                    if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                    player = play(this, u, true);
                } catch (Exception ignored) { }
            }
        }
        try {
            Vibrator v = getSystemService(Vibrator.class);
            v.vibrate(VibrationEffect.createWaveform(new long[]{0, 900, 600}, 0),
                    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        } catch (Exception ignored) { }

        Intent full = new Intent(this, AlarmActivity.class).putExtra("title", title).putExtra("msg", msg).putExtra("from", from == null ? "" : from)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(this, 2, full, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent ack = PendingIntent.getBroadcast(this, 3, new Intent(this, ActionReceiver.class).setAction(ActionReceiver.ACK), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder nb = new Notification.Builder(this, CH_ALARM)
                .setSmallIcon(R.drawable.ic_plane).setContentTitle(title).setContentText(msg)
                .setCategory(Notification.CATEGORY_ALARM).setOngoing(true)
                .setFullScreenIntent(fullPi, true).setContentIntent(fullPi)
                .addAction(new Notification.Action.Builder(null, "Bin dran", ack).build());
        replyActions(nb, from, ID_ALARM);
        getSystemService(NotificationManager.class).notify(ID_ALARM, nb.build());
        main.removeCallbacks(autoStop);
        main.postDelayed(autoStop, 5 * 60 * 1000L);     // spätestens nach 5 min Ruhe
    }

    /** ack = „Bin dran“: meldet dem PC, dass du zurück bist (außer beim Test). */
    void stopRing(boolean ack) {
        main.removeCallbacks(autoStop);
        if (player != null) { try { player.stop(); player.release(); } catch (Exception ignored) { } player = null; }
        try { getSystemService(Vibrator.class).cancel(); } catch (Exception ignored) { }
        getSystemService(NotificationManager.class).cancel(ID_ALARM);
        if (wake != null && wake.isHeld()) wake.release();
        wake = null;
        if (ack && !"test".equals(ringingKind)) sendCmd(this, "da");
        ringingKind = "";
        ui();
    }
    boolean isRinging() { return player != null; }

    /** Spielt über die Wecker-Lautstärke (klingelt auch bei Stumm/Vibration). */
    static MediaPlayer play(Context c, Uri u, boolean loop) throws Exception {
        MediaPlayer p = new MediaPlayer();
        try {
            p.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            p.setDataSource(c, u);
            p.setLooping(loop);
            p.prepare();
            p.start();
            return p;
        } catch (Exception e) { p.release(); throw e; }
    }

    /* ---------- Befehle an die PC-Bridge („weg“ / „da“) ---------- */
    static void sendCmd(Context c, String cmd) {
        String topic = Prefs.topic(c);
        if (topic.isEmpty()) return;
        new Thread(() -> {
            if (lanConnected) {                                   // zu Hause: direkt an den PC
                try {
                    String hp = Prefs.p(c).getString("lanHost", "");
                    HttpURLConnection h = (HttpURLConnection) new URL("http://" + hp + "/cmd?k=" + enc(topic)).openConnection();
                    h.setRequestMethod("POST"); h.setDoOutput(true); h.setConnectTimeout(3000); h.setReadTimeout(3000);
                    try (OutputStream o = h.getOutputStream()) { o.write(cmd.getBytes(StandardCharsets.UTF_8)); }
                    int code = h.getResponseCode(); h.disconnect();
                    if (code == 200) return;
                } catch (Exception ignored) { }                   // sonst über ntfy
            }
            try {
                HttpURLConnection h = (HttpURLConnection) new URL(Prefs.SERVER + "/" + enc(topic + "-cmd")).openConnection();
                h.setRequestMethod("POST"); h.setDoOutput(true); h.setConnectTimeout(10000); h.setReadTimeout(10000);
                try (OutputStream o = h.getOutputStream()) { o.write(cmd.getBytes(StandardCharsets.UTF_8)); }
                h.getResponseCode(); h.disconnect();
            } catch (Exception ignored) { }
        }).start();
    }

    /* ---------- Hilfen ---------- */
    private Notification svcNotification(String text) {
        return new Notification.Builder(this, CH_SVC)
                .setSmallIcon(R.drawable.ic_plane).setContentTitle("EFB Wächter").setContentText(text)
                .setOngoing(true).setContentIntent(openApp()).build();
    }
    private void setConnected(boolean c, String text) {
        boolean changed = connected != c; connected = c;
        getSystemService(NotificationManager.class).notify(ID_SVC, svcNotification(text));
        if (changed) ui();
    }
    private PendingIntent openApp() {
        return PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
    }
    private void ui() { Runnable r = uiListener; if (r != null) main.post(r); }
    private static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; } }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }
}

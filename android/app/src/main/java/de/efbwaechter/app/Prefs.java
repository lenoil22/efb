package de.efbwaechter.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/** Einstellungen, Alarm-Verlauf und letzter PC-Status. */
final class Prefs {
    static final String SERVER = "https://ntfy.sh";
    /** Alarmarten (Tag „efb-<kind>“ von der PC-Bridge) und Standard:
     *  0 = aus, 1 = Nachricht, 2 = Wecker nur im Weg-Modus (sonst Nachricht), 3 = immer Wecker */
    static final String[] KINDS = {"tod", "sector", "warning", "ap", "away", "caution", "pause", "test", "info"};
    static final int[] DEF = {2, 2, 2, 2, 3, 1, 1, 1, 0};
    private static final String MODE_KEY = "m2_";        // neues Schema (v0.2) – alte Einstellungen „mode_“ gelten nicht mehr

    private Prefs() {}
    static SharedPreferences p(Context c) { return c.getSharedPreferences("efb", Context.MODE_PRIVATE); }

    static String topic(Context c) { return p(c).getString("topic", ""); }
    static void topic(Context c, String t) { p(c).edit().putString("topic", t).remove("lastId").remove("status").apply(); }

    static int mode(Context c, String kind) {
        int d = 1;
        for (int i = 0; i < KINDS.length; i++) if (KINDS[i].equals(kind)) d = DEF[i];
        return p(c).getInt(MODE_KEY + kind, d);
    }
    static void mode(Context c, String kind, int m) { p(c).edit().putInt(MODE_KEY + kind, m).apply(); }

    /** Weg-Modus laut letztem Status der PC-Bridge */
    static boolean away(Context c) {
        try { return new JSONObject(status(c)).optBoolean("away", false); } catch (Exception e) { return false; }
    }

    static String lastId(Context c) { return p(c).getString("lastId", ""); }
    static void lastId(Context c, String id) { p(c).edit().putString("lastId", id).apply(); }

    static String status(Context c) { return p(c).getString("status", ""); }
    static void status(Context c, String s) { p(c).edit().putString("status", s).apply(); }

    /** true = neu eingetragen, false = schon bekannt (gleiche ntfy-ID) */
    static synchronized boolean addHistory(Context c, String id, long t, String kind, String title, String msg, int mode) {
        try {
            JSONArray a = new JSONArray(p(c).getString("hist", "[]"));
            for (int i = 0; i < a.length(); i++) if (id.equals(a.getJSONObject(i).optString("id"))) return false;
            JSONObject o = new JSONObject();
            o.put("id", id); o.put("t", t); o.put("kind", kind); o.put("title", title); o.put("msg", msg); o.put("mode", mode);
            a.put(o);
            JSONArray out = new JSONArray();
            for (int i = Math.max(0, a.length() - 60); i < a.length(); i++) out.put(a.get(i));
            p(c).edit().putString("hist", out.toString()).apply();
            return true;
        } catch (Exception e) { return false; }
    }
    static String history(Context c) { return p(c).getString("hist", "[]"); }
}

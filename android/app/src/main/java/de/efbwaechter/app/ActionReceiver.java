package de.efbwaechter.app;

import android.app.NotificationManager;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/** Knöpfe in den Benachrichtigungen: „Bin dran“ und Antworten an den Lotsen. */
public class ActionReceiver extends BroadcastReceiver {
    static final String ACK = "de.efbwaechter.app.ACK";
    static final String REPLY = "de.efbwaechter.app.REPLY";
    static final String KEY_TEXT = "text";

    @Override public void onReceive(Context c, Intent i) {
        if (REPLY.equals(i.getAction())) {
            String from = i.getStringExtra("from"), text = i.getStringExtra("text");
            Bundle r = RemoteInput.getResultsFromIntent(i);
            if (r != null && r.getCharSequence(KEY_TEXT) != null) text = r.getCharSequence(KEY_TEXT).toString();
            reply(c, from, text);
            int nid = i.getIntExtra("nid", 0);
            WatchService s = WatchService.inst;
            if (nid == WatchService.ID_ALARM && s != null) s.stopRing(false);     // geantwortet = gehört, aber nicht „am PC“
            else if (nid != 0) c.getSystemService(NotificationManager.class).cancel(nid);
            return;
        }
        WatchService s = WatchService.inst;
        if (s != null) s.stopRing(true); else WatchService.sendCmd(c, "da");
    }

    /** Privatnachricht über vPilot: Befehl „pm:<an>:<text>“ an die PC-Bridge */
    static void reply(Context c, String from, String text) {
        if (from == null || from.isEmpty() || text == null || text.trim().isEmpty()) return;
        WatchService.sendCmd(c, "pm:" + from + ":" + text.trim());
        Toast.makeText(c, "Antwort an " + from + " gesendet", Toast.LENGTH_SHORT).show();
    }
}

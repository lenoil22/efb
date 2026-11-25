package de.efbwaechter.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Knopf „Bin dran“ in der Wecker-Benachrichtigung. */
public class ActionReceiver extends BroadcastReceiver {
    static final String ACK = "de.efbwaechter.app.ACK";

    @Override public void onReceive(Context c, Intent i) {
        WatchService s = WatchService.inst;
        if (s != null) s.stopRing(true); else WatchService.sendCmd(c, "da");
    }
}

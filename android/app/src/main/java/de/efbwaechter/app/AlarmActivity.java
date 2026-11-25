package de.efbwaechter.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Vollbild-Wecker (auch auf dem Sperrbildschirm). Klingelt, bis „Bin dran“ getippt wird. */
public class AlarmActivity extends Activity {
    private TextView title, msg;
    private LinearLayout replies;
    private String from = "";

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (android.os.Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.rgb(10, 15, 22));
        int pad = dp(28);
        root.setPadding(pad, pad, pad, pad);

        TextView tag = text("EFB WÄCHTER", 13, Color.rgb(125, 142, 163), false);
        title = text("", 34, Color.rgb(255, 176, 32), true);
        msg = text("", 18, Color.rgb(233, 238, 245), false);
        Button ok = button("Bin dran", Color.rgb(63, 224, 138), Color.rgb(4, 18, 28), 24);
        ok.setOnClickListener(v -> { WatchService s = WatchService.inst; if (s != null) s.stopRing(true); finish(); });
        Button mute = button("Nur stumm schalten", Color.rgb(24, 33, 45), Color.rgb(60, 200, 255), 16);
        mute.setOnClickListener(v -> { WatchService s = WatchService.inst; if (s != null) s.stopRing(false); finish(); });

        root.addView(tag);
        root.addView(title, lp(dp(12), 0));
        root.addView(msg, lp(dp(14), 0));
        LinearLayout.LayoutParams big = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(96));
        big.topMargin = dp(48);
        root.addView(ok, big);
        LinearLayout.LayoutParams small = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        small.topMargin = dp(14);
        root.addView(mute, small);
        // Lotsen-Nachricht: gleich hier antworten (Privatnachricht über vPilot)
        replies = new LinearLayout(this);
        replies.setOrientation(LinearLayout.VERTICAL);
        TextView rt = text("ANTWORTEN", 13, Color.rgb(125, 142, 163), false);
        replies.addView(rt, lp(dp(28), dp(4)));
        for (String q : WatchService.QUICK) {
            Button r = button(q, Color.rgb(24, 33, 45), Color.rgb(233, 238, 245), 16);
            r.setOnClickListener(v -> { ActionReceiver.reply(this, from, q); WatchService s = WatchService.inst; if (s != null) s.stopRing(false); finish(); });
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
            rp.topMargin = dp(8);
            replies.addView(r, rp);
        }
        root.addView(replies);
        setContentView(root);
        show(getIntent());
    }

    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); show(i); }

    @Override protected void onResume() {
        super.onResume();
        WatchService s = WatchService.inst;
        if (s == null || !s.isRinging()) finish();      // schon quittiert (z. B. über die Benachrichtigung)
    }

    @Override public void onBackPressed() { /* Wecker nur per Knopf beenden */ }

    private void show(Intent i) {
        title.setText(i.getStringExtra("title"));
        msg.setText(i.getStringExtra("msg"));
        from = i.getStringExtra("from"); if (from == null) from = "";
        replies.setVisibility(from.isEmpty() ? android.view.View.GONE : android.view.View.VISIBLE);
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextColor(color); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }
    private Button button(String s, int bg, int fg, int sp) {
        Button b = new Button(this);
        b.setText(s); b.setTextColor(fg); b.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); b.setAllCaps(false);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable d = new GradientDrawable(); d.setColor(bg); d.setCornerRadius(dp(18));
        b.setBackground(d);
        return b;
    }
    private LinearLayout.LayoutParams lp(int top, int bottom) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.topMargin = top; p.bottomMargin = bottom; return p;
    }
    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }
}

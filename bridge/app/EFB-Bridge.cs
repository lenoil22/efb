// EFB Bridge – kleine Tray-App um bridge.mjs
// Startet die Bridge unsichtbar (Node), zeigt ein Symbol neben der Uhr, startet bei Bedarf den
// FSUIPC WebSocket Server und beendet sich, wenn MSFS zugeht (Start mit -msfs aus der EXE.xml).
// Gebaut mit dem in Windows eingebauten C#-Compiler (.NET Framework 4.x, C# 5): build.bat
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program {
    [STAThread]
    static void Main(string[] args) {
        bool fresh;
        using (var mx = new Mutex(true, "EFB-Bridge-Tray", out fresh)) {
            if (!fresh) return;                       // läuft schon
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp(args.Any(a => a.Equals("-msfs", StringComparison.OrdinalIgnoreCase))));
        }
    }
}

class TrayApp : ApplicationContext {
    readonly string dir = Path.GetDirectoryName(Application.ExecutablePath);
    readonly NotifyIcon tray = new NotifyIcon();
    readonly ToolStripMenuItem miState = new ToolStripMenuItem("Startet …") { Enabled = false };
    readonly ToolStripMenuItem miAway = new ToolStripMenuItem("Ich bin weg (Weg-Modus)");
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 5000 };
    readonly List<string> lines = new List<string>();
    readonly SynchronizationContext ui;
    readonly bool withSim;
    Process node, wsServer;
    bool quitting, simSeen, away, ws, sim, fenix;
    string topic = "";
    StatusForm form;
    DateTime started = DateTime.Now;
    string lastIconKey = "";

    const string WsExe = @"C:\FSUIPC7\Utils\FSUIPCWebSocketServer.exe";

    public TrayApp(bool msfs) {
        withSim = msfs;
        var menu = new ContextMenuStrip();          // erstes Control → installiert den UI-SynchronizationContext
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        menu.Items.Add(miState);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Status und Verlauf …", null, (s, e) => ShowForm());
        menu.Items.Add("Test-Nachricht aufs Handy", null, (s, e) => Send("t"));
        miAway.Click += (s, e) => Send(away ? "da" : "w");
        menu.Items.Add(miAway);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Handy koppeln (QR-Code) …", null, (s, e) => Pair());
        menu.Items.Add("ntfy-Kanal kopieren", null, (s, e) => { if (topic != "") { Clipboard.SetText(topic); Balloon("Kopiert", "ntfy-Kanal: " + topic); } });
        menu.Items.Add("Ordner öffnen", null, (s, e) => Process.Start("explorer.exe", "\"" + dir + "\""));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Beenden", null, (s, e) => Quit());
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (s, e) => ShowForm();
        tray.Visible = true;
        UpdateIcon();

        StartWsServer();
        StartNode();
        timer.Tick += (s, e) => Watch();
        timer.Start();
        if (!withSim) ShowForm();                     // per Doppelklick gestartet → Fenster zeigen; mit dem Sim → nur Symbol
        else Balloon("EFB Bridge läuft", "Symbol unten rechts – Rechtsklick für Menü.");
    }

    /* ---------- FSUIPC WebSocket Server mitstarten ---------- */
    void StartWsServer() {
        try {
            if (Process.GetProcessesByName("FSUIPCWebSocketServer").Length > 0) { Log("FSUIPC WebSocket Server läuft bereits."); return; }
            if (!File.Exists(WsExe)) { Log("FSUIPC WebSocket Server nicht gefunden: " + WsExe); return; }
            wsServer = Process.Start(new ProcessStartInfo(WsExe) { WorkingDirectory = Path.GetDirectoryName(WsExe), UseShellExecute = true });
            Log("FSUIPC WebSocket Server gestartet.");
        } catch (Exception ex) { Log("WebSocket Server konnte nicht starten: " + ex.Message); }
    }

    /* ---------- Node-Bridge unsichtbar starten ---------- */
    static string FindNode() {
        foreach (var p in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
            try { var f = Path.Combine(p.Trim(), "node.exe"); if (File.Exists(f)) return f; } catch { }
        }
        var pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe");
        return File.Exists(pf) ? pf : null;
    }
    void StartNode() {
        if (quitting) return;
        var exe = FindNode();
        if (exe == null) { Log("Node.js nicht gefunden – bitte von nodejs.org installieren."); SetError(); return; }
        var psi = new ProcessStartInfo(exe, "bridge.mjs") {
            WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        try {
            node = new Process { StartInfo = psi, EnableRaisingEvents = true };
            node.OutputDataReceived += (s, e) => { if (e.Data != null) ui.Post(_ => OnLine(e.Data), null); };
            node.ErrorDataReceived += (s, e) => { if (e.Data != null) ui.Post(_ => Log("Fehler: " + e.Data), null); };
            node.Exited += (s, e) => ui.Post(_ => {
                ws = sim = fenix = false; UpdateIcon();
                if (!quitting) { Log("Bridge beendet – Neustart in 5 s."); var t = new System.Windows.Forms.Timer { Interval = 5000 }; t.Tick += (a, b) => { t.Stop(); t.Dispose(); StartNode(); }; t.Start(); }
            }, null);
            node.Start(); node.BeginOutputReadLine(); node.BeginErrorReadLine();
        } catch (Exception ex) { Log("Bridge konnte nicht starten: " + ex.Message); SetError(); }
    }
    void Send(string cmd) {
        try { if (node != null && !node.HasExited) { node.StandardInput.WriteLine(cmd); node.StandardInput.Flush(); } } catch { }
    }

    /* ---------- Ausgabe der Bridge ---------- */
    void OnLine(string l) {
        if (l.StartsWith("@status ")) {
            var j = l.Substring(8);
            ws = J(j, "ws"); sim = J(j, "sim"); fenix = J(j, "fenix"); away = J(j, "away");
            var t = JS(j, "topic"); if (t != null) topic = t;
            UpdateIcon(); return;
        }
        Log(l);
        if (l.Contains("→ Handy: ") && !l.Contains("Test") ) {
            var title = l.Substring(l.IndexOf("→ Handy: ") + 9);
            if (title.Contains("WARNING") || title.Contains("Autopilot") || title.Contains("Caution")) Balloon("Ans Handy geschickt", title);
        }
    }
    static bool J(string j, string k) { return j.Contains("\"" + k + "\":true"); }
    static string JS(string j, string k) {
        var key = "\"" + k + "\":\""; int i = j.IndexOf(key); if (i < 0) return null; i += key.Length;
        int e = j.IndexOf('"', i); return e < 0 ? null : j.Substring(i, e - i);
    }
    void Log(string l) {
        var line = l.Length > 9 && l[2] == ':' && l[5] == ':' ? l : DateTime.Now.ToString("HH:mm:ss") + " " + l;
        lines.Add(line); if (lines.Count > 600) lines.RemoveRange(0, lines.Count - 500);
        try { File.AppendAllText(Path.Combine(dir, "bridge.log"), line + Environment.NewLine, Encoding.UTF8); } catch { }
        if (form != null && !form.IsDisposed) form.Append(line);
    }

    /* ---------- MSFS beobachten: mit -msfs gestartet → beenden, wenn der Sim zugeht ---------- */
    void Watch() {
        if (!withSim) return;
        bool running = Process.GetProcessesByName("FlightSimulator2024").Length > 0 || Process.GetProcessesByName("FlightSimulator").Length > 0;
        if (running) simSeen = true;
        else if (simSeen || DateTime.Now - started > TimeSpan.FromMinutes(10)) { Log("MSFS beendet – EFB Bridge beendet sich."); Quit(); }
    }

    /* ---------- Symbol ---------- */
    void SetError() { lastIconKey = ""; DrawIcon(Color.FromArgb(255, 90, 90), "Fehler – Rechtsklick → Status"); }
    void UpdateIcon() {
        string text; Color c;
        if (away) { c = Color.FromArgb(255, 176, 32); text = "Weg-Modus an"; }
        else if (sim && fenix) { c = Color.FromArgb(63, 224, 138); text = "Verbunden – Fenix wird überwacht"; }
        else if (sim) { c = Color.FromArgb(63, 224, 138); text = "Sim verbunden – Fenix noch nicht geladen"; }
        else if (ws) { c = Color.FromArgb(60, 200, 255); text = "Warte auf den Sim"; }
        else { c = Color.FromArgb(125, 142, 163); text = "Warte auf FSUIPC WebSocket Server"; }
        miState.Text = text;
        miAway.Text = away ? "Bin zurück (Weg-Modus aus)" : "Ich bin weg (Weg-Modus)";
        DrawIcon(c, text);
        if (form != null && !form.IsDisposed) form.SetState(text, topic);
    }
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    void DrawIcon(Color c, string text) {
        var key = c.ToArgb() + text; if (key == lastIconKey) return; lastIconKey = key;
        using (var bmp = new Bitmap(32, 32)) {
            using (var g = Graphics.FromImage(bmp)) {
                g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Color.Transparent);
                using (var bg = new SolidBrush(Color.FromArgb(17, 24, 33))) g.FillEllipse(bg, 1, 1, 30, 30);
                using (var p = new Pen(c, 3.2f)) g.DrawEllipse(p, 2.5f, 2.5f, 27, 27);
                // kleines Flugzeug
                using (var b = new SolidBrush(c)) {
                    g.FillPolygon(b, new[] { new PointF(16, 6), new PointF(18, 13), new PointF(26, 17), new PointF(26, 19), new PointF(18, 17), new PointF(17.5f, 23), new PointF(20, 25), new PointF(20, 26.5f), new PointF(16, 25.5f), new PointF(12, 26.5f), new PointF(12, 25), new PointF(14.5f, 23), new PointF(14, 17), new PointF(6, 19), new PointF(6, 17), new PointF(14, 13) });
                }
            }
            var h = bmp.GetHicon();
            var old = tray.Icon;
            tray.Icon = (Icon)Icon.FromHandle(h).Clone();
            DestroyIcon(h);
            if (old != null) old.Dispose();
        }
        tray.Text = ("EFB Bridge – " + text).Length > 63 ? ("EFB Bridge – " + text).Substring(0, 63) : "EFB Bridge – " + text;
    }
    void Balloon(string title, string text) { tray.BalloonTipTitle = title; tray.BalloonTipText = text; tray.ShowBalloonTip(4000); }

    void ShowForm() {
        if (form == null || form.IsDisposed) {
            form = new StatusForm(this);
            foreach (var l in lines) form.Append(l);
            form.SetState(miState.Text, topic);
        }
        form.Show(); form.WindowState = FormWindowState.Normal; form.Activate();
    }
    public void Command(string c) { Send(c); }
    /* QR-Code für die Handy-App „EFB Wächter“ im Browser zeigen (Kanal nur hinter #, geht an keinen Server) */
    public void Pair() {
        if (topic == "") { Balloon("Noch kein Kanal", "Die Bridge startet noch – gleich nochmal versuchen."); return; }
        try { Process.Start("https://lenoil22.github.io/efb/koppeln.html#" + topic); } catch (Exception ex) { Log("Browser konnte nicht öffnen: " + ex.Message); }
    }

    void Quit() {
        if (quitting) return; quitting = true; timer.Stop();
        try { if (node != null && !node.HasExited) { Send("q"); if (!node.WaitForExit(2000)) node.Kill(); } } catch { }
        try { if (wsServer != null && !wsServer.HasExited) wsServer.CloseMainWindow(); } catch { }
        tray.Visible = false; tray.Dispose();
        if (form != null && !form.IsDisposed) form.Close();
        ExitThread();
    }
}

/* ---------- kleines Fenster: Zustand, ntfy-Kanal, Verlauf ---------- */
class StatusForm : Form {
    readonly TextBox log = new TextBox();
    readonly Label state = new Label(), chan = new Label();
    public StatusForm(TrayApp app) {
        Text = "EFB Bridge"; Width = 720; Height = 460; StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(10, 15, 22); ForeColor = Color.FromArgb(233, 238, 245); Font = new Font("Segoe UI", 10f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        state.SetBounds(14, 10, 680, 26); state.Font = new Font("Segoe UI Semibold", 12f);
        chan.SetBounds(14, 38, 520, 22); chan.ForeColor = Color.FromArgb(125, 142, 163);
        var copy = Btn("Kanal kopieren", 540, 34, (s, e) => { if (chan.Tag is string && (string)chan.Tag != "") Clipboard.SetText((string)chan.Tag); });
        var test = Btn("Test-Nachricht", 14, 70, (s, e) => app.Command("t"));
        var away = Btn("Ich bin weg", 154, 70, (s, e) => app.Command("w"));
        var back = Btn("Bin zurück", 294, 70, (s, e) => app.Command("d"));
        var stat = Btn("Handy koppeln", 434, 70, (s, e) => app.Pair());
        log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical; log.WordWrap = true;
        log.BackColor = Color.FromArgb(17, 24, 33); log.ForeColor = Color.FromArgb(200, 210, 222); log.BorderStyle = BorderStyle.None;
        log.Font = new Font("Consolas", 9.5f);
        log.SetBounds(14, 112, 676, 296); log.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        Controls.AddRange(new Control[] { state, chan, copy, test, away, back, stat, log });
        FormClosing += (s, e) => { if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
    }
    Button Btn(string t, int x, int y, EventHandler h) {
        var b = new Button { Text = t, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(24, 33, 45), ForeColor = Color.FromArgb(60, 200, 255) };
        b.FlatAppearance.BorderColor = Color.FromArgb(29, 40, 54); b.SetBounds(x, y, 132, 32); b.Click += h; return b;
    }
    public void Append(string l) { log.AppendText(l + Environment.NewLine); }
    public void SetState(string s, string topic) { state.Text = s; chan.Text = topic == "" ? "ntfy-Kanal: –" : "ntfy-Kanal: " + topic; chan.Tag = topic; }
}

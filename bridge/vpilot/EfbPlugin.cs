// EFB Wächter – vPilot-Plugin
// Meldet Lotsen-Nachrichten, SELCAL, Verbindung und ATIS/METAR an die EFB Bridge (gleicher PC, http://127.0.0.1:8790)
// und führt Befehle vom Handy aus (IDENT, Antwort per Privatnachricht, ATIS/METAR abfragen).
// C# 5 / .NET Framework 4.x, gebaut mit build.bat (Windows-eigenes csc.exe). Keine fremden Bibliotheken.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using RossCarlson.Vatsim.Vpilot.Plugins;
using RossCarlson.Vatsim.Vpilot.Plugins.Events;
using RossCarlson.Vatsim.Vpilot.Plugins.Exceptions;

namespace EfbWaechter
{
    public class EfbPlugin : IPlugin
    {
        IBroker b;
        string url = "http://127.0.0.1:8790";
        SynchronizationContext ui;
        Timer poll;
        int busy, fails;

        public string Name { get { return "EFB Waechter"; } }

        public void Initialize(IBroker broker)
        {
            b = broker;
            ui = SynchronizationContext.Current;
            try
            {
                // optional: EFB-Plugin.ini neben der DLL, Zeile url=http://127.0.0.1:8790
                string ini = Path.Combine(Path.GetDirectoryName(typeof(EfbPlugin).Assembly.Location), "EFB-Plugin.ini");
                if (File.Exists(ini))
                    foreach (string l in File.ReadAllLines(ini))
                        if (l.Trim().StartsWith("url=")) url = l.Trim().Substring(4).Trim().TrimEnd('/');
            }
            catch { }

            b.NetworkConnected += (s, e) => Post("{\"type\":\"connected\",\"callsign\":" + J(e.Callsign) + "}");
            b.NetworkDisconnected += (s, e) => Post("{\"type\":\"disconnected\"}");
            b.SessionEnded += (s, e) => Post("{\"type\":\"ended\"}");
            b.PrivateMessageReceived += (s, e) => Post("{\"type\":\"pm\",\"from\":" + J(e.From) + ",\"message\":" + J(e.Message) + "}");
            b.RadioMessageReceived += (s, e) => Post("{\"type\":\"radio\",\"from\":" + J(e.From) + ",\"message\":" + J(e.Message) + "}");
            b.SelcalAlertReceived += (s, e) => Post("{\"type\":\"selcal\",\"from\":" + J(e.From) + "}");
            b.MetarReceived += (s, e) => Post("{\"type\":\"metar\",\"metar\":" + J(e.Metar) + "}");
            b.AtisReceived += (s, e) =>
            {
                var sb = new StringBuilder();
                if (e.Lines != null) foreach (string l in e.Lines) { if (sb.Length > 0) sb.Append(','); sb.Append(J(l)); }
                Post("{\"type\":\"atis\",\"from\":" + J(e.From) + ",\"lines\":[" + sb + "]}");
            };

            poll = new Timer(Poll, null, 2000, 1000);
            b.PostDebugMessage("EFB Waechter: Plugin geladen (" + url + ")");
        }

        /* Ereignis an die Bridge – im Hintergrund, damit vPilot nie wartet */
        void Post(string json)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    using (var w = new WebClient())
                    {
                        w.Encoding = Encoding.UTF8;
                        w.Headers[HttpRequestHeader.ContentType] = "application/json; charset=utf-8";
                        w.UploadString(url + "/vpilot", json);
                    }
                }
                catch { }
            });
        }

        /* Jede Sekunde Befehle vom Handy abholen (das zeigt der Bridge auch, dass das Plugin läuft) */
        void Poll(object _)
        {
            if (Interlocked.Exchange(ref busy, 1) == 1) return;
            try
            {
                string s;
                using (var w = new WebClient()) { w.Encoding = Encoding.UTF8; s = w.DownloadString(url + "/vpilot/cmds"); }
                fails = 0;
                var list = new JavaScriptSerializer().DeserializeObject(s) as object[];
                if (list == null) return;
                foreach (object o in list)
                {
                    var c = o as IDictionary<string, object>;
                    if (c == null) continue;
                    if (ui != null) ui.Post(x => Exec((IDictionary<string, object>)x), c); else Exec(c);
                }
            }
            catch { fails++; }
            finally { Interlocked.Exchange(ref busy, 0); }
        }

        static string Str(IDictionary<string, object> c, string k)
        {
            object v; return c.TryGetValue(k, out v) && v != null ? v.ToString() : "";
        }

        void Exec(IDictionary<string, object> c)
        {
            string cmd = Str(c, "cmd");
            try
            {
                if (cmd == "ident") { b.SquawkIdent(); Post("{\"type\":\"done\",\"cmd\":\"ident\"}"); }
                else if (cmd == "pm" && Str(c, "to") != "" && Str(c, "text") != "")
                {
                    b.SendPrivateMessage(Str(c, "to"), Str(c, "text"));
                    Post("{\"type\":\"done\",\"cmd\":\"pm\",\"to\":" + J(Str(c, "to")) + ",\"text\":" + J(Str(c, "text")) + "}");
                }
                else if (cmd == "atis" && Str(c, "station") != "") b.RequestAtis(Str(c, "station"));
                else if (cmd == "metar" && Str(c, "station") != "") b.RequestMetar(Str(c, "station"));
            }
            catch (NotConnectedException) { Post("{\"type\":\"error\",\"cmd\":" + J(cmd) + ",\"message\":\"vPilot ist nicht mit VATSIM verbunden.\"}"); }
            catch (Exception ex) { Post("{\"type\":\"error\",\"cmd\":" + J(cmd) + ",\"message\":" + J(ex.Message) + "}"); }
        }

        static string J(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder("\"");
            foreach (char ch in s)
            {
                if (ch == '"') sb.Append("\\\"");
                else if (ch == '\\') sb.Append("\\\\");
                else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }
    }
}

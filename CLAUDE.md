# EFB · Bordcomputer – Projektkontext für Claude

Sprache mit dem Nutzer: **Deutsch**. UI-Texte Deutsch, Funk-Phraseologie und Callouts Englisch (ICAO/Airbus).

## Wer / wofür
- Nutzer fliegt **MSFS** mit dem **Fenix A320** auf **VATSIM**, ist erfahren (war selbst VATSIM-Lotse).
- Er sitzt links: **Captain + Pilot Flying** (Rolle ist in den Einstellungen umstellbar).
- Er hat **Navigraph** (Charts/Karten) und **SimBrief**. Deshalb gibt es in der App bewusst **keine Karte** mehr.
- Die App läuft im Browser auf dem **iPad** neben dem Sim. Kernzwecke:
  1. **Funk** – Leitfaden, kein starres Skript: Wen rufe ich jetzt (VATSIM live), was sage ich, was lese ich zurück.
  2. **Checklisten** – echte Lufthansa A320 Normal Checklist; optional „Leitfaden“ mit kompletten Airbus-Procedures inkl. **PF/PM-Dialogen und FMA-Callouts**.
  3. Crew-Dialoge zwischen PF und PM, realistisch wie in echt.
- Design-Wunsch: **minimalistisch**, klare Hierarchie (nicht alles gleich groß), dunkel, gut lesbar im Cockpit. Eine Phase = eine Liste (ITEM ……… ACTION), **ein „Weiter“-Knopf** zur nächsten Phase, kein Einzelklicken pro Punkt.
- Tippen während des Flugs vermeiden → Chips/Auswahl statt Textfelder.

## Aktueller Stand
- Eine Datei: `index.html` (HTML + CSS + JS, kein Build). Repo `lenoil22/efb`, live über **GitHub Pages**: https://lenoil22.github.io/efb/
- Tabs: **Flug** (SimBrief-Import + Felder), **Funk**, **Checklisten**, **Wetter & Lotsen**. Einstellungen über Zahnrad oben rechts.
- Zustand in `localStorage` unter `efb.v1` (Objekt `S`: user, f=Flug, phase, mem=gemerkte SIDs je Platz, ck, tab, req, sp, set=Einstellungen, g, x=durchgestrichene Zeilen).

### Datenquellen (alle CORS-tauglich von github.io)
- SimBrief: `https://www.simbrief.com/api/xml.fetcher.php?json=1&username=<name>`
- VATSIM: `https://data.vatsim.net/v3/vatsim-data.json` (alle 60 s; Lotsen mit facility>0, freq≠199.998)
- METAR: `https://metar.vatsim.net/<ICAO>` (alle 10 min). aviationweather.gov geht wegen CORS **nicht**.

### Wichtige Teile in index.html
- `CHAIN` / Abdeckungslogik: top-down DEL→GND→TWR→DEP/APP→CTR („wer deckt wen ab“).
- Sektoren (A4): VATSpy Data Project (`VATSpy.dat` + `Boundaries.geojson`, CC BY-SA 4.0) wird zur Laufzeit von raw.githubusercontent.com geladen und 7 Tage im Cache gehalten (`loadSectors`). `ctlSec()` ordnet Rufzeichen Sektoren zu (Sektor-Präfix → FIR → UIR), `covers()` = Lotsen über einem Punkt (FIS ausgeschlossen), `ctrInfo()` = aktueller Center + „Danach“ entlang der SimBrief-Wegpunkte. `S.ctrPick` = von Hand gewählt, gilt bis Sektorwechsel oder offline. Mehrere Zuständige (z. B. Low/High) werden **alle** gezeigt, nicht geraten.
- ATIS-Parser: Buchstabe, aktive Pisten (Array, parallele Pisten), QNH → Warnung, wenn geplante Piste nicht aktiv.
- Aussprache-Helfer: NATO-Alphabet, tree/fife/niner, Airline-Callsigns (`AIRL`), Städtenamen (`CITY`), `sidSp`.
- `phrase()` / `renderFunk()` / `clrBlock()`: Funk-Tab. Werte als `<span class="vok|vmiss" data-e="key">` (grün = bekannt, orange = fehlt → antippen zum Eintragen).
- `CK`: Lufthansa-Checkliste, Einträge `[ITEM, ACTION]`, `'LINE'` = „down to the line“. `ev` = Emergency.
- `FLOWS`: Procedures, 28 Phasen (prelim, walk*, ovhd, ped, glare, brief, bpush, startclr, eng, after, taxi, lineup, tko, atko, ta, climb10, cruise, dprep, tod, desc10, tl, iapp, final, land, ga*, alnd, park, secure*; * = optional).
  Mini-DSL pro Zeile:
  - `ROLLE|ITEM|SETTING|Notiz` – Rolle PF, PM, CM (beide), BOTH
  - `@ROLLE|Callout|Notiz` – gesprochener Satz (eigene Rolle wird hervorgehoben)
  - `#ckid:down|below|all` – fügt Checkliste (Teil) ein
  - `!funkphase:Anfrage|Label` – Funk-Kasten „wen jetzt rufen“ (Station + Live-Frequenz von VATSIM, sonst Unicom), Tipp öffnet den Funk-Tab. Steht an **jedem** Punkt, an dem man ATC anspricht oder übergeben wird (Delivery, Startup/Pushback, Taxi, Tower, Departure, Center, Sinkflug, Approach, Anflugfreigabe, Established, Tower, Ground, Taxi to stand)
  - `~` am Anfang = nur bei Detail „Voll“
  - `^` (nach `~`) = nur Realismus: im Sim schon so (Cold & Dark) oder reine Kontrolle → grau (Einstellung: Grau/Normal/Ausblenden). Nie für Hebel/Schalter, die man an Hardware zurückstellen muss (Gear, Thrust, ENG MASTER/MODE, Parking Brake, Flaps, Speedbrake, Rudder Trim, FCU/EFIS), und nicht für T.O/LDG MEMO und 3 GREEN.
  - Platzhalter `{flex}`, `{ta}`, `{tl}`, `{tod}`, `{qnhArr}` … werden aus dem Flug gefüllt.
- Quellen der Procedures: FlyByWire A32NX SOP, TheAirlinePilots „A320 Normal Procedures“ (Apr 2025), JayDee's Fenix Guide v1.31.1. Bei Änderungen gegen echte Airbus-SOP prüfen – **nichts auslassen**.

## PC-Bridge (Teil B) – `bridge/`
- **Tray-App `EFB-Bridge.exe`** (Quelle `bridge/app/EFB-Bridge.cs`, C# 5 / .NET Framework 4.x, gebaut mit dem Windows-eigenen `csc.exe` über `bridge/app/build.bat`; exe + ico sind gitignored). Startet `bridge.mjs` unsichtbar (stdin = Befehle `w`/`d`/`t`/`s`/`q` zeilenweise, stdout = Verlauf + `@status {json}`), startet bei Bedarf `FSUIPCWebSocketServer.exe` mit, Symbol neben der Uhr (grau/blau/grün/amber/rot), Statusfenster, `bridge.log`. Mit `-msfs` (Eintrag „EFB Bridge“ in der MSFS-EXE.xml) beendet sie sich, wenn MSFS zugeht. `start.bat` bleibt als Konsolen-Variante.
- `bridge.mjs` (Node ≥ 22, **keine npm-Pakete**). Läuft auf dem Sim-PC des Nutzers (Windows, MSFS 2024, Fenix, FSUIPC7 **unregistriert** → keine Lua-Skripte).
- Daten: **FSUIPC WebSocket Server** (`C:\FSUIPC7\Utils\FSUIPCWebSocketServer.exe`, v1.1.4), `ws://localhost:2048/fsuipc/`, Subprotokoll `fsuipc`. Offsets: 0x0560/0x0568 (lat/lon), 0x0570 (Höhe, int 8), 0x02B4 (GS), 0x0366 (am Boden), 0x0264 (Pause). L-Vars über `vars.list` → `pickLvars()` (bevorzugt `I_MIP_MASTER_WARNING_CAPT`, `I_MIP_MASTER_CAUTION_CAPT`, `I_FCU_AP1/2`, sonst per Muster). Die echten Namen beim ersten Lauf in `lvars-gefunden.txt` prüfen.
- Push über **ntfy** (`https://ntfy.sh`): geheimer Kanal in `bridge/config.json` (gitignored, wird beim ersten Start erzeugt). Befehle vom Handy über Kanal `<topic>-cmd` („weg“/„da“, Knopf „Bin zurück“).
- Alarme: Master Warning (prio 5), Master Caution (4), AP aus in der Luft (5), Pause in der Luft > 10 s (4), TOD in ≤ 5 min (SimBrief-Fix „TOD“), Weg-Modus 25 min (5). Alarm-Logik in `makeMonitor()` ohne Netz → testbar.

## Handy-App „EFB Wächter“ (Teil B) – `android/` + `handy/`
- Android-App (Java, **ohne AndroidX/Bibliotheken**, minSdk 26, compileSdk 36, AGP 8.13.0 per `buildscript`). Bauen: `JAVA_HOME=…\Android Studio\jbr`, `android\gradlew.bat assembleDebug` → `android\EFB-Waechter.apk` (gitignored, Debug-signiert, zum Selbst-Installieren).
- `WatchService`: Vordergrunddienst (`specialUse`), ntfy-JSON-Stream auf `<topic>,<topic>-status`, Wiederaufnahme per `since=<lastId>`; alte Meldungen (> 2 min) nur in den Verlauf. Pro Alarmart (Tag `efb-<kind>`: tod, warning, ap, away, caution, pause, test, info) Modus 0 aus / 1 Nachricht / 2 **Wecker**: MediaPlayer mit `USAGE_ALARM` in Dauerschleife, Vibration, Full-Screen-Intent → `AlarmActivity` (auch auf dem Sperrbildschirm), „Bin dran“ schickt `da` an `<topic>-cmd`, Auto-Stopp nach 5 min.
- Oberfläche = **`handy/index.html`** (GitHub Pages) in einer WebView, Schnittstelle `window.EFBApp` (state, setMode, send, testAlarm, setTopic, openFsi/openBattery/openNotif), die App ruft `efbUpdate()` bei Änderungen. Im normalen Browser läuft die Seite eingeschränkt (Status per SSE, Weg/Zurück per POST, Kanal hinter `#`).
- Koppeln: `koppeln.html#<topic>` zeigt einen QR-Code `efbwaechter://pair?topic=…` (qrcodejs 1.0.0 von cdnjs). Die Tray-App öffnet ihn über „Handy koppeln“.
- Bridge-Status für die App: `<topic>-status` nur bei Änderung (3 s gesammelt), weil ntfy.sh **250 Nachrichten/Tag** erlaubt. Enthält `sb` (SimBrief-Name).
- **Flugdaten (Schritt 2)** im zweiten `<script>` von `handy/index.html`: SimBrief-OFP (Callsign, Route, TOD-Fix) + VATSIM-Feed alle 15 s + VATSpy-Sektoren, kompakte Kopie der A3/A4-Logik aus `index.html` (bei Änderungen dort beide Stellen anpassen). Zeigt Höhe, GS, V/S, Phase, **TOD und ETA groß als „in X min“, klein Uhrzeit (lokal + z) und NM** (Wunsch des Nutzers), gerechnet **entlang der Route** (SimBrief-Abschnittslängen aufsummiert; Luftlinie zum TOD-Fix täuscht, wenn die STAR eine Schleife fliegt – die Bridge nutzt für ihren TOD-Alarm noch die Luftlinie, die ist kürzer, der Alarm kommt also eher zu früh als zu spät), aktuellen und nächsten Center (mit Entfernung entlang der Route) und die Lotsen + ATIS am Ziel.
- **WLAN direkt (v0.3):** Die Bridge (`makeLan`) startet einen HTTP-Server auf `0.0.0.0:8790` (`GET /events?k=<topic>` = Server-Sent Events `alarm`/`status`/`live` jede Sekunde, `POST /cmd?k=<topic>`) und sendet alle 2 s einen UDP-Rundruf an Port 8791 (`{efb:1,id:sha256(topic)[0..12],port}`). Die App (`WatchService.lanLoop`) findet den PC darüber, verbindet sich und fällt sonst auf ntfy zurück. **Jeder Alarm geht über beide Wege mit derselben `aid`** (ntfy-Tag `aid-…`), die App klingelt nur einmal. Befehle gehen zu Hause per WLAN, sonst per ntfy. Live-Daten (inkl. V/S aus Offset 0x02C8) gehen nur über WLAN, im Handy-UI als „live vom PC“ bevorzugt vor VATSIM. Windows fragt beim ersten Start nach der Firewall-Freigabe für node.exe, Android 17 nach „Geräte im lokalen Netzwerk“ (`ACCESS_LOCAL_NETWORK`).
- **Alarm-Modi (App v0.2, Prefs-Schlüssel `m2_`):** 0 aus · 1 Nachricht · **2 Wecker nur im Weg-Modus, sonst Nachricht** (Standard für TOD, Sektor, Warning, AP – Nutzer: am PC hört man es selbst) · 3 immer Wecker (Standard für „Weg-Modus abgelaufen“).
- **„Neuer Lotse voraus“ (Bridge, kind `sector`):** `makeSectors()` (VATSpy, Cache `bridge/vatspy-cache/`) + Online-Lotsen alle 60 s + SimBrief-Route; alle 30 s: nächster anderer Center entlang der Route, Meldung `sectorLeadMin` (5) Minuten vorher, einmal pro Rufzeichen. Kommt ein Lotse online, der schon zuständig ist → „Jetzt zuständig“.
- Master Warning wird erst nach 3 s gemeldet und nicht, wenn sie vom AP-Disconnect kommt (±6 s) – dann nur „Autopilot aus“.

## Feature-Paket (App v0.4)
- **Weitere Offsets** (Lesen alle 500 ms): 0x02C8 V/S, **0x030C Aufsetzrate** (vom Sim festgehalten), **0x11BA G-Last** (/624), **0x126C Sprit in lbs**. Pause **schreiben** über 0x0262 (`sim.pause(on)`). Alles noch nicht am echten Sim geprüft.
- **Neue Alarmarten** (Tag `efb-<kind>`, App-Standard in Klammern): `crash` – in der Luft 20 s keine Sim-Daten (2) · `vatsim` – vPilot getrennt/beendet, nur in der Luft (2) · `contact` – Privatnachricht, SELCAL, Funk-Text mit eigenem Rufzeichen (2) · `fuel` – unter SimBrief-Plan am zuletzt überflogenen Wegpunkt, Toleranz max(500 kg, 8 %), höchstens alle 30 min (2) · `landing` – Aufsetzrate + G + Flugzeit (1) · `atis` – neue ATIS am Ziel (Buchstabe/Piste/QNH, VATSIM alle 60 s) und Antworten/Rückmeldungen von vPilot (1).
- **Logbuch** `makeLogbook()` → `bridge/logbook.json` (gitignored, max. 200): Off-Block (rollt > 3 kt), Start, Landung (fpm, max. G in 3,5 s, Hüpfer), On-Block (30 s Stillstand). Bewertung `grade()`: < 100 butterweich, < 240 gut, < 400 fest, sonst hart. Geht per WLAN (SSE `logbook`, `GET /logbook`) an die App, die es speichert.
- **Fernsteuerung** (`handleCmd`, Befehle per WLAN `/cmd` oder ntfy `-cmd`, Groß-/Kleinschreibung bleibt erhalten): `weg`/`da`, `pause`/`resume`, `ident`, `pm:<an>:<text>`, `atis:<ICAO>`, `metar:<ICAO>`. Die App lässt nur diese Muster durch (`MainActivity.send`).
- **vPilot-Plugin** `bridge/vpilot/EfbPlugin.cs` (C# 5, .NET 4.x, `build.bat` baut mit `csc.exe` und kopiert nach `%LOCALAPPDATA%\vPilot\Plugins`; vPilot vorher schließen). Meldet Ereignisse per `POST /vpilot` an die Bridge (127.0.0.1:8790, vom selben PC ohne Schlüssel) und holt jede Sekunde `GET /vpilot/cmds` ab (→ SquawkIdent, SendPrivateMessage, RequestAtis/Metar). Optional `EFB-Plugin.ini` (`url=`) neben der DLL. Getestet mit nachgebautem vPilot-Broker, noch nicht im echten vPilot.
- **App**: Lotsen-Nachricht mit „Antworten“ direkt in der Benachrichtigung (RemoteInput) + Schnell-Antworten (Roger, Back at the controls in 2 min), auch im Vollbild-Wecker. Live-Status-Benachrichtigung (Kanal `live`, nur in der Luft und mit WLAN-Live-Daten): „TOD in X min“, Höhe, GS, TOD-/ETA-Uhrzeit; ab Android 16 als Live-Update (`setRequestPromotedOngoing` per Reflection). Abschaltbar unter Alarme → Sperrbildschirm.
- **Weckerton (App v0.5)**: eingebaute Töne `res/raw/efb_gong|glocke|piepser|dringend.wav`, selbst erzeugt mit `android/tools/make-sounds.mjs` (keine fremden Aufnahmen). Prefs `snd_*` = für alle (leer = Gong), `snd_<kind>`: leer = Standard (warning/crash/vatsim/ap → Dringend, sonst wie alle), `inherit` = wie alle, sonst URI. Auswahl in der Handy-Seite (Alarme → Weckerton, pro Alarm in dessen Aufklapper bei Wecker-Modus): eingebaute Töne, „Ton vom Handy“ (RingtoneManager-Picker), „Eigene Datei“ (ACTION_OPEN_DOCUMENT, dauerhafte Leseberechtigung). Antippen spielt 6 s Probe. Fällt die Datei weg → Gong → Handy-Weckton.
- **Handy-Seite**: Tab **Flüge** (Logbuch mit Übersicht, aufklappbar), Karte **Steuern** im Flug-Tab (Sim pausieren/weiter, IDENT, ATIS/METAR Ziel), Verlauf zeigt den Nachrichtentext und bei Lotsen-Nachrichten „Antworten“ (Blatt mit Schnell-Antworten + eigenem Text).

## Deploy
Push auf `main` → GitHub Pages baut neu (~1 min). Danach im Browser mit `?v=<n>` testen (Cache).
Vor jedem Push: JS-Syntax prüfen (Script extrahieren, `node --check`) und im iPad-Format (768×1024) ansehen.

## Regeln
- Keine Passwörter/Tokens in den Code. Repo ist **öffentlich**.
- Die PDFs des Nutzers (VATSIM-Phraseologie, Fenix-Guide) **nicht** ins Repo committen – nur lokal als Quelle nutzen.
- Größere Umbauten erst kurz mit dem Nutzer abstimmen (eine Frage nach der anderen), kleine Fixes einfach machen.

Fahrplan: siehe `ROADMAP.md`.

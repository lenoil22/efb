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
- **Flugdaten (Schritt 2)** im zweiten `<script>` von `handy/index.html`: SimBrief-OFP (Callsign, Route, TOD-Fix) + VATSIM-Feed alle 15 s + VATSpy-Sektoren, kompakte Kopie der A3/A4-Logik aus `index.html` (bei Änderungen dort beide Stellen anpassen). Zeigt Höhe, GS, V/S, Phase, Restdistanz/ETA, TOD in X min, aktuellen und nächsten Center (mit Entfernung entlang der Route) und die Lotsen + ATIS am Ziel.
- Master Warning wird erst nach 3 s gemeldet und nicht, wenn sie vom AP-Disconnect kommt (±6 s) – dann nur „Autopilot aus“.

## Deploy
Push auf `main` → GitHub Pages baut neu (~1 min). Danach im Browser mit `?v=<n>` testen (Cache).
Vor jedem Push: JS-Syntax prüfen (Script extrahieren, `node --check`) und im iPad-Format (768×1024) ansehen.

## Regeln
- Keine Passwörter/Tokens in den Code. Repo ist **öffentlich**.
- Die PDFs des Nutzers (VATSIM-Phraseologie, Fenix-Guide) **nicht** ins Repo committen – nur lokal als Quelle nutzen.
- Größere Umbauten erst kurz mit dem Nutzer abstimmen (eine Frage nach der anderen), kleine Fixes einfach machen.

Fahrplan: siehe `ROADMAP.md`.

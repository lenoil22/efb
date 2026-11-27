# Plan: Anflug-Monitor (Energy-Management & Descent)

**Ziel:** In der Handy-App „EFB Wächter“ öffnet sich ab dem Sinkflug ein Vollbild-Monitor, der live zeigt, ob man zu hoch/zu schnell ist, und genau eine nächste Aktion nennt, damit das 1000-ft-Stabilized-Gate klappt.

## Stand (2026-11-27)
- ✅ Schritt 1–5: Rohwerte (Gruppe `anf` → `anflug-werte.txt`), `makeRunways` + `pickRunway`, `arrRwy`/`arrPos` aus SimBrief, `makeEnergy` (+ `approachDist`, `speedTarget`, `vappEstimate`), Tests `test-anf`, `test-rwy`, `test-energy` grün, alte Tests grün.
- ✅ Schritt 9 vorgezogen: `../efb-design/anflug-vorschau.html` + `anflug-daten.js` (erzeugt aus der echten Rechnung). Zoom jetzt nach Distanz (15 / 30 / 60 NM), unter dem Gate ist das Gate-Ergebnis die Hauptanzeige.
- ✅ Neues Design (Glass-Cockpit, vom Nutzer abgenommen per Mockup `efb-design/anflug-mockup.html`): Ampel-Korridor (nur Höhe; Leuchten von Flugzeug und Rand = Gesamtzustand), geflogene Spur, Vorhersage bis Schwelle/Boden, A320-Seitensymbol im Sinkwinkel, Bahn + Boden, GATE-Fähnchen, Pillen F1–FULL (fällig = 3× Puls), Rand leuchtet in Statusfarbe (0,6 s Übergang), Aktionskarte mit Icon + Aufleuchten + Abhaken, Ton gleichzeitig. Bahn/Vapp-Knöpfe entfernt: Bahn = Tipp auf „EDDF 25L“, Vapp = Tipp auf IAS. Ab dem Gate gelten Gate-Grenzen für die Farben (V/S max −1000, Gear, Klappen 3/FULL). Geprüft bei 360 und 412 px: 16 Situationen + 202 Anflug-Frames ohne Abschneiden/Überlappen.
- ✅ Schritt 6–8 eingebaut: Bridge (`anfConvert`, `energy()` im Live-Takt, `lanAlarm`, `rwy:`/`vapp:`), App v0.6 (Alarmart `energy`, Ton, `keepAwake`, Befehle), Handy-Seite (`#mon`). Tests `test-wire` + Schwellen-Fix (über der Bahn sprang die Distanz auf 8 NM „Vectors“). Handy-Seite mit nachgebauter App geprüft: Auto-Öffnen/Schließen, ×, Knopf, Bahn/Vapp, keine Live-Daten, 360/412 px. APK 0.6 installiert. **Nicht gepusht** (die App lädt die Seite von GitHub Pages), Bridge nicht neu gestartet.
- ⏳ Offen: Schritt 10 (Sim-Test)

## Abgestimmt (2026-11-27)
- Öffnet **automatisch ab Sinkflug**, schließt 30 s nach dem Aufsetzen. „×“ = bis zum nächsten Flug zu. Knopf „Anflug-Monitor“ im Flug-Tab.
- Ansicht: **Seitenprofil oben + große Zahl** (Zustand, Abweichung ft/kt, eine Aktion), kleine Werte unten.
- Distanz: **SimBrief-Route bis zur Schwelle, bei Vectors Luftlinie + Zuschlag** (Anzeige „Vectors“).
- Warnen: **kurzer Ton pro fälliger Aktion**, 3 s „Dringend“ bei Not stabilized. Nur per WLAN.
- Ansatz **A: Bridge rechnet, Handy zeichnet.**
- Vapp aus Gewicht geschätzt (VLS Full + 5, Wind-Zuschlag), per Tipp ±5 kt korrigierbar.
- Gate bei 1000 ft über der Bahn: Gear down, Flaps 3/Full, Vapp −5/+10, V/S ≤ 1000 fpm, Pfad ±150 ft.

## Umfang
**Drin:** neue Sim-Werte, Landebahn-Datenbank, Energie-Rechnung, Live-Daten an die App, Monitor-Bildschirm, Töne, Vorschau-Seite, Tests.
**Nicht drin (erst mal):** iPad-Website, Querformat, Gate bei 500 ft, ntfy-Weg für den Monitor, Vapp aus dem MCDU.

## Schritte

1. **Neue Sim-Werte lesen** – `bridge/bridge.mjs` (`OFFS`)
   IAS 0x02BC (/128), Kurs wahr 0x0580, Wind 0x0E90 (kt) / 0x0E92 (Richtung), Klappenhebel 0x0BDC, Fahrwerk 0x0BE8, Speedbrake 0x0BD0, Radarhöhe 0x31E4, Gewicht 0x30C0.
   Beim ersten Sinkflug die Rohwerte einmal in `bridge/anflug-werte.txt` schreiben (zum Prüfen am Fenix).
   *Prüfen:* `node --check`, Fake-FSUIPC-Server aus den Tests liefert die Werte, Umrechnung stimmt.

2. **Landebahn-Datenbank** – neu `makeRunways()` in `bridge.mjs`
   OurAirports `runways.csv` (gemeinfrei) einmal laden, 30 Tage in `bridge/runway-cache/` (gitignore). `lookup(icao, rwy)` → Schwelle (inkl. versetzter Schwelle), Höhe, Kurs.
   *Prüfen:* Test mit kleiner Beispiel-CSV (EDDF 25L, versetzte Schwelle).

3. **Plan-Daten ergänzen** – SimBrief-Auswertung in `bridge.mjs`
   Geplante Bahn (`plan_rwy`), Zielhöhe. Neue aktive Bahn aus der ATIS am Ziel übernimmt (vorhandener ATIS-Parser).
   *Prüfen:* Test mit OFP-Ausschnitt + ATIS-Text.

4. **Energie-Rechnung** – neu `makeEnergy()` (ohne Netz, wie `makeMonitor`)
   Distanz (Route/Vectors), Soll-Höhe 3° (Schwelle + 50 ft + NM × 318), Überschuss in NM (Höhe/318 + (IAS − Ziel)/10 + Rückenwind-Anteil), Ampel (±2 / 5 NM), eine Aktion, Marker (spätester Punkt Flaps 1/2/Gear/3/Full mit VFE 230/200/185/177, Gear ≤ 250 kt), Gate-Check, Vapp-Schätzung, Go-around/Holding/Pause.
   *Prüfen:* Schritt 5.

5. **Tests** – `scratchpad/bridgetest/test3.mjs`, **immer gegen eine Kopie der Bridge**
   Fälle: auf dem Pfad, high & hot, zu tief, Vectors, Rückenwind, Gate geschafft, Gate verpasst, Go-around, Holding, Pause, Bahn unbekannt.

6. **Bridge verdrahten** – `bridge.mjs`
   Jede Sekunde im Sinkflug `en` in das SSE-`live`-Paket. Ton-Ereignisse als Alarmart `energy`, **nur LAN** (neue Option bei `notify`), jede Aktion nur einmal. Neue Befehle `rwy:<id>`, `vapp:<kt>` in `handleCmd`.
   *Prüfen:* Test mit SSE-Client, Befehle ändern Bahn/Vapp.

7. **Android-App** – `Prefs.java`, `WatchService.java`, `MainActivity.java` → v0.6
   Neue Alarmart `energy` (Gruppe Flug): kurzer „Piepser“ + Vibration bzw. 3 s „Dringend“, kein Vollbild-Wecker. `send()`-Muster um `rwy:`/`vapp:` erweitern. `EFBApp.keepAwake(bool)` für den Monitor.
   *Prüfen:* APK bauen, installieren, Test-Ton auslösen.

8. **Monitor-Bildschirm** – `handy/index.html`
   Vollbild-Ebene mit SVG-Profil (3°-Linie, Band, Flugzeug, Trendlinie, Marker, Gate; Zoom 60 → 15 NM unter 5000 ft), großer Zustand + Aktion, Werte-Zeile, Bahn/Vapp-Chips. Auto-Öffnen/Schließen, Knopf im Flug-Tab.
   *Prüfen:* Schritt 9 + Handy.

9. **Vorschau-Seite** – `../efb-design/anflug-vorschau.html` mit erfundenen Daten (umschaltbar: auf dem Pfad, high & hot, Vectors, Gate verpasst). Im Browser-Pane im Handy-Format ansehen und dem Nutzer zeigen, **bevor** Schritt 8 fertig poliert wird.

10. **Test im echten Sim** – ein Anflug mit Fenix: Werte aus `anflug-werte.txt` prüfen (Klappen/Gear/Speedbrake/Wind), Monitor öffnet ab TOD, Töne, Gate. Danach `CLAUDE.md`, `ROADMAP.md`, Vault-Notiz aktualisieren. Push nur, wenn der Nutzer es sagt.

## Offene Fragen und Risiken
- **Fenix und Standard-Offsets:** Klappen, Fahrwerk und Speedbrake könnten beim Fenix nicht in den FSUIPC-Standardstellen stehen → dann Fenix-L-Vars suchen (Schritt 10 zeigt es).
- **Wind-Richtung:** wahr oder magnetisch in 0x0E92 – am Sim prüfen, sonst ist der Rückenwind falsch.
- **Vapp-Schätzung** ist nur ungefähr (±5 kt) → deshalb korrigierbar.
- **Vectors-Zuschlag** ist eine Faustregel; bei kurzen Vectors kann „zu hoch“ etwas früh kommen.
- **OurAirports** kann bei kleinen Plätzen falsche oder fehlende Schwellen haben → Fallback Flughafen-Mittelpunkt mit Hinweis.
- Live-Daten und Töne nur im Heim-WLAN (gewollt).

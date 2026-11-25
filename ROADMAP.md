# Fahrplan

**Reihenfolge (Stand 2026-11-25):** A1–A4 sind gebaut. **Teil B, Schritt 1** (PC-Bridge `bridge/` + ntfy: Master Warning/Caution, AP aus, Pause, TOD, Weg-Modus) ist gebaut, aber noch nicht am Sim getestet. Dazu die Tray-App `EFB-Bridge.exe` mit MSFS-Autostart. **Handy-App „EFB Wächter“ Schritt 1** (Wecker, Alarme einstellbar, Weg/Zurück, Verlauf, Koppeln per QR) ist gebaut und im Emulator getestet. **Schritt 2 – Flugdaten in der App** (Höhe, GS, V/S, Phase, TOD, aktueller/nächster Lotse, Ziel-ATC) ist gebaut. Sektor-Warnung „in X min neuer Lotse“ und Alarm-Modus „Wecker nur im Weg-Modus“ sind gebaut. Offen in B: vPilot „Contact me“ / private Nachrichten. A5–A9 kommen später.

## A. iPad-EFB (index.html) – vom Nutzer freigegeben, noch nicht gebaut
1. **Bildschirm bleibt an** – Screen Wake Lock API (Safari ≥ 16.4), Schalter in Einstellungen (Standard an), nach Tab-Wechsel neu anfordern.
2. **Funk ⇄ Checkliste gekoppelt** – gemeinsame Phase: „Weiter“ in der Checkliste stellt den Funk-Tab auf die passende Phase/Anfrage, und umgekehrt.
3. **Wo bin ich?** – eigenes Callsign im VATSIM-Feed (`pilots[]`) finden → Höhe, GS, Position. Daraus Phase-Vorschlag und abdeckender Lotse.
4. **„Nächste Frequenz“** – unter dem aktuellen Lotsen klein der wahrscheinlich nächste. Bei „contact … on …“ antippen → wird aktuell. Sonst Auswahlliste aller Online-Lotsen. Kein Tippen.
   Enroute-Sektoren: VATSpy-Daten (FIR-Grenzen + Callsign-Präfixe) aus dem vatspy-data-project.
5. **Notizblock im Funk** (Chips statt Textfeld): Squawk **1000** als Standard-Chip + „Andere“ mit Ziffernblock; freigegebene Höhe (5000/FL70/FL100/Andere); Frequenz über Punkt 4. Werte fließen in Readbacks/Callouts.
6. **Wetter in den Funk-Tab** – eine Zeile oben: ATIS-Buchstabe · Piste · QNH · Wind. Wetter-Tab danach entfernen (Lotsenliste mitnehmen) → 3 Tabs.
7. **Briefings** – Knopf „Briefing anzeigen“ in Phase *brief* und *dprep*, Vorlesetext für PF, gefüllt aus SimBrief/ATIS/Notizen, Fehlendes orange.
   - Takeoff: Piste, SID + erste Höhe, Flaps/FLEX, V-Speeds, Engine Failure vor/nach V1, Rückkehr/Ausweichplatz.
   - Approach: Wetter/QNH, STAR, Anflugart + Piste, Minimums, Missed Approach, Autobrake, Taxi zum Stand.
8. **Abnormals (dezent)** – kleiner grauer „⚠ Abnormal“-Knopf in der Checklisten-Leiste: Rejected Takeoff, Engine Failure nach V1, Go Around, Mayday/Pan-Pan-Phraseologie, Emergency-Checklisten. In Einstellungen ausblendbar.
9. Kleinkram: Flug-Tab verschlanken (SimBrief laden + Stand, FLEX, Squawk), „Aussprache zeigen“ optional.

Verworfen: virtueller First Officer (Sprachausgabe/-erkennung), eigene Karte.

## B. Duo-Paket: PC-Bridge + Handy-Wächter (danach)
Ziel: Nutzer kann bei langen Flügen kurz weg und wird zuverlässig geholt, wenn er an den PC muss.

**PC-Bridge (Windows, läuft neben MSFS)**
- SimConnect: Position, Höhe, GS, Sim-Rate, Pause; Fenix-Warnungen (Master Caution/Warning) über L-Vars (z. B. via MobiFlight WASM / FSUIPC).
- VATSIM: Online-Lotsen + Sektorgrenzen (VATSpy) → „Du fliegst in X Minuten in den Sektor von EDGG_…_CTR“.
- TOD: aus SimBrief-OFP + aktueller Position (Konkurrenz macht es genauso).
- „Contact me“ / private Nachrichten: vPilot-Plugin-Schnittstelle (wichtigster Alarm!).
- Liefert Live-Daten zusätzlich ans iPad-EFB (lokales WebSocket) → automatische Phase/Frequenz.

**Handy (Android)**
- Vorbilder:
  - **ContactMe**: Route-Center „Current / Upcoming“ mit Entfernung, vPilot-Status, Messages, Scratchpad.
  - **SimAlert**: ATC-Abdeckung per Callsign.
- Unsere App soll das alles können und zusätzlich:
  - **Sim-Warnungen**: Master Caution / Master Warning, AP-Disconnect, Pause.
  - **TOD-Alarm**.
  - **Abwesenheits-Timer** (Alarm nach 25 min, siehe VATSIM-Regeln unten).
  - **Kopplung mit dem iPad-EFB**: Der gemeldete Lotse wird im Funk-Tab zu „Jetzt rufen“.
- Schritt 1: Push über **ntfy** (kostenlos, laut auch bei „Nicht stören“), keine eigene APK nötig.
- Schritt 2: eigene Android-App (APK) mit Live-Status.
- WhatsApp verworfen (nur über Business-API).

**VATSIM-Regeln beachten:** CoC A9/B3 – Verbindung nicht unbeaufsichtigt lassen; max. 30 min weg, unter aktiver ATC nur mit Zustimmung des Lotsen. → Alarm „seit 25 min weg“ einbauen.

**Bestehende Tools (zum Abgrenzen):** 123flightARRIVAL (Windows, TOD + ntfy), Skylink TOD Alert (iPhone), Cobalt (iOS), PocketSky (SayIntentions), ContactMe & SimAlert (iPhone, VATSIM-Lotsen/Nachrichten), vatalert (Android, alt).
Lücke: alles in einem, für Android, gekoppelt an ein EFB mit echten Procedures.

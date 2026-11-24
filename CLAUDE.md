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
- ATIS-Parser: Buchstabe, aktive Pisten (Array, parallele Pisten), QNH → Warnung, wenn geplante Piste nicht aktiv.
- Aussprache-Helfer: NATO-Alphabet, tree/fife/niner, Airline-Callsigns (`AIRL`), Städtenamen (`CITY`), `sidSp`.
- `phrase()` / `renderFunk()` / `clrBlock()`: Funk-Tab. Werte als `<span class="vok|vmiss" data-e="key">` (grün = bekannt, orange = fehlt → antippen zum Eintragen).
- `CK`: Lufthansa-Checkliste, Einträge `[ITEM, ACTION]`, `'LINE'` = „down to the line“. `ev` = Emergency.
- `FLOWS`: Procedures, 28 Phasen (prelim, walk*, ovhd, ped, glare, brief, bpush, startclr, eng, after, taxi, lineup, tko, atko, ta, climb10, cruise, dprep, tod, desc10, tl, iapp, final, land, ga*, alnd, park, secure*; * = optional).
  Mini-DSL pro Zeile:
  - `ROLLE|ITEM|SETTING|Notiz` – Rolle PF, PM, CM (beide), BOTH
  - `@ROLLE|Callout|Notiz` – gesprochener Satz (eigene Rolle wird hervorgehoben)
  - `#ckid:down|below|all` – fügt Checkliste (Teil) ein
  - `!funkphase:Anfrage|Label` – Link in den Funk-Tab
  - `~` am Anfang = nur bei Detail „Voll“
  - Platzhalter `{flex}`, `{ta}`, `{tl}`, `{tod}`, `{qnhArr}` … werden aus dem Flug gefüllt.
- Quellen der Procedures: FlyByWire A32NX SOP, TheAirlinePilots „A320 Normal Procedures“ (Apr 2025), JayDee's Fenix Guide v1.31.1. Bei Änderungen gegen echte Airbus-SOP prüfen – **nichts auslassen**.

## Deploy
Push auf `main` → GitHub Pages baut neu (~1 min). Danach im Browser mit `?v=<n>` testen (Cache).
Vor jedem Push: JS-Syntax prüfen (Script extrahieren, `node --check`) und im iPad-Format (768×1024) ansehen.

## Regeln
- Keine Passwörter/Tokens in den Code. Repo ist **öffentlich**.
- Die PDFs des Nutzers (VATSIM-Phraseologie, Fenix-Guide) **nicht** ins Repo committen – nur lokal als Quelle nutzen.
- Größere Umbauten erst kurz mit dem Nutzer abstimmen (eine Frage nach der anderen), kleine Fixes einfach machen.

Fahrplan: siehe `ROADMAP.md`.

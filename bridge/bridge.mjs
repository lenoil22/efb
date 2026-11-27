// EFB Bridge – Sim-Warnungen aufs Handy (ntfy)
// Läuft auf dem Sim-PC neben MSFS. Liest über den FSUIPC WebSocket Server (FSUIPC7) Pause, Position und
// Fenix-L-Vars (Master Warning/Caution, AP) und schickt Push-Nachrichten über ntfy.
// Keine npm-Pakete nötig (Node ≥ 22: fetch + WebSocket eingebaut). Start: start.bat
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG_FILE = path.join(DIR, 'config.json');
const LVAR_FILE = path.join(DIR, 'lvars-gefunden.txt');
const ANF_FILE = path.join(DIR, 'anflug-werte.txt');   // Rohwerte für den Anflug-Monitor (Prüfung am Sim, danach löschbar)

export const DEFAULTS = {
  ntfyServer: 'https://ntfy.sh',
  topic: '',                 // geheimer Kanalname – wird beim ersten Start erzeugt
  simbriefUser: '',          // SimBrief-Name steht nur in der lokalen config.json (Repo ist öffentlich)
  wsUrl: 'ws://localhost:2048/fsuipc/',
  todLeadMin: 5,             // TOD-Alarm so viele Minuten vorher
  awayMin: 25,               // Weg-Modus: Alarm nach so vielen Minuten (VATSIM: max. 30)
  pauseAfterSec: 10,         // Pause-Alarm, wenn der Sim in der Luft so lange pausiert
  sectorLeadMin: 5,          // „Neuer Lotse voraus“ so viele Minuten vorher
  lanPort: 8790,             // WLAN direkt: Handy verbindet sich hierhin (Ereignisse, Live-Daten, Befehle)
  lanBeaconPort: 8791,       // UDP-Rundruf, damit das Handy den PC im WLAN findet
  lvars: { warning: '', caution: '', ap1: '', ap2: '' }  // leer = automatisch suchen
};

const ts = () => new Date().toLocaleTimeString('de-DE');
export const log = (...a) => console.log(ts(), ...a);

export function loadConfig(file = CFG_FILE) {
  let cfg = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');   // Editor-BOM (z. B. Notepad) ignorieren
    try { cfg = JSON.parse(raw); } catch (e) { log(`config.json ist kein gültiges JSON (${e.message}) – bitte korrigieren.`); process.exit(2); }
  }
  cfg = { ...DEFAULTS, ...cfg, lvars: { ...DEFAULTS.lvars, ...(cfg.lvars || {}) } };
  if (!cfg.topic) {
    cfg.topic = 'efb-' + crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    cfg._new = true;
  }
  return cfg;
}

/* ---------- Entfernung in NM ---------- */
export function nm(lat1, lon1, lat2, lon2) {
  const r = x => x * Math.PI / 180, R = 3440.065;
  const h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function brg(lat1, lon1, lat2, lon2) {
  const r = x => x * Math.PI / 180;
  const y = Math.sin(r(lon2 - lon1)) * Math.cos(r(lat2));
  const x = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(r(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
export const destPt = (lat, lon, hdg, d) => { const h = hdg * Math.PI / 180; return [lat + d * Math.cos(h) / 60, lon + d * Math.sin(h) / (60 * Math.cos(lat * Math.PI / 180))]; };
const adiff = (a, b) => ((a - b) % 360 + 540) % 360 - 180;
function crossTrack(p, a, b) {
  const R = 3440.065, d13 = nm(a[0], a[1], p[0], p[1]) / R;
  const t = (brg(a[0], a[1], p[0], p[1]) - brg(a[0], a[1], b[0], b[1])) * Math.PI / 180;
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(t)) * R);
}

/* ---------- Anflug-Monitor: Energie-Rechnung (ohne Netz, testbar) ----------
   Faustregeln, keine Airbus-Performance-Daten:
   3°-Pfad = 318 ft/NM · 10 kt über der normalen Geschwindigkeit ≈ 1 NM · 10 kt Rückenwind ≈ 1 NM.
   Mit Speedbrake + Gear lassen sich pro geflogener NM etwa 0,7 NM Überschuss abbauen (→ „nicht zu schaffen“). */
export const FT_NM = 318, GATE_FT = 1000;
export const GATE_NM = (GATE_FT - 50) / FT_NM;            // ≈ 3 NM vor der Schwelle
export const VFE = [Infinity, 230, 200, 185, 177];        // Klappenhebel 0, 1, 2, 3, FULL
const VLO = 250, FLAPN = ['0', '1', '2', '3', 'FULL'];
const MK = [{ id: 'f1', n: 'Flaps 1', d: 13, lv: 1 }, { id: 'f2', n: 'Flaps 2', d: 8, lv: 2 }, { id: 'gear', n: 'Gear down', d: 6.5 }, { id: 'f3', n: 'Flaps 3', d: 5, lv: 3 }, { id: 'full', n: 'Flaps full', d: 4, lv: 4 }];

/* Vapp ≈ VLS CONF FULL (grob aus dem Gewicht) + Wind-Zuschlag (⅓ Gegenwind, 5–15 kt) */
export function vappEstimate(weightKg, headKt = 0) {
  const T = [[45, 112], [50, 117], [55, 122], [60, 127], [65, 132], [70, 137], [75, 142]];
  const w = Math.min(75, Math.max(45, (weightKg || 60000) / 1000));
  let i = 0; while (i < T.length - 2 && w > T[i + 1][0]) i++;
  const vls = T[i][1] + (T[i + 1][1] - T[i][1]) * (w - T[i][0]) / (T[i + 1][0] - T[i][0]);
  return Math.round(vls + Math.min(15, Math.max(5, headKt / 3)));
}
/* Übliche Geschwindigkeit an diesem Punkt des Anflugs (d = NM bis zur Schwelle) */
export function speedTarget(d, altFt, vapp) {
  if (d > 30) return altFt > 10500 ? 290 : 250;
  const P = [[GATE_NM, vapp], [5, vapp + 10], [7, 160], [10, 185], [13, 210], [20, 230], [30, 250]];
  if (d <= P[0][0]) return vapp;
  let i = 0; while (d > P[i + 1][0]) i++;
  return Math.round(P[i][1] + (P[i + 1][1] - P[i][1]) * (d - P[i][0]) / (P[i + 1][0] - P[i][0]));
}
/* Distanz zur Schwelle: im Endanflug Luftlinie, auf der Route entlang der Wegpunkte, sonst Vectors
   (über einen Punkt auf der verlängerten Bahnachse, 4–10 NM vor der Schwelle) */
export function approachDist(me, plan, rwy) {
  const thr = [rwy.lat, rwy.lon], direct = nm(me[0], me[1], thr[0], thr[1]);
  const off = rwy.hdg == null ? 0 : Math.abs(adiff(brg(thr[0], thr[1], me[0], me[1]), (rwy.hdg + 180) % 360));
  if (rwy.hdg != null && direct < 2) return { d: Math.max(0, direct * Math.cos(off * Math.PI / 180)), mode: 'final' };   // über/hinter der Schwelle → 0, nicht „Vectors“
  if (direct < 12 && off < 25) return { d: direct, mode: 'final' };
  const W = plan?.wps || [];
  if (W.length >= 2) {
    let bi = 0, bd = 1e9; W.forEach((w, i) => { const x = nm(me[0], me[1], w[0], w[1]); if (x < bd) { bd = x; bi = i; } });
    let nx = bi; if (bi < W.length - 1 && nm(me[0], me[1], W[bi + 1][0], W[bi + 1][1]) < nm(W[bi][0], W[bi][1], W[bi + 1][0], W[bi + 1][1])) nx = bi + 1;
    const b = W[nx], last = W[W.length - 1];
    const prev = W[W.length - 2], past = nx === W.length - 1 && nm(prev[0], prev[1], me[0], me[1]) > nm(prev[0], prev[1], last[0], last[1]);
    if (past && off < 25) return { d: direct, mode: 'final' };   // letzter Routenpunkt hinter uns, auf der Achse
    const xt = nx > 0 ? crossTrack(me, W[nx - 1], b) : bd;
    if (!past && xt <= 3) return { d: nm(me[0], me[1], b[0], b[1]) + (last[3] - b[3]) + nm(last[0], last[1], thr[0], thr[1]), mode: 'route' };
  }
  if (rwy.hdg == null) return { d: direct, mode: 'vectors' };
  const fd = Math.min(10, Math.max(4, direct * 0.6)), F = destPt(thr[0], thr[1], (rwy.hdg + 180) % 360, fd);
  return { d: nm(me[0], me[1], F[0], F[1]) + fd, mode: 'vectors' };
}

/* update(st, ctx) jede Sekunde. st: lat, lon, altFt, iasKt, gsKt, vsFpm, hdg, windDir, windKt, flaps (0–4), gear, spdbrk (0–1),
   weightKg, onGround, paused. ctx: plan, rwy {id, lat, lon, elev, hdg, src}, vapp (von Hand), todPassed.
   Gibt { view, events } zurück: view geht live ans Handy, events = Töne (level short | urgent). */
export function makeEnergy({ now = () => Date.now() } = {}) {
  const fresh = () => ({ on: false, desc: 0, landed: 0, gate: null, minAal: 1e9, prevAal: null, said: {}, cand: null, candT: 0, hist: [], ga: 0, last: null });
  let S = fresh();
  const r1 = x => Math.round(x * 10) / 10;
  function update(st, ctx = {}) {
    const t = now(), ev = [], rwy = ctx.rwy;
    if (st.lat == null || !rwy) return { view: { on: false }, events: ev };
    if (S.on && st.paused && S.last) return { view: { ...S.last, paused: true }, events: ev };
    const dist = approachDist([st.lat, st.lon], ctx.plan, rwy), d = dist.d;
    if (!S.on) {
      if (!st.onGround && d <= 150) {
        S.desc = st.vsFpm < -500 ? (S.desc || t) : 0;
        if (ctx.todPassed || (S.desc && t - S.desc >= 30000)) S.on = true;
      }
      if (!S.on) return { view: { on: false }, events: ev };
    }
    if (st.onGround) { S.landed = S.landed || t; if (t - S.landed > 30000) { S = fresh(); return { view: { on: false, landed: true }, events: ev }; } } else S.landed = 0;

    const elev = rwy.elev ?? ctx.plan?.arrElev ?? 0, aal = st.altFt - elev;
    const ideal = elev + 50 + d * FT_NM, devFt = st.altFt - ideal;
    const head = (st.windKt || 0) * Math.cos(((st.windDir || 0) - (st.hdg || 0)) * Math.PI / 180), tail = -head;
    const vapp = ctx.vapp || vappEstimate(st.weightKg, Math.max(0, head));
    const tgt = speedTarget(d, st.altFt, vapp);
    const hNm = devFt / FT_NM, sNm = (st.iasKt - tgt) / 10, wNm = tail / 10, excess = hNm + sNm + wNm;
    const cap = Math.max(0, d - GATE_NM) * 0.7 + 0.5;

    /* Holding: 4 min lang kaum näher gekommen */
    S.hist.push([t, d]); while (S.hist.length && t - S.hist[0][0] > 360000) S.hist.shift();
    const holding = !st.onGround && d > 10 && t - S.hist[0][0] >= 240000 && S.hist[0][1] - d < 2;
    /* Go-around: unter 2000 ft (oder nach dem Gate) wieder deutlich gestiegen */
    if (S.gate || aal < 2000) S.minAal = Math.min(S.minAal, aal);
    if (!st.onGround && st.vsFpm > 500 && aal > S.minAal + 300) { S.gate = null; S.minAal = 1e9; S.said = {}; S.ga = t; }

    let state, label;
    const high = hNm > 1, fast = sNm + wNm > 1;
    if (holding) state = 'hold';
    else if (excess > 2 && excess > cap) state = 'unable';
    else if (excess > 5) state = 'red';
    else if (excess > 2) state = 'amber';
    else if (excess < -2) state = 'blue';
    else state = 'ok';
    const what = high && fast ? 'HIGH & HOT' : hNm >= sNm + wNm ? 'ZU HOCH' : 'ZU SCHNELL';
    label = { hold: 'HOLDING', unable: 'NICHT ZU SCHAFFEN', red: what, amber: 'ETWAS ' + (high && fast ? 'HOCH & SCHNELL' : what.replace('ZU ', '')), blue: devFt < -FT_NM ? 'ZU TIEF' : 'ZU LANGSAM', ok: 'AUF PROFIL' }[state];

    /* Marker: spätester Punkt für die Konfiguration, rückt bei Überschuss nach vorn */
    const shift = Math.max(0, excess);
    const markers = MK.map(m => ({ id: m.id, n: m.n, d: r1(Math.min(25, m.d + shift)), done: m.id === 'gear' ? !!st.gear : st.flaps >= m.lv, blocked: m.id === 'gear' ? st.iasKt > VLO : st.iasKt > VFE[m.lv] }));

    /* Eine Aktion */
    let act = null;
    if (aal > GATE_FT && !st.onGround && state !== 'hold') {
      const nf = Math.min(4, (st.flaps || 0) + 1);
      if (state === 'unable') act = { id: 'tm', t: 'Mehr Track Miles / Orbit anfragen' };
      else if (state === 'red' || state === 'amber') {
        const full = state === 'red';
        if (st.flaps < 3 && (st.spdbrk || 0) < (full ? 0.9 : 0.4)) act = { id: full ? 'sb-full' : 'sb-half', t: full ? 'Speedbrake voll' : 'Speedbrake halb' };
        else if (full && !st.gear && st.iasKt <= VLO && d < 15) act = { id: 'gear-brake', t: 'Gear down jetzt (als Bremse)' };
        else if (st.flaps < 4 && st.iasKt <= VFE[nf] - 3) act = { id: 'f' + nf, t: 'Flaps ' + FLAPN[nf] };
        else act = { id: 'decel', t: 'Früher verzögern' };
      } else if ((st.spdbrk || 0) > 0.1 && (excess < 0.5 || st.flaps >= 3)) act = { id: 'sb-in', t: 'Speedbrake rein' };
      else if (state === 'blue') act = devFt < -FT_NM ? { id: 'low', t: 'Höhe halten / Schub' } : { id: 'slow', t: 'Speed halten' };
      else { const m = markers.find(x => !x.done && d <= x.d + 0.3); if (m) act = m.blocked ? { id: m.id, t: `${m.n} – erst unter ${m.id === 'gear' ? VLO : VFE[MK.find(k => k.id === m.id).lv]} kt` } : { id: m.id, t: m.n }; }
    }
    /* Ton: Aktion 3 s stabil → einmal; erst wieder, wenn sie 30 s weg war */
    const aid = act?.id || null;
    if (aid !== S.cand) { S.cand = aid; S.candT = t; }
    if (aid && t - S.candT >= 3000) { if (!S.said[aid]) ev.push({ id: aid, level: aid === 'tm' ? 'urgent' : 'short', text: act.t }); S.said[aid] = t; }
    for (const k of Object.keys(S.said)) if (k !== aid && t - S.said[k] > 30000) delete S.said[k];

    /* 1000-ft-Gate (einmal beim Durchsinken) */
    if (!S.gate && !st.onGround && S.prevAal != null && S.prevAal > GATE_FT && aal <= GATE_FT) {
      const why = [];
      if (!st.gear) why.push('Gear nicht unten');
      if (st.flaps < 3) why.push('Klappen ' + FLAPN[st.flaps || 0]);
      if (st.iasKt > vapp + 10) why.push(`${Math.round(st.iasKt - vapp)} kt zu schnell`); else if (st.iasKt < vapp - 5) why.push(`${Math.round(vapp - st.iasKt)} kt zu langsam`);
      if (st.vsFpm < -1000) why.push(`Sinkrate ${Math.round(-st.vsFpm)} fpm`);
      if (Math.abs(devFt) > 150) why.push(devFt > 0 ? `${Math.round(devFt)} ft über dem Pfad` : `${Math.round(-devFt)} ft unter dem Pfad`);
      S.gate = { ok: !why.length, why };
      if (why.length) ev.push({ id: 'gate-fail', level: 'urgent', text: 'Not stabilized – go around', why });
    }
    S.prevAal = aal;

    /* Unter dem Gate ist das Gate-Ergebnis die Hauptanzeige */
    if (S.gate && aal <= GATE_FT + 200) { state = S.gate.ok ? 'ok' : 'red'; label = S.gate.ok ? 'STABILIZED' : 'NOT STABILIZED'; }
    const gs = Math.max(st.gsKt || 0, 60);
    const needVs = d > GATE_NM ? -(st.altFt - (elev + GATE_FT)) / ((d - GATE_NM) / gs * 60) : -gs * FT_NM / 60;
    const view = {
      on: true, rwy: rwy.id || '', src: rwy.src || '', mode: dist.mode, d: r1(d), elev: Math.round(elev), alt: Math.round(st.altFt), aal: Math.round(aal),
      ideal: Math.round(ideal), devFt: Math.round(devFt), ias: Math.round(st.iasKt), tgt, gs: Math.round(st.gsKt || 0), vs: Math.round(st.vsFpm || 0),
      needVs: Math.round(needVs / 50) * 50, tail: Math.round(tail), flaps: FLAPN[st.flaps || 0], gear: !!st.gear, spdbrk: r1(st.spdbrk || 0),
      vapp, vappEst: !ctx.vapp, excess: r1(excess), state, label, act: act ? act.t : '', markers, gateNm: r1(GATE_NM),
      gate: S.gate, ga: S.ga && t - S.ga < 30000, trend: [r1(d - gs / 60), Math.round(st.altFt + (st.vsFpm || 0))], paused: false
    };
    S.last = view;
    return { view, events: ev };
  }
  return { update, reset: () => { S = fresh(); }, get on() { return S.on; } };
}

/* ---------- ntfy: senden + Befehle vom Handy empfangen ---------- */
export function makeNtfy(cfg, fetchImpl = fetch) {
  const base = cfg.ntfyServer.replace(/\/$/, '');
  const cmdTopic = cfg.topic + '-cmd';
  const backAction = [{ action: 'http', label: 'Bin zurück', url: `${base}/${cmdTopic}`, method: 'POST', body: 'da', clear: true }];
  /* kind = Alarmart für die Handy-App (Tag „efb-<kind>“): warning, caution, ap, pause, tod, sector, away, test, info.
     aid = gleiche Alarm-ID wie über WLAN direkt → die App zeigt/klingelt nur einmal (Tag „aid-<id>“) */
  async function send({ title, message, priority = 3, tags = [], back = false, kind = 'info', aid = '' }) {
    try {
      const r = await fetchImpl(base + '/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: cfg.topic, title, message, priority, tags: [...tags, 'efb-' + kind, ...(aid ? ['aid-' + aid] : [])], ...(back ? { actions: backAction } : {}) })
      });
      log(r.ok ? `→ Handy: ${title}` : `ntfy-Fehler ${r.status} bei „${title}“`);
    } catch (e) { log('ntfy nicht erreichbar:', e.message); }
  }
  /* Status für die Handy-App auf eigenem Kanal (ntfy-App zeigt ihn nicht). Nur bei Änderung – ntfy.sh erlaubt 250 Nachrichten/Tag. */
  let lastSt = '', stTimer = null, pending = null;
  function status(obj) {
    const s = JSON.stringify(obj); if (s === lastSt) return; pending = s;
    if (stTimer) return;
    stTimer = setTimeout(async () => {
      stTimer = null; if (pending === lastSt) return; const body = pending; lastSt = body;
      try { await fetchImpl(`${base}/${cfg.topic}-status`, { method: 'POST', body, headers: { Priority: '1' } }); } catch { lastSt = ''; }
    }, 3000);                         // Änderungen 3 s sammeln
  }
  /* Befehle („weg“, „da“) über einen zweiten Kanal – z. B. vom Knopf „Bin zurück“ in der Nachricht */
  async function listen(onCmd, signal) {
    while (!signal?.aborted) {
      try {
        const r = await fetchImpl(`${base}/${cmdTopic}/json`, { signal });
        const dec = new TextDecoder(); let buf = '';
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i; while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            try { const m = JSON.parse(line); if (m.event === 'message' && m.message) onCmd(String(m.message).trim()); } catch { }   // Groß/klein bleibt (Antworttexte)
          }
        }
      } catch (e) { if (signal?.aborted) return; }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return { send, listen, status, cmdTopic };
}

/* ---------- WLAN direkt: kleiner Server im Heimnetz ----------
   GET  /events?k=<kanal>  → Server-Sent Events: „alarm“, „status“, „live“ (Position jede Sekunde)
   POST /cmd?k=<kanal>     → „weg“ / „da“
   UDP-Rundruf alle 2 s an Port lanBeaconPort, damit das Handy den PC findet (auch bei neuer IP).
   Schlüssel = ntfy-Kanal aus dem Koppeln; ohne ihn antwortet der Server nicht. */
export function makeLan(cfg, { onCmd, onVpilot, getLogbook, listen = true } = {}) {
  const clients = new Set(), key = cfg.topic, vpQueue = [];
  let lastStatus = '', vpSeen = 0;
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // vPilot-Plugin läuft auf demselben PC: /vpilot* von 127.0.0.1 auch ohne Schlüssel (das Plugin kennt den Kanal nicht)
    const local = /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || '') && u.pathname.startsWith('/vpilot');
    if (!local && u.searchParams.get('k') !== key) { res.writeHead(403); res.end(); return; }
    if (req.method === 'GET' && u.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': EFB Bridge\n\n'); clients.add(res);
      if (lastStatus) res.write(`event: status\ndata: ${lastStatus}\n\n`);
      const lb = getLogbook?.(); if (lb) res.write(`event: logbook\ndata: ${JSON.stringify(lb)}\n\n`);
      log(`Handy per WLAN verbunden (${req.socket.remoteAddress?.replace('::ffff:', '')}).`);
      req.on('close', () => { clients.delete(res); log('Handy per WLAN getrennt.'); });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/cmd') {
      let b = ''; req.on('data', d => b += d); req.on('end', () => { const c = b.trim(); if (c) onCmd?.(c); res.end('ok'); });
      return;
    }
    /* vPilot-Plugin: meldet Ereignisse (POST /vpilot) und holt Befehle ab (GET /vpilot/cmds) */
    if (req.method === 'POST' && u.pathname === '/vpilot') {
      let b = ''; req.on('data', d => b += d); req.on('end', () => { try { onVpilot?.(JSON.parse(b)); } catch { } res.end('ok'); });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/vpilot/cmds') {
      vpSeen = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(vpQueue.splice(0))); return;
    }
    if (req.method === 'GET' && u.pathname === '/logbook') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(getLogbook?.() || [])); return;
    }
    res.writeHead(404); res.end();
  });
  const send = (ev, data) => { const s = `event: ${ev}\ndata: ${data}\n\n`; for (const r of clients) r.write(s); };
  let beacon = null, timers = [];
  if (listen) {
    srv.on('error', e => log(`WLAN-Server (Port ${cfg.lanPort}) nicht möglich: ${e.message} – nur ntfy.`));
    srv.listen(cfg.lanPort, '0.0.0.0', () => log(`WLAN direkt bereit (Port ${cfg.lanPort}).`));
    timers.push(setInterval(() => { for (const r of clients) r.write(': ka\n\n'); }, 20000));
    beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    beacon.on('error', () => { });
    beacon.bind(() => {
      try { beacon.setBroadcast(true); } catch { }
      timers.push(setInterval(() => {
        const msg = Buffer.from(JSON.stringify({ efb: 1, id, port: srv.address()?.port || cfg.lanPort }));
        const targets = new Set(['255.255.255.255']);
        for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) {
          if (n.family !== 'IPv4' || n.internal) continue;
          const ip = n.address.split('.').map(Number), m = n.netmask.split('.').map(Number);
          targets.add(ip.map((b, i) => (b | (~m[i] & 255))).join('.'));      // Subnetz-Broadcast, z. B. 192.168.1.255
        }
        for (const t of targets) beacon.send(msg, cfg.lanBeaconPort, t, () => { });
      }, 2000));
    });
  }
  return {
    id, port: () => srv.address()?.port,
    alarm: o => send('alarm', JSON.stringify(o)),
    status: s => { lastStatus = JSON.stringify(s); send('status', lastStatus); },
    live: o => { if (clients.size) send('live', JSON.stringify(o)); },
    logbook: list => send('logbook', JSON.stringify(list)),
    vpilot: c => { vpQueue.push(c); if (vpQueue.length > 20) vpQueue.shift(); },
    vpilotOnline: () => Date.now() - vpSeen < 6000,
    count: () => clients.size,
    close: () => { timers.forEach(clearInterval); try { beacon?.close(); } catch { } srv.close(); for (const r of clients) r.end(); },
    server: srv
  };
}

/* ---------- Fenix-L-Vars aus der Liste des WASM-Moduls wählen ---------- */
const PREF = {
  warning: ['I_MIP_MASTER_WARNING_CAPT', 'I_MIP_MASTER_WARNING_FO'],
  caution: ['I_MIP_MASTER_CAUTION_CAPT', 'I_MIP_MASTER_CAUTION_FO'],
  ap1: ['I_FCU_AP1'], ap2: ['I_FCU_AP2']
};
const RX = { warning: /MASTER_?WARN/i, caution: /MASTER_?CAUT/i, ap1: /FCU.*AP_?1$/i, ap2: /FCU.*AP_?2$/i };
export function pickLvars(list, over = {}) {
  const out = {};
  for (const k of Object.keys(PREF)) {
    out[k] = over[k] || PREF[k].find(n => list.includes(n)) ||
      list.filter(n => RX[k].test(n)).sort((a, b) => b.startsWith('I_') - a.startsWith('I_'))[0] || '';
  }
  return out;
}
export const lvarCandidates = list => list.filter(n => /MASTER|FCU_AP|_AP_?[12]\b|AUTOPILOT|AP_DISC/i.test(n));

/* ---------- Alarm-Logik (ohne Netz, damit testbar) ---------- */
export function makeMonitor({ cfg, notify, now = () => Date.now() }) {
  const st = {
    lat: null, lon: null, altFt: 0, gsKt: 0, onGround: true, paused: false, pausedSince: 0, pauseSent: false,
    warn: false, caut: false, ap1: false, ap2: false, apWasOn: false,
    tod: null, todSent: false, todLast: null, todHintSent: false, todFms: null, away: false, awaySince: 0, awaySent: false, simSeen: false,
    track: [], route: null
  };
  const last = {};
  const cool = (k, ms) => { const t = now(); if (last[k] && t - last[k] < ms) return false; last[k] = t; return true; };

  function offsets(d) {
    st.simSeen = true;
    if (d.lat != null) st.lat = d.lat;
    if (d.lon != null) st.lon = d.lon;
    if (d.alt != null) st.altFt = d.alt / 4294967296 * 3.28084;
    if (d.gs != null) st.gsKt = d.gs / 65536 * 1.943844;
    if (d.onGround != null) st.onGround = d.onGround === 1;
    /* Flugspur der letzten 2 min (für Direct-Erkennung), höchstens ein Punkt pro 5 s */
    if (st.lat != null && !st.onGround) {
      const t = now(), lp = st.track[st.track.length - 1];
      if (!lp || t - lp.t >= 5000) st.track.push({ lat: st.lat, lon: st.lon, t });
      while (st.track.length && t - st.track[0].t > 120000) st.track.shift();
    }
    if (d.paused != null) st.paused = d.paused !== 0;
    if (d.vs != null) st.vsFpm = Math.round(d.vs / 256 * 196.8504);
    if (d.g != null) st.g = d.g / 624;
    if (d.fuel != null) st.fuelLbs = d.fuel;
    if (d.tdVs != null) st.tdVs = Math.round(d.tdVs / 256 * 196.8504);   // vom Sim beim Aufsetzen festgehalten
    st.lastData = now(); st.crashSent = false;
  }
  function vars(d, names) {
    for (const [role, name] of Object.entries(names)) {
      if (!name || !(name in d)) continue;
      const on = Number(d[name]) > 0;
      if (role === 'warning') {
        // erst nach 3 s melden: beim AP-Disconnect leuchtet Master Warning mit – dann nur „Autopilot aus“ (tick)
        if (on && !st.warn) st.warnPending = now();
        if (!on) st.warnPending = 0;
        st.warn = on;
      } else if (role === 'caution') {
        // nur in der Luft: beim Startup am Gate leuchtet Master Caution oft kurz auf; höchstens alle 2 min
        if (on && !st.caut && st.onGround === false && cool('caut', 120000)) notify({ kind: 'caution', title: 'Master Caution', message: 'Im Cockpit leuchtet Master Caution.', priority: 4, tags: ['warning'] });
        st.caut = on;
      } else st[role] = on;
    }
    const apOn = st.ap1 || st.ap2;
    if (st.apWasOn && !apOn) st.apOffAt = now();
    if (st.apWasOn && !apOn && !st.onGround && cool('ap', 30000))
      notify({ kind: 'ap', title: 'Autopilot aus', message: `AP hat abgeschaltet (${Math.round(st.altFt / 100) * 100} ft). Sofort an den PC.`, priority: 5, tags: ['rotating_light'] });
    st.apWasOn = apOn;
  }
  function tick() {
    const t = now();
    // Master Warning (verzögert): nicht doppelt, wenn sie nur vom AP-Disconnect kommt
    if (st.warnPending && t - st.warnPending >= 3000) {
      const fromAp = st.apOffAt && Math.abs(st.warnPending - st.apOffAt) < 6000;
      if (st.warn && !fromAp && st.onGround === false && cool('warn', 30000)) notify({ kind: 'warning', title: 'MASTER WARNING', message: 'Im Cockpit leuchtet Master Warning. Sofort an den PC.', priority: 5, tags: ['rotating_light'] });
      st.warnPending = 0;
    }
    // Pause in der Luft
    if (st.paused) {
      if (!st.pausedSince) st.pausedSince = t;
      if (!st.pauseSent && !st.onGround && t - st.pausedSince >= cfg.pauseAfterSec * 1000) {
        notify({ kind: 'pause', title: 'Sim pausiert', message: 'Der Sim steht in der Luft auf Pause.', priority: 4, tags: ['pause_button'] });
        st.pauseSent = true;
      }
    } else { st.pausedSince = 0; st.pauseSent = false; }
    // Top of Descent
    if ((st.tod || st.todFms != null) && !st.todSent && !st.onGround && st.gsKt > 100 && st.lat != null) {
      /* Vorrang hat der TOD laut FMS (vom Nutzer eingetragen, geflogene Strecke abgezogen).
         Sonst Reststrecke bis SimBrief-TOD entlang der Route (Directs über die Flugspur), ohne Route Luftlinie zum TOD-Punkt. */
      const fms = st.todFms != null;
      const a = !fms && st.route ? along([st.lat, st.lon], st.route, st.track, now()) : null;
      const d = fms ? st.todFms : a?.dT != null ? a.dT : nm(st.lat, st.lon, st.tod[0], st.tod[1]), min = d / st.gsKt * 60;
      const closing = st.todLast == null || d < st.todLast + 0.2;
      st.todLast = d;
      /* SimBrief-TOD kann deutlich vom FMS abweichen → etwa 15 min vorher an den FMS-Wert erinnern (einmal) */
      if (!fms && !st.todHintSent && closing && min <= 15 && min > cfg.todLeadMin) {
        notify({ kind: 'tod', title: 'Bald Top of Descent – FMS-Wert eintragen', message: `Laut SimBrief noch ${Math.round(d)} NM (ca. ${Math.round(min)} min). Dein FMS kann anders rechnen: T/D vom ND oder der PROG-Seite in der App eintragen.`, priority: 3, tags: ['arrow_lower_right'] });
        st.todHintSent = true;
      }
      if (closing && d > 1 && min <= cfg.todLeadMin) {
        notify({ kind: 'tod', title: `TOD in ${Math.max(1, Math.round(min))} min${fms ? '' : ' (laut SimBrief)'}`, message: `Noch ${Math.round(d)} NM bis Top of Descent${fms ? ' laut FMS' : ' laut SimBrief – kann vom FMS abweichen'}. Sinkflug vorbereiten / anfragen.`, priority: 4, tags: ['arrow_lower_right'] });
        st.todSent = true;
      }
    }
    // Absturz-Wächter: in der Luft, aber seit 20 s keine Daten mehr vom Sim (MSFS oder FSUIPC weg)
    if (st.lastData != null && !st.onGround && !st.crashSent && t - st.lastData > 20000) {
      notify({ kind: 'crash', title: 'Sim antwortet nicht mehr', message: `Seit ${Math.round((t - st.lastData) / 1000)} s keine Daten – MSFS abgestürzt oder FSUIPC beendet? Zuletzt ${Math.round(st.altFt / 100) * 100} ft.`, priority: 5, tags: ['rotating_light'] });
      st.crashSent = true;
    }
    // Weg-Modus
    if (st.away && !st.awaySent && t - st.awaySince >= cfg.awayMin * 60000) {
      notify({ kind: 'away', title: `Seit ${cfg.awayMin} min weg`, message: 'VATSIM erlaubt max. 30 min ohne Aufsicht. Zurück an den PC.', priority: 5, tags: ['alarm_clock'], back: true });
      st.awaySent = true;
    }
  }
  function cmd(c) {
    c = String(c).trim().toLowerCase();
    if (['weg', 'away', 'w'].includes(c)) {
      st.away = true; st.awaySince = now(); st.awaySent = false;
      notify({ kind: 'info', title: 'Weg-Modus an', message: `Alarm in ${cfg.awayMin} min. Wenn du zurück bist: „Bin zurück“ tippen.`, priority: 2, tags: ['walking'], back: true });
    } else if (['da', 'zurück', 'zurueck', 'back', 'd'].includes(c)) {
      if (st.away) log('Weg-Modus aus – willkommen zurück.');
      st.away = false; st.awaySent = false;
    }
  }
  const setTod = p => { st.tod = p; st.todSent = false; st.todLast = null; st.todHintSent = false; };
  const setRoute = plan => { st.route = plan?.wps?.length ? plan : null; };
  /* TOD laut FMS: Reststrecke in NM (null = wieder SimBrief). Neuer Eintrag → Alarm darf neu kommen. */
  const setFmsTod = rem => { st.todFms = rem; };
  const todReset = () => { st.todSent = false; st.todLast = null; };
  /* Neuer Lotse voraus: höchstens einmal pro Rufzeichen und Flug; sectorLeadMin vorher */
  const told = new Set();
  function sector(info) {         // info = { cur:[…], next:{cs,freq,d,distNm,at} | null }
    if (st.onGround || st.gsKt < 80 || !info) return;
    const n = info.next;
    if (n && !told.has(n.cs)) {
      const min = n.distNm / st.gsKt * 60;
      if (min <= (cfg.sectorLeadMin ?? 5)) {
        told.add(n.cs);
        notify({ kind: 'sector', title: `In ${Math.max(1, Math.round(min))} min: ${n.d}`, message: `${n.freq} · ${n.cs} (ab ${n.at}). Erstanruf vorbereiten.`, priority: 4, tags: ['radio'] });
      }
    }
    for (const c of info.cur || []) if (!told.has(c.cs)) {     // Lotse ist gerade online gekommen und ist schon zuständig
      told.add(c.cs);
      if (st.sectorStarted) notify({ kind: 'sector', title: `Jetzt zuständig: ${c.d}`, message: `${c.freq} · ${c.cs}. Bitte melden.`, priority: 4, tags: ['radio'] });
    }
    st.sectorStarted = true;      // beim ersten Durchlauf schon bekannte Lotsen nicht melden
  }
  /* Anflug-Monitor: umgerechnete Zusatzwerte (Gruppe „anf“) */
  function anf(d) { Object.assign(st, anfConvert(d)); }
  return { st, offsets, vars, tick, cmd, setTod, setRoute, setFmsTod, todReset, sector, anf };
}

/* ---------- Logbuch: Off-Block, Start, Landung (Aufsetzrate + G), On-Block ----------
   update(st) jede Sekunde aufrufen. Aufsetzrate kommt aus dem Sim (FSUIPC 0x030C, beim Aufsetzen festgehalten),
   G = höchster Wert in den 3 s nach dem Aufsetzen. Gespeichert in bridge/logbook.json. */
export const grade = fpm => { const a = Math.abs(fpm); return a < 100 ? 'butterweich' : a < 240 ? 'gut' : a < 400 ? 'fest' : 'hart'; };
export function makeLogbook({ file = path.join(DIR, 'logbook.json'), notify, now = () => Date.now(), plan = () => ({}), onChange } = {}) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
  let f = null, wasGround = null, td = null, still = 0;
  /* Der laufende Flug liegt zusätzlich in logbook-current.json: Neustart oder Absturz der Bridge im Flug
     verliert ihn nicht mehr (vorher fehlte dann der ganze Flug). Älter als 12 h → verworfen. */
  const curFile = file.replace(/\.json$/, '') + '-current.json';
  try { const c = JSON.parse(fs.readFileSync(curFile, 'utf8')); if (c?.f && now() - (c.saved || 0) < 12 * 3600000) f = c.f; } catch { }
  const saveCur = () => { try { if (f) fs.writeFileSync(curFile, JSON.stringify({ f, saved: now() })); else fs.rmSync(curFile, { force: true }); } catch { } };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(list, null, 1)); } catch { } onChange?.(list); };
  const start = (st, partial) => { const p = plan(); f = { id: now().toString(36), date: new Date(now()).toISOString(), cs: p.cs || '', type: p.type || '', dep: p.dep || '', arr: p.arr || '', offBlock: partial ? null : now(), fuelOutLbs: partial ? null : st.fuelLbs ?? null, ...(partial ? { partial: true } : {}) }; saveCur(); };
  function update(st) {
    if (st.lat == null || !st.simSeen) return;
    const t = now(), g = !!st.onGround;
    if (!f && wasGround === null && !g && st.gsKt > 80) start(st, true);   // Bridge startet in der Luft ohne gesicherten Flug → Teilflug, damit die Landung zählt
    if (!f && g && st.gsKt > 3) start(st);                                  // rollt los → Off-Block
    if (wasGround === true && !g && st.gsKt > 40) { if (!f) start(st); if (!f.takeoff) { f.takeoff = t; saveCur(); } }     // abgehoben
    if (wasGround === false && g && f && (f.takeoff || f.partial) && !td) td = { t, vs: st.tdVs ?? st.vsFpm ?? 0, g: st.g ?? 1, bounces: 0 };   // aufgesetzt
    if (td && !f.landing) {
      if (t - td.t <= 3500) {
        td.g = Math.max(td.g, st.g ?? 1); if (st.tdVs != null) td.vs = st.tdVs;
        if (!g && !td.air) { td.bounces++; td.air = true; } if (g) td.air = false;
      }
      else {
        f.landing = td.t; f.fpm = -Math.abs(Math.round(td.vs)); f.g = Math.round(td.g * 100) / 100; f.bounces = td.bounces; f.grade = grade(f.fpm); saveCur();
        const ft = f.takeoff ? Math.round((f.landing - f.takeoff) / 60000) : null;
        notify({ kind: 'landing', title: `Gelandet${f.arr ? ' in ' + f.arr : ''} · ${f.fpm} fpm`, message: `${f.grade} · ${f.g.toFixed(2)} G${f.bounces ? ' · ' + f.bounces + '× gesprungen' : ''}${ft != null ? ` · Flugzeit ${Math.floor(ft / 60)}:${String(ft % 60).padStart(2, '0')}` : ''}`, priority: 3, tags: ['airplane_arriving'] });
      }
    }
    if (f && f.landing) {                                                    // steht 30 s → On-Block, Flug speichern
      still = st.gsKt < 1 ? (still || t) : 0;
      if (still && t - still > 30000) { f.onBlock = t; f.fuelInLbs = st.fuelLbs ?? null; list.unshift(f); list = list.slice(0, 200); f = null; td = null; still = 0; save(); saveCur(); }
    }
    wasGround = g;
  }
  /* Bridge wird beendet: gelandeten Flug sichern; ein noch laufender Flug bleibt in logbook-current.json und geht nach dem Neustart weiter */
  function flush() { if (f && f.landing) { f.onBlock = now(); list.unshift(f); f = null; save(); saveCur(); } }
  return { update, flush, list: () => list, current: () => f };
}

/* ---------- SimBrief: TOD-Punkt aus dem letzten OFP ---------- */
export async function loadTod(user, fetchImpl = fetch) {
  const j = await (await fetchImpl('https://www.simbrief.com/api/xml.fetcher.php?json=1&username=' + encodeURIComponent(user))).json();
  if (j.fetch?.status && j.fetch.status !== 'Success') throw new Error(j.fetch.status);
  let fx = j.navlog?.fix || []; if (!Array.isArray(fx)) fx = [fx];
  const t = fx.find(x => String(x.ident).toUpperCase() === 'TOD');
  let cum = 0, todCum = null;
  const wps = fx.map(x => {
    cum += +x.distance || 0; if (x === t) todCum = cum;
    return x.pos_lat && x.type !== 'apt' ? [+x.pos_lat, +x.pos_long, x.ident, cum, x.fuel_plan_onboard != null ? +x.fuel_plan_onboard : null] : null;
  }).filter(Boolean);
  const g = j.general || {};
  return {
    flight: `${j.atc?.callsign || ''} ${j.origin?.icao_code || ''} → ${j.destination?.icao_code || ''}`.trim(), tod: t ? [+t.pos_lat, +t.pos_long] : null, wps,
    total: cum || null, todCum, crz: +(g.initial_altitude || 0), arrElev: +(j.destination?.elevation || 0),
    cs: (j.atc?.callsign || ((g.icao_airline || '') + (g.flight_number || ''))).toUpperCase(), type: j.aircraft?.icaocode || '',
    dep: j.origin?.icao_code || '', arr: j.destination?.icao_code || '', units: String(j.params?.units || 'kgs').toLowerCase(),
    arrRwy: String(j.destination?.plan_rwy || '').toUpperCase(),
    arrPos: j.destination?.pos_lat ? [+j.destination.pos_lat, +j.destination.pos_long] : null
  };
}

/* TOD laut FMS: vom Nutzer eingetragene NM bis zum T/D (ND / PROG-Seite). Jede Sekunde wird die geflogene
   Strecke abgezogen; Sprünge über 5 NM (Slew, Teleport) zählen nicht. */
export function makeFmsTod() {
  let s = null;
  return {
    set(nmVal, pos) { s = { nm: nmVal, flown: 0, last: pos && pos[0] != null ? [pos[0], pos[1]] : null }; },
    clear() { s = null; },
    update(pos) {
      if (!s || !pos || pos[0] == null) return;
      if (s.last) { const d = nm(s.last[0], s.last[1], pos[0], pos[1]); if (d < 5) s.flown += d; }
      s.last = [pos[0], pos[1]];
    },
    get remaining() { return s ? s.nm - s.flown : null; },
    get entered() { return s ? s.nm : null; }
  };
}
/* Flugspur: Kurs aus den Positionen der letzten ~90 s ({lat, lon, t}); null, wenn zu wenig Bewegung */
export function trackBrg(track, now = Date.now()) {
  const pts = (track || []).filter(p => now - p.t <= 90000);
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  if (nm(a.lat, a.lon, b.lat, b.lon) < 0.5) return null;
  return brg(a.lat, a.lon, b.lat, b.lon);
}
/* Welchen Wegpunkt fliegt man gerade an? Bei Direct liegt der nächste Punkt auf der Route oft nicht vorn:
   dann den Punkt wählen, auf den die Spur zeigt (≤ 20° Abweichung, der nächste davon). null → Nächster-Punkt-Logik. */
export function activeWp(me, plan, track, now) {
  const W = plan?.wps || [], tb = trackBrg(track, now);
  if (!W.length || tb == null) return null;
  let bi = 0, bd = 1e9; W.forEach((w, i) => { const d = nm(me[0], me[1], w[0], w[1]); if (d < bd) { bd = d; bi = i; } });
  let best = null, bestD = 1e9;
  for (let k = Math.max(0, bi - 3); k < W.length; k++) {
    const d = nm(me[0], me[1], W[k][0], W[k][1]);
    if (d < 0.5) continue;
    if (Math.abs(adiff(brg(me[0], me[1], W[k][0], W[k][1]), tb)) <= 20 && d < bestD) { bestD = d; best = k; }
  }
  return best;
}
/* Rest entlang der Route (wie in der Handy-App): NM bis Ziel und bis TOD ab Position me.
   track (optional): Spur der letzten Minuten – damit wird ein Direct erkannt. */
export function along(me, plan, track, now) {
  const W = plan?.wps; if (!W?.length || !plan.total) return null;
  let bi = 0, bd = 1e9; W.forEach((w, i) => { const d = nm(me[0], me[1], w[0], w[1]); if (d < bd) { bd = d; bi = i; } });
  let nx = bi; if (bi < W.length - 1 && nm(me[0], me[1], W[bi + 1][0], W[bi + 1][1]) < nm(W[bi][0], W[bi][1], W[bi + 1][0], W[bi + 1][1])) nx = bi + 1;
  const kd = activeWp(me, plan, track, now); if (kd != null) nx = kd;
  const base = nm(me[0], me[1], W[nx][0], W[nx][1]) - W[nx][3];
  const todCum = plan.todCum ?? (plan.crz ? plan.total - Math.max(0, (plan.crz - plan.arrElev) * 3 / 1000) : null);
  return { dA: plan.total + base, dT: todCum != null ? todCum + base : null, passed: nx > 0 ? W[nx - 1] : null };
}

/* Fuel-Check gegen den SimBrief-Plan: am zuletzt überflogenen Wegpunkt; Warnung, wenn deutlich weniger an Bord */
export function fuelCheck(st, plan) {
  if (st.fuelLbs == null || st.onGround || st.lat == null) return null;
  const a = along([st.lat, st.lon], plan); const wp = a?.passed; if (!wp || wp[4] == null) return null;
  const kg = plan.units.startsWith('kg'), have = kg ? st.fuelLbs * 0.453592 : st.fuelLbs, want = wp[4];
  const limit = Math.max(kg ? 500 : 1100, want * 0.08);
  return { have: Math.round(have), want: Math.round(want), at: wp[2], low: have < want - limit, unit: kg ? 'kg' : 'lbs' };
}

/* ATIS am Ziel: Buchstabe, Pisten, QNH aus dem VATSIM-Feed */
export function atisInfo(atisList, icao) {
  icao = (icao || '').toUpperCase(); if (!icao) return null;
  const a = atisList.find(x => x.callsign.split('_')[0] === icao && /_A_/.test(x.callsign)) || atisList.find(x => x.callsign.split('_')[0] === icao);
  if (!a) return null;
  const txt = (a.text_atis || []).join(' ');
  const rws = [...new Set([...txt.matchAll(/(?:RUNWAY|RWY)S?\s*(?:IN USE\s*)?(?:FOR\s+(?:LANDING|ARRIVAL)S?\s*)?((?:\d{2}\s?[LRC]?\b(?:\s*(?:AND|,|\/)?\s*)?)+)/gi)].flatMap(m => [...m[1].matchAll(/\d{2}\s?[LRC]?/g)].map(r => r[0].replace(/\s/g, '').toUpperCase())))];
  const q = txt.match(/QNH\s*(\d{3,4})/i) || txt.match(/\bQ(\d{4})\b/);
  return { cs: a.callsign, code: a.atis_code || '', rws, qnh: q ? q[1] : '', freq: a.frequency };
}
/* Wen nach dem Start rufen? Deutsche VATSIM-ATIS sagen es meist selbst:
   „WHEN AIRBORNE CONTACT BREMEN RADAR ON FREQ 126.325“, „WHEN PASSING 2000FT CONTACT BREMEN RADAR 120.540“.
   Bevorzugt die Abflug-ATIS (_D_). Gleiche Regel steht in handy/index.html (atisDep) und index.html. */
export function atisDep(atisList, icao) {
  icao = (icao || '').toUpperCase(); if (!icao) return null;
  const mine = atisList.filter(x => x.callsign.split('_')[0] === icao);
  const a = mine.find(x => /_D_/.test(x.callsign)) || mine.find(x => !/_A_/.test(x.callsign)) || mine[0];
  if (!a) return null;
  const txt = (a.text_atis || []).join(' ').toUpperCase().replace(/\s+/g, ' ');
  const m = txt.match(/(?:WHEN (?:AIRBORNE|AIRBORN|PASSING [\d ]+ ?(?:FT|FEET)?)|AFTER (?:DEPARTURE|TAKE ?OFF))[^.]*?CONTACT ([A-Z][A-Z ]*?)\s+(?:ON\s+)?(?:FREQ(?:UENCY)?\s+)?(1[1-3]\d[.,]\d{1,3})/);
  if (!m) return null;
  const freq = m[2].replace(',', '.').padEnd(7, '0').slice(0, 7);
  const name = m[1].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return { cs: a.callsign, name, freq };
}

/* ---------- Landebahnen (OurAirports, gemeinfrei) für den Anflug-Monitor ----------
   runways.csv (~4 MB) einmal laden, 30 Tage auf der Platte. Pro Flughafen nur bei Bedarf ausgewertet. */
const RWY_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
export function makeRunways({ cacheDir = path.join(DIR, 'runway-cache'), fetchImpl = fetch } = {}) {
  let csv = null; const byApt = {};
  async function load() {
    const f = path.join(cacheDir, 'runways.csv');
    try { if (Date.now() - fs.statSync(f).mtimeMs < 30 * 864e5) { csv = fs.readFileSync(f, 'utf8'); return; } } catch { }
    const r = await fetchImpl(RWY_URL); if (!r.ok) throw new Error('runways.csv ' + r.status);
    csv = await r.text();
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(f, csv); } catch { }
  }
  /* Schwelle eines Bahnendes; versetzte Schwelle (displaced) wird entlang der Bahn nach innen verschoben */
  const end = (id, lat, lon, elev, hdg, disp, len) => {
    if (!id || lat === '' || lon === '') return null;
    let la = +lat, lo = +lon; const d = (+disp || 0) / 6076.12;   // ft → NM
    if (d > 0 && hdg !== '') { const h = +hdg * Math.PI / 180; la += d * Math.cos(h) / 60; lo += d * Math.sin(h) / (60 * Math.cos(la * Math.PI / 180)); }
    return { id: id.toUpperCase(), lat: la, lon: lo, elev: elev === '' ? null : +elev, hdg: hdg === '' ? null : +hdg, lenFt: +len || null };
  };
  function airport(icao) {
    icao = (icao || '').toUpperCase(); if (!csv || !icao) return [];
    if (byApt[icao]) return byApt[icao];
    const out = [], key = `,"${icao}",`;
    let i = csv.indexOf(key);
    while (i >= 0) {
      const s = csv.lastIndexOf('\n', i) + 1, e = csv.indexOf('\n', i);
      const p = csv.slice(s, e < 0 ? undefined : e).replace(/\r$/, '').split(',').map(x => x.replace(/^"|"$/g, ''));
      // id, airport_ref, ident, length, width, surface, lighted, closed, le_ident, le_lat, le_lon, le_elev, le_hdg, le_disp, he_ident, he_lat, he_lon, he_elev, he_hdg, he_disp
      if (p[2] === icao && p[7] !== '1') {
        const a = end(p[8], p[9], p[10], p[11], p[12], p[13], p[3]), b = end(p[14], p[15], p[16], p[17], p[18], p[19], p[3]);
        if (a) out.push(a); if (b) out.push(b);
      }
      i = csv.indexOf(key, i + key.length);
    }
    return (byApt[icao] = out);
  }
  const norm = r => String(r || '').toUpperCase().replace(/^RW/, '').replace(/^(\d)([LRC]?)$/, '0$1$2');
  const lookup = (icao, rwy) => airport(icao).find(r => r.id === norm(rwy)) || null;
  return { load, airport, lookup, get ok() { return !!csv; } };
}

/* Welche Bahn gilt? Von Hand gewählt > ATIS (geplante Bahn nicht aktiv → erste aktive) > SimBrief-Plan.
   src sagt, woher sie kommt (für die Anzeige im Monitor). */
export function pickRunway(rw, icao, planned, atis, manual) {
  const list = rw.airport(icao); if (!list.length) return null;
  if (manual) { const m = rw.lookup(icao, manual); if (m) return { ...m, src: 'manual' }; }
  const act = (atis?.rws || []).map(r => rw.lookup(icao, r)).filter(Boolean);
  const p = planned ? rw.lookup(icao, planned) : null;
  if (act.length && !(p && act.some(a => a.id === p.id))) return { ...act[0], src: 'atis' };
  return p ? { ...p, src: 'plan' } : act[0] ? { ...act[0], src: 'atis' } : null;
}

/* ---------- Sektoren (VATSpy) + Online-Lotsen: „In X min neuer Lotse“ ----------
   Gleiche Logik wie im EFB (A4). Daten von raw.githubusercontent.com, 7 Tage auf der Platte gecacht. */
const VSP = 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/';
export function makeSectors({ cacheDir = path.join(DIR, 'vatspy-cache'), fetchImpl = fetch } = {}) {
  const S = { ok: false, firs: [], uirs: {}, poly: {}, map: {} };
  async function get(n) {
    const f = path.join(cacheDir, n);
    try { if (Date.now() - fs.statSync(f).mtimeMs < 7 * 864e5) return fs.readFileSync(f, 'utf8'); } catch { }
    const r = await fetchImpl(VSP + n); if (!r.ok) throw new Error(n + ' ' + r.status);
    const t = await r.text();
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(f, t); } catch { }
    return t;
  }
  function parse(dat, geo) {
    let sec = '';
    for (const raw of dat.split(/\r?\n/)) {
      const l = raw.trim(); if (!l || l[0] === ';') continue; if (l[0] === '[') { sec = l; continue; }
      const p = l.split('|');
      if (sec === '[FIRs]' && p.length >= 4) S.firs.push({ icao: p[0], name: p[1], pre: p[2] || p[0], bnd: p[3] || p[0] });
      if (sec === '[UIRs]' && p.length >= 3) S.uirs[p[0]] = { name: p[1], firs: p[2].split(',') };
    }
    for (const ft of JSON.parse(geo).features) {
      const g = ft.geometry, id = ft.properties.id; if (!g) continue;
      const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
      (S.poly[id] = S.poly[id] || []).push(...polys.map(pl => { const ring = pl[0]; let a = 1e9, b = -1e9, c = 1e9, d = -1e9; for (const [x, y] of ring) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); } return { ring, bb: [a, b, c, d] }; }));
    }
    S.ok = true;
  }
  async function load() { const [dat, geo] = await Promise.all([get('VATSpy.dat'), get('Boundaries.geojson')]); parse(dat, geo); }
  const inPoly = (lat, lon, P) => { const [a, b, c, d] = P.bb; if (lon < a || lon > b || lat < c || lat > d) return false; let r = false; const R = P.ring; for (let i = 0, j = R.length - 1; i < R.length; j = i++) { const [xi, yi] = R[i], [xj, yj] = R[j]; if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) r = !r; } return r; };
  const inBnd = (id, pt) => (S.poly[id] || []).some(P => inPoly(pt[0], pt[1], P));
  function ctlSec(cs) {
    if (S.map[cs]) return S.map[cs];
    const p = cs.toUpperCase().split('_'), p1 = p[0], p2 = p.length > 2 ? p[0] + '_' + p[1] : '';
    let rows = p2 ? S.firs.filter(f => f.pre === p2) : [], rank = 3;
    if (!rows.length) { rows = S.firs.filter(f => f.pre === p1 && f.bnd === f.icao); rank = 2; }
    if (!rows.length) { rows = S.firs.filter(f => f.pre === p1); rank = 2; }
    if (!rows.length && S.uirs[p1]) { const u = S.uirs[p1]; rows = u.firs.map(i => S.firs.find(f => f.icao === i && f.bnd === i) || S.firs.find(f => f.icao === i)).filter(Boolean).map(f => ({ ...f, name: u.name })); rank = 1; }
    let n = (rows[0]?.name || p1).split(' - ')[0].trim().replace(/\bACC\b/, 'Radar');
    if (!/radar|control|centre|center|information/i.test(n)) n = n.replace(/^([^(]*?)(\s*\(|$)/, '$1 Radar$2');
    return S.map[cs] = { bnd: [...new Set(rows.map(r => r.bnd))], rank, d: n };
  }
  /** Center über einem Punkt (ohne FIS); bei mehreren nur die genaueste Ebene */
  function covers(pt, ctl) {
    if (!S.ok || !pt) return [];
    const out = ctl.filter(c => (c.facility === 6 || c.facility === 1) && !/_FIS_/.test(c.callsign)).map(c => ({ c, m: ctlSec(c.callsign) })).filter(x => x.m.bnd.some(id => inBnd(id, pt)));
    const top = Math.max(0, ...out.map(x => x.m.rank));
    return out.filter(x => x.m.rank === top).map(x => ({ cs: x.c.callsign, freq: x.c.frequency, d: x.m.d }));
  }
  /** Nächster anderer Center entlang der Route ab Position me: { …, distNm, at } */
  function next(me, wps, ctl) {
    if (!wps?.length) return null;
    let bi = 0, bd = 1e9; wps.forEach((w, i) => { const d = nm(me[0], me[1], w[0], w[1]); if (d < bd) { bd = d; bi = i; } });
    let nx = bi; if (bi < wps.length - 1 && nm(me[0], me[1], wps[bi + 1][0], wps[bi + 1][1]) < nm(wps[bi][0], wps[bi][1], wps[bi + 1][0], wps[bi + 1][1])) nx = bi + 1;
    const cur = new Set(covers(me, ctl).map(x => x.cs)), base = nm(me[0], me[1], wps[nx][0], wps[nx][1]) - (wps[nx][3] || 0);
    for (let k = nx; k < wps.length; k++) {
      const cv = covers(wps[k], ctl);
      if (cv.length && !cv.some(x => cur.has(x.cs))) return { ...cv[0], distNm: Math.max(0, (wps[k][3] || 0) + base), at: wps[k][2] };
    }
    return null;
  }
  return { load, covers, next, get ok() { return S.ok; } };
}

/* ---------- FSUIPC WebSocket Server ---------- */
const OFFSETS = [
  { name: 'lat', address: 0x0560, type: 'lat', size: 8 },
  { name: 'lon', address: 0x0568, type: 'lon', size: 8 },
  { name: 'alt', address: 0x0570, type: 'int', size: 8 },
  { name: 'gs', address: 0x02B4, type: 'int', size: 4 },
  { name: 'onGround', address: 0x0366, type: 'uint', size: 2 },
  { name: 'paused', address: 0x0264, type: 'uint', size: 2 },
  { name: 'vs', address: 0x02C8, type: 'int', size: 4 },       // Steigrate: m/s × 256
  { name: 'tdVs', address: 0x030C, type: 'int', size: 4 },     // Steigrate beim Aufsetzen (vom Sim festgehalten)
  { name: 'g', address: 0x11BA, type: 'int', size: 2 },        // G-Kraft × 624
  { name: 'fuel', address: 0x126C, type: 'uint', size: 4 }     // Sprit gesamt in lbs
];
const CTL = [{ name: 'pause', address: 0x0262, type: 'uint', size: 2 }];   // 1 = Pause an, 0 = aus (schreiben)
/* Anflug-Monitor, Schritt 1: Adressen teils aus dem Gedächtnis – nur Rohwerte, noch nicht umgerechnet.
   Eigene Gruppe „anf“, damit ein falscher Offset nicht die Hauptdaten (pos) kaputt macht. */
const ANF = [
  { name: 'ias', address: 0x02BC, type: 'uint', size: 4 },       // IAS × 128 (vermutlich)
  { name: 'hdg', address: 0x0580, type: 'uint', size: 4 },       // Kurs (wahr?) – prüfen
  { name: 'windSpd', address: 0x0E90, type: 'uint', size: 2 },   // Wind kt (vermutlich)
  { name: 'windDir', address: 0x0E92, type: 'uint', size: 2 },   // Windrichtung – prüfen
  { name: 'flapLever', address: 0x0BDC, type: 'uint', size: 2 }, // Klappenhebel – prüfen (Fenix evtl. nicht)
  { name: 'gearLever', address: 0x0BE8, type: 'uint', size: 2 }, // Fahrwerkshebel – prüfen
  { name: 'spdbrk', address: 0x0BD0, type: 'uint', size: 2 },    // Speedbrake – prüfen
  { name: 'radAlt', address: 0x31E4, type: 'uint', size: 4 },    // Radarhöhe – prüfen
  { name: 'gross', address: 0x30C0, type: 'float', size: 8 }     // Gewicht in lbs (Gleitkomma) – prüfen
];
/* Umrechnung der Rohwerte – Faktoren aus der FSUIPC-Offset-Liste (aus dem Gedächtnis, beim ersten Anflug
   mit anflug-werte.txt gegen die Cockpit-Anzeige prüfen). Fehlt ein Wert, bleibt das Feld weg. */
export function anfConvert(d) {
  const o = {}, ok = x => x != null && Number.isFinite(+x);
  if (ok(d.ias)) o.iasKt = d.ias / 128;
  if (ok(d.hdg)) o.hdg = (d.hdg * 360 / 4294967296 + 360) % 360;
  if (ok(d.windSpd)) o.windKt = +d.windSpd;
  if (ok(d.windDir)) o.windDir = (d.windDir * 360 / 65536 + 360) % 360;
  if (ok(d.flapLever)) o.flaps = Math.max(0, Math.min(4, Math.round(d.flapLever / 4096)));      // 0 / 1 / 2 / 3 / FULL
  if (ok(d.gearLever)) o.gear = d.gearLever > 8000;
  if (ok(d.spdbrk)) o.spdbrk = d.spdbrk <= 4800 ? 0 : Math.min(1, (d.spdbrk - 4800) / (16383 - 4800));   // 4800 = armed
  if (ok(d.radAlt)) o.raFt = d.radAlt / 65536 * 3.28084;
  if (ok(d.gross) && d.gross > 1000) o.weightKg = d.gross * 0.453592;
  return o;
}
let anfLast = 0;
function writeAnflug(d) {
  if (Date.now() - anfLast < 2000) return;   // höchstens alle 2 s schreiben
  anfLast = Date.now();
  const lines = ANF.map(o => `  ${o.name.padEnd(10)} ${String(d[o.name]).padStart(10)}   (0x${o.address.toString(16).toUpperCase()})`);
  try { fs.writeFileSync(ANF_FILE, `Rohwerte ${new Date().toLocaleString('de-DE')}\n\n${lines.join('\n')}\n`); } catch { }
}
export function connectSim(cfg, mon, WS = globalThis.WebSocket) {
  let ws = null, names = null, declared = false, waitLogged = false, warned = false;
  const state = { ws: false, sim: false, fenix: false };
  const retry = {};
  const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const cmds = {
    'offsets.declare': () => send({ command: 'offsets.declare', name: 'pos', offsets: OFFSETS }),
    'offsets.read': () => send({ command: 'offsets.read', name: 'pos', interval: 500 }),
    'vars.list': () => send({ command: 'vars.list', name: 'list', notify: 'auto' }),
    'vars.declare': () => send({ command: 'vars.declare', name: 'fenix', vars: Object.values(names).filter(Boolean).map(n => ({ name: n })) }),
    'vars.read': () => send({ command: 'vars.read', name: 'fenix', interval: 250 }),
    'anf.declare': () => send({ command: 'offsets.declare', name: 'anf', offsets: ANF }),
    'anf.read': () => send({ command: 'offsets.read', name: 'anf', interval: 1000 })
  };
  const later = c => { if (retry[c]) return; retry[c] = setTimeout(() => { retry[c] = null; cmds[c](); }, 10000); };
  function onMsg(r) {
    if (!r.success) {
      if (r.errorCode === 'NoFlightSim') {
        state.sim = false;
        if (!waitLogged) { log('Warte auf den Sim (MSFS + FSUIPC7 starten) …'); waitLogged = true; }
        if (cmds[r.command]) later(r.command);
        return;
      }
      if (/NOTOPEN/i.test(r.errorMessage || '')) return;   // Sim noch nicht offen – wird beim Verbinden erneut abgefragt
      if (r.errorCode !== 'DuplicateName') { log(`Fehler ${r.command}: ${r.errorCode} – ${r.errorMessage}`); return; }
    }
    switch (r.command) {
      case 'about.read': if (r.data) log(`FSUIPC ${r.data.FSUIPCVersion || '?'} · Server ${r.data.FSUIPCWebSocketServerVersion || '?'} · Sim ${r.data.isConnectionOpen ? 'verbunden' : 'noch nicht verbunden'}`); break;
      case 'offsets.declare':
        if (r.name === 'pos') { cmds['offsets.read'](); cmds['anf.declare'](); }   // anf hängt an pos: kommt der Sim später, wird es mit neu angemeldet
        else if (r.name === 'anf') cmds['anf.read']();
        break;
      case 'offsets.read': if (r.data && r.name === 'pos') {
        if (!state.sim) { send({ command: 'about.read', name: 'about' }); if (!declared) cmds['vars.list'](); }   // Sim gerade verbunden
        state.sim = true; if (waitLogged) { log('Sim verbunden.'); waitLogged = false; } mon.offsets(r.data);
      } else if (r.data && r.name === 'anf') { writeAnflug(r.data); mon.anf?.(r.data); }
        break;
      case 'vars.list': {
        const list = r.data?.lvars || [];
        const picked = pickLvars(list, cfg.lvars);
        const cand = lvarCandidates(list);
        try { fs.writeFileSync(LVAR_FILE, `Gefunden ${new Date().toLocaleString('de-DE')} – ${list.length} L-Vars\n\nGewählt:\n${Object.entries(picked).map(([k, v]) => `  ${k}: ${v || '(nichts gefunden)'}`).join('\n')}\n\nKandidaten:\n${cand.join('\n')}\n`); } catch { }
        if (!names || JSON.stringify(picked) !== JSON.stringify(names)) {
          names = picked;
          log(`Fenix-Werte: Warning=${picked.warning || '–'} · Caution=${picked.caution || '–'} · AP1=${picked.ap1 || '–'} · AP2=${picked.ap2 || '–'}`);
          if (!declared && Object.values(picked).some(Boolean)) cmds['vars.declare']();
          else if (!Object.values(picked).some(Boolean)) log('Noch keine Fenix-Werte – ist der Fenix geladen? Die Liste wird automatisch neu geprüft.');
        }
        break;
      }
      case 'vars.declare': declared = true; state.fenix = true; cmds['vars.read'](); break;
      case 'vars.read': if (r.data && names) mon.vars(r.data, names); break;
    }
  }
  function open() {
    try { ws = new WS(cfg.wsUrl, 'fsuipc'); } catch (e) { log('WebSocket-Fehler:', e.message); setTimeout(open, 5000); return; }
    ws.onopen = () => {
      state.ws = true;
      log('Verbunden mit dem FSUIPC WebSocket Server.');
      send({ command: 'about.read', name: 'about' });
      cmds['offsets.declare'](); cmds['vars.list']();
    };
    ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch (err) { log('Antwort nicht lesbar:', err.message); } };
    ws.onclose = () => {
      const was = state.ws; Object.assign(state, { ws: false, sim: false, fenix: false });
      if (was || !warned) { warned = true; log('FSUIPC WebSocket Server nicht erreichbar – läuft er? (FSUIPC7 → Add-ons → WebSocket Server). Neue Versuche alle 5 s.'); }
      names = null; declared = false; for (const k in retry) { clearTimeout(retry[k]); retry[k] = null; }
      setTimeout(open, 5000);
    };
    ws.onerror = () => { };
  }
  open();
  /* Fernsteuerung: Sim pausieren / weiter (FSUIPC-Offset 0x0262) */
  function pause(on) {
    if (!state.sim) return false;
    send({ command: 'offsets.declare', name: 'ctl', offsets: CTL });    // doppelt deklarieren ist harmlos (DuplicateName)
    send({ command: 'offsets.write', name: 'ctl', offsets: [{ name: 'pause', value: on ? 1 : 0 }] });
    return true;
  }
  return { state, pause, close: () => ws?.close() };
}

/* ---------- Start ---------- */
async function main() {
  const cfg = loadConfig();
  if (process.stdin.isTTY) {
    console.log('\n  EFB Bridge – Sim-Warnungen aufs Handy\n  ─────────────────────────────────────');
    console.log(`  ntfy-Kanal: ${cfg.topic}`);
    console.log('  Tasten: W = weg · D = wieder da · T = Test-Nachricht · S = Status · Q = beenden\n');
  } else log(`ntfy-Kanal: ${cfg.topic}`);
  if (cfg._new) log('NEU: Handy über „Handy koppeln“ (QR-Code) mit der App EFB Wächter verbinden.');
  const ntfy = makeNtfy(cfg);
  let mon = null, sim = null, plan = null, ctl = [], atisList = [];
  const vp = { cs: '', connected: false };
  /* Jeder Alarm geht doppelt raus – WLAN direkt und ntfy – mit derselben ID; die App nimmt den ersten.
     from = Absender einer Lotsen-Nachricht (für „Antworten“ in der App) */
  const notify = n => {
    const aid = crypto.randomBytes(5).toString('hex');
    lan.alarm({ aid, kind: n.kind || 'info', title: n.title, message: n.message, priority: n.priority || 3, t: Date.now(), from: n.from || '' });
    ntfy.send({ ...n, aid, tags: [...(n.tags || []), ...(n.from ? ['from-' + n.from] : [])] });
  };
  /* Befehle vom Handy (WLAN, ntfy) und aus der Tray-App */
  function handleCmd(raw) {
    const c = String(raw).trim(), lc = c.toLowerCase();
    log('Befehl:', c.length > 80 ? c.slice(0, 80) + '…' : c);
    const needVp = () => { if (!lan.vpilotOnline()) notify({ kind: 'atis', title: 'vPilot-Plugin nicht verbunden', message: 'Läuft vPilot mit dem EFB-Plugin? Der Befehl wird gesendet, sobald es da ist.', priority: 3 }); };
    if (['weg', 'w', 'away', 'da', 'd', 'back', 'zurück'].includes(lc)) mon.cmd(lc);
    else if (lc === 'pause' || lc === 'resume' || lc === 'weiter') {
      const on = lc === 'pause';
      if (!sim.pause(on)) notify({ kind: 'atis', title: 'Pause geht gerade nicht', message: 'Der Sim ist nicht verbunden.', priority: 3 });
      else log(on ? 'Sim pausiert (vom Handy).' : 'Sim läuft weiter (vom Handy).');
    }
    else if (lc === 'ident') { needVp(); lan.vpilot({ cmd: 'ident' }); }
    else if (lc.startsWith('pm:')) {                       // pm:<an>:<text>
      const rest = c.slice(3), i = rest.indexOf(':');
      if (i > 0) { needVp(); lan.vpilot({ cmd: 'pm', to: rest.slice(0, i).trim().toUpperCase(), text: rest.slice(i + 1).trim().slice(0, 240) }); }
    }
    else if (lc.startsWith('atis:')) { const icao = c.slice(5).trim().toUpperCase(); needVp(); lan.vpilot({ cmd: 'atis', station: atisInfo(atisList, icao)?.cs || icao + '_ATIS' }); }
    else if (lc.startsWith('metar:')) { needVp(); lan.vpilot({ cmd: 'metar', station: c.slice(6).trim().toUpperCase() }); }
    /* Anflug-Monitor: Bahn / Vapp von Hand („auto“ = wieder automatisch) */
    else if (lc.startsWith('rwy:')) { const r = c.slice(4).trim().toUpperCase(); enHand.rwy = /^\d{1,2}[LRC]?$/.test(r) ? r : null; log(`Anflug-Bahn: ${enHand.rwy || 'automatisch'}`); }
    else if (lc.startsWith('vapp:')) { const n = parseInt(c.slice(5), 10); enHand.vapp = n >= 100 && n <= 180 ? n : null; log(`Vapp: ${enHand.vapp || 'geschätzt'}`); }
    /* TOD laut FMS: NM bis T/D vom ND / PROG-Seite („auto“ = wieder SimBrief) */
    else if (lc.startsWith('tod:')) {
      const v = c.slice(4).trim().toLowerCase(), n = parseFloat(v.replace(',', '.'));
      if (v === 'auto') { fmsTod.clear(); mon.setFmsTod(null); mon.todReset(); log('TOD: wieder laut SimBrief'); }
      else if (n > 0 && n <= 400) { fmsTod.set(n, [mon.st.lat, mon.st.lon]); mon.setFmsTod(n); mon.todReset(); log(`TOD laut FMS: ${n} NM`); }
    }
  }
  const enHand = { rwy: null, vapp: null };
  const fmsTod = makeFmsTod();
  /* Ereignisse vom vPilot-Plugin: Nachrichten, SELCAL, Verbindung, ATIS/METAR-Antworten */
  function onVpilot(e) {
    const me = (vp.cs || plan?.cs || '').toUpperCase();
    if (e.type === 'connected') { vp.cs = String(e.callsign || ''); vp.connected = true; log(`vPilot verbunden als ${vp.cs}.`); }
    else if (e.type === 'disconnected' || e.type === 'ended') {
      // am Boden = meist selbst getrennt (am Gate) → kein Alarm; in der Luft = Verbindung weg oder vPilot zu
      if (vp.connected && mon.st.onGround === false) notify({ kind: 'vatsim', title: e.type === 'ended' ? 'vPilot wurde beendet' : 'Von VATSIM getrennt', message: 'Du bist nicht mehr mit dem Netz verbunden. Neu verbinden, sonst bist du für die Lotsen weg.', priority: 5, tags: ['rotating_light'] });
      if (vp.connected) log('vPilot getrennt.');
      vp.connected = false;
    }
    else if (e.type === 'done' && e.cmd === 'pm') notify({ kind: 'atis', title: `Gesendet an ${e.to}`, message: String(e.text || ''), priority: 2 });
    else if (e.type === 'done') log(`vPilot: ${e.cmd} ausgeführt.`);
    else if (e.type === 'error') notify({ kind: 'atis', title: 'vPilot: hat nicht geklappt', message: String(e.message || ''), priority: 3 });
    else if (e.type === 'pm') notify({ kind: 'contact', title: `Nachricht von ${e.from}`, message: String(e.message || ''), priority: 5, tags: ['speech_balloon'], from: e.from });
    else if (e.type === 'radio' && me && String(e.message || '').toUpperCase().includes(me))
      notify({ kind: 'contact', title: `Funk-Text von ${e.from}`, message: String(e.message || ''), priority: 5, tags: ['speech_balloon'], from: e.from });
    else if (e.type === 'selcal') notify({ kind: 'contact', title: `SELCAL von ${e.from}`, message: 'Ein Lotse ruft dich per SELCAL.', priority: 5, tags: ['bell'], from: e.from });
    else if (e.type === 'atis') notify({ kind: 'atis', title: `ATIS ${e.from}`, message: (e.lines || []).join(' '), priority: 3 });
    else if (e.type === 'metar') notify({ kind: 'atis', title: 'METAR', message: String(e.metar || ''), priority: 3 });
  }
  const book = makeLogbook({ notify, plan: () => plan || {}, onChange: list => lan.logbook(list) });
  const lan = makeLan(cfg, { onCmd: handleCmd, onVpilot, getLogbook: () => book.list() });
  mon = makeMonitor({ cfg, notify });
  setInterval(() => { mon.tick(); book.update(mon.st); }, 1000);
  /* Anflug-Monitor: Landebahnen (OurAirports) + Energie-Rechnung. Töne nur über WLAN – ntfy hat ein Tageslimit. */
  const rw = makeRunways();
  rw.load().then(() => log('Landebahnen (OurAirports) geladen.')).catch(e => log('Landebahnen nicht geladen:', e.message));
  const en = makeEnergy();
  const lanAlarm = n => lan.alarm({ aid: crypto.randomBytes(5).toString('hex'), kind: n.kind, title: n.title, message: n.message || '', priority: n.priority || 3, t: Date.now(), from: '' });
  function energy(s, a) {
    if (!plan?.arr) return null;
    let rwy = rw.ok ? pickRunway(rw, plan.arr, plan.arrRwy, atisInfo(atisList, plan.arr), enHand.rwy) : null;
    if (!rwy && plan.arrPos) rwy = { id: plan.arr, lat: plan.arrPos[0], lon: plan.arrPos[1], elev: plan.arrElev, hdg: null, src: 'apt' };   // Bahn unbekannt → Flughafen-Mittelpunkt
    const st = { ...s, iasKt: s.iasKt ?? s.gsKt, flaps: s.flaps ?? 0, gear: !!s.gear, spdbrk: s.spdbrk ?? 0 };
    const fr = fmsTod.remaining, todPassed = fr != null ? fr < 0 : !!(a && a.dT != null && a.dT < 0);
    const r = en.update(st, { plan, rwy, vapp: enHand.vapp, todPassed });
    for (const e of r.events) lanAlarm({ kind: 'energy', title: e.level === 'urgent' ? e.text : 'Anflug: ' + e.text, message: e.why ? e.why.join(' · ') : '', priority: e.level === 'urgent' ? 5 : 3 });
    return r.view.on ? { ...r.view, apt: plan.arr, rwys: rw.ok ? rw.airport(plan.arr).map(x => x.id) : [], ias0: s.iasKt == null } : null;
  }
  /* Live-Daten aus dem Sim jede Sekunde – nur über WLAN (ntfy hat ein Tageslimit). Mit TOD/ETA entlang der Route. */
  setInterval(() => {
    const s = mon.st; if (s.lat == null) return;
    const a = plan ? along([s.lat, s.lon], plan, s.track) : null, gs = s.gsKt;
    const mins = d => d != null && gs > 80 ? Math.round(d / gs * 60) : null;
    /* TOD laut FMS: geflogene Strecke abziehen; am Boden oder 30 NM nach dem T/D wieder vergessen */
    fmsTod.update([s.lat, s.lon]);
    let fr = fmsTod.remaining; if (fr != null && (s.onGround || fr < -30)) { fmsTod.clear(); fr = null; }
    mon.setFmsTod(fr);
    let ev = null; try { ev = energy(s, a); } catch (e) { log('Anflug-Monitor:', e.message); }
    const tod = fr != null ? { todNm: Math.max(0, Math.round(fr)), todMin: fr > 0 ? mins(fr) : 0, todSrc: 'fms', todSet: fmsTod.entered }
      : { todNm: a && a.dT > 1 ? Math.round(a.dT) : null, todMin: a && a.dT > 1 ? mins(a.dT) : null, todSrc: 'plan' };
    lan.live({ lat: s.lat, lon: s.lon, alt: Math.round(s.altFt), gs: Math.round(gs), vs: s.vsFpm ?? null, gnd: s.onGround, paused: s.paused, ap: !!(s.ap1 || s.ap2),
      dA: a ? Math.round(a.dA) : null, etaMin: mins(a?.dA), ...tod, en: ev, t: Date.now() });
  }, 1000);
  ntfy.listen(c => { log('Befehl vom Handy (ntfy):', c); handleCmd(c); });
  /* Neuer Lotse voraus + ATIS am Ziel: Online-Lotsen und ATIS (VATSIM, alle 60 s), Prüfung alle 30 s */
  const sectors = makeSectors();
  sectors.load().then(() => log('Sektordaten (VATSpy) geladen.')).catch(e => log('Sektordaten nicht geladen:', e.message));
  let lastAtis = null;
  const pullCtl = async () => {
    try {
      const j = await (await fetch('https://data.vatsim.net/v3/vatsim-data.json')).json();
      ctl = (j.controllers || []).filter(c => c.facility > 0 && c.frequency !== '199.998'); atisList = j.atis || [];
      const a = plan?.arr ? atisInfo(atisList, plan.arr) : null;      // ATIS am Ziel geändert?
      if (a && a.code) {
        if (lastAtis && lastAtis.code !== a.code) {
          const rw = a.rws.join('/') !== lastAtis.rws.join('/') ? ` · Piste neu: ${a.rws.join(' / ')}` : a.rws.length ? ` · Piste ${a.rws.join(' / ')}` : '';
          const q = a.qnh && a.qnh !== lastAtis.qnh ? ` · QNH ${a.qnh} (vorher ${lastAtis.qnh || '?'})` : a.qnh ? ` · QNH ${a.qnh}` : '';
          notify({ kind: 'atis', title: `ATIS ${plan.arr}: ${a.code}`, message: `Neue Information ${a.code}${rw}${q}.`, priority: 3, tags: ['cloud'] });
        }
        lastAtis = a;
      }
    } catch { }
  };
  pullCtl(); setInterval(pullCtl, 60000);
  setInterval(() => {
    if (!sectors.ok || mon.st.lat == null) return;
    const me = [mon.st.lat, mon.st.lon];
    mon.sector({ cur: sectors.covers(me, ctl), next: sectors.next(me, plan?.wps, ctl) });
  }, 30000);
  /* Fuel-Check alle 60 s, Warnung höchstens alle 30 min */
  let fuelWarned = 0;
  setInterval(() => {
    const f = plan ? fuelCheck(mon.st, plan) : null;
    if (f?.low && Date.now() - fuelWarned > 30 * 60000) {
      fuelWarned = Date.now();
      notify({ kind: 'fuel', title: `Sprit unter Plan`, message: `${f.have} ${f.unit} an Bord, geplant ${f.want} ${f.unit} bei ${f.at}.`, priority: 4, tags: ['fuelpump'] });
    }
  }, 60000);
  if (cfg.simbriefUser) {
    try { plan = await loadTod(cfg.simbriefUser); mon.setTod(plan.tod); mon.setRoute(plan); log(`SimBrief: ${plan.flight} · TOD ${plan.tod ? 'gefunden' : 'nicht im OFP'} · ${plan.wps.length} Wegpunkte`); }
    catch (e) { log('SimBrief nicht geladen:', e.message); }
  } else log('Kein SimBrief-Name in config.json – TOD-Alarm aus.');
  sim = connectSim(cfg, mon);
  notify({ kind: 'info', title: 'EFB Bridge läuft', message: 'Push kommt an. Warnungen aus dem Sim landen hier.', priority: 2, tags: ['white_check_mark'] });
  /* Status: für die Tray-App (EFB-Bridge.exe) als Zeile „@status {…}“, für die Handy-App über den Status-Kanal */
  let lastStatus = '', lastPub = '';
  const pub = () => ({ on: true, ws: sim.state.ws, sim: sim.state.sim, fenix: sim.state.fenix, away: mon.st.away, awaySince: mon.st.away ? mon.st.awaySince : 0, awayMin: cfg.awayMin, sb: cfg.simbriefUser || '',
    paused: !!mon.st.paused, vp: lan.vpilotOnline(), vatsim: vp.connected, arr: plan?.arr || '' });
  setInterval(() => {
    const s = JSON.stringify({ ws: sim.state.ws, sim: sim.state.sim, fenix: sim.state.fenix, away: mon.st.away, topic: cfg.topic });
    if (s !== lastStatus) { lastStatus = s; console.log('@status ' + s); }
    const p = pub(), ps = JSON.stringify(p);
    if (ps !== lastPub) { lastPub = ps; lan.status({ ...p, rx: Date.now() }); }
    ntfy.status(p);
  }, 1000);
  const quit = async () => {             // Handy-App: „PC-Bridge aus“
    book.flush();
    lan.status({ on: false, rx: Date.now() });
    try { await fetch(`${cfg.ntfyServer.replace(/\/$/, '')}/${cfg.topic}-status`, { method: 'POST', body: JSON.stringify({ on: false }), headers: { Priority: '1' }, signal: AbortSignal.timeout(2500) }); } catch { }
    process.exit(0);
  };
  const run = k => {
    if (k === 'w' || k === 'weg') mon.cmd('weg');
    else if (k === 'd' || k === 'da') mon.cmd('da');
    else if (k === 't') notify({ kind: 'test', title: 'Test', message: 'Test-Nachricht von der EFB Bridge.', priority: 3, tags: ['test_tube'] });
    else if (k === 's') { const s = mon.st; log(`Status: ${s.simSeen ? 'Sim da' : 'kein Sim'} · ${Math.round(s.altFt)} ft · ${Math.round(s.gsKt)} kt · ${s.onGround ? 'Boden' : 'Luft'}${s.paused ? ' · PAUSE' : ''} · AP ${s.ap1 || s.ap2 ? 'an' : 'aus'} · Weg-Modus ${s.away ? 'an' : 'aus'}`); }
    else if (k === 'q' || k === '\u0003') quit();
  };
  if (process.stdin.isTTY) {          // im Konsolenfenster: einzelne Tasten
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('data', b => run(b.toString().toLowerCase()));
  } else {                            // aus der Tray-App: Befehle zeilenweise
    let buf = '';
    process.stdin.on('data', b => { buf += b; let i; while ((i = buf.indexOf('\n')) >= 0) { run(buf.slice(0, i).trim().toLowerCase()); buf = buf.slice(i + 1); } });
    process.stdin.on('end', quit);   // App beendet → Bridge auch
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

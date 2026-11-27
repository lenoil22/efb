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

export const DEFAULTS = {
  ntfyServer: 'https://ntfy.sh',
  topic: '',                 // geheimer Kanalname – wird beim ersten Start erzeugt
  simbriefUser: 'OnboardTransponder595',
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
    tod: null, todSent: false, todLast: null, away: false, awaySince: 0, awaySent: false, simSeen: false
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
    if (st.tod && !st.todSent && !st.onGround && st.gsKt > 100 && st.lat != null) {
      const d = nm(st.lat, st.lon, st.tod[0], st.tod[1]), min = d / st.gsKt * 60;
      const closing = st.todLast == null || d < st.todLast + 0.2;
      st.todLast = d;
      if (closing && d > 1 && min <= cfg.todLeadMin) {
        notify({ kind: 'tod', title: `TOD in ${Math.max(1, Math.round(min))} min`, message: `Noch ${Math.round(d)} NM bis Top of Descent. Sinkflug vorbereiten / anfragen.`, priority: 4, tags: ['arrow_lower_right'] });
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
  const setTod = p => { st.tod = p; st.todSent = false; st.todLast = null; };
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
  return { st, offsets, vars, tick, cmd, setTod, sector };
}

/* ---------- Logbuch: Off-Block, Start, Landung (Aufsetzrate + G), On-Block ----------
   update(st) jede Sekunde aufrufen. Aufsetzrate kommt aus dem Sim (FSUIPC 0x030C, beim Aufsetzen festgehalten),
   G = höchster Wert in den 3 s nach dem Aufsetzen. Gespeichert in bridge/logbook.json. */
export const grade = fpm => { const a = Math.abs(fpm); return a < 100 ? 'butterweich' : a < 240 ? 'gut' : a < 400 ? 'fest' : 'hart'; };
export function makeLogbook({ file = path.join(DIR, 'logbook.json'), notify, now = () => Date.now(), plan = () => ({}), onChange } = {}) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
  let f = null, wasGround = null, td = null, still = 0;
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(list, null, 1)); } catch { } onChange?.(list); };
  const start = st => { const p = plan(); f = { id: now().toString(36), date: new Date(now()).toISOString(), cs: p.cs || '', type: p.type || '', dep: p.dep || '', arr: p.arr || '', offBlock: now(), fuelOutLbs: st.fuelLbs ?? null }; };
  function update(st) {
    if (st.lat == null || !st.simSeen) return;
    const t = now(), g = !!st.onGround;
    if (!f && g && st.gsKt > 3) start(st);                                  // rollt los → Off-Block
    if (wasGround === true && !g && st.gsKt > 40) { if (!f) start(st); if (!f.takeoff) f.takeoff = t; }     // abgehoben
    if (wasGround === false && g && f && f.takeoff && !td) td = { t, vs: st.tdVs ?? st.vsFpm ?? 0, g: st.g ?? 1, bounces: 0 };   // aufgesetzt
    if (td && !f.landing) {
      if (t - td.t <= 3500) {
        td.g = Math.max(td.g, st.g ?? 1); if (st.tdVs != null) td.vs = st.tdVs;
        if (!g && !td.air) { td.bounces++; td.air = true; } if (g) td.air = false;
      }
      else {
        f.landing = td.t; f.fpm = -Math.abs(Math.round(td.vs)); f.g = Math.round(td.g * 100) / 100; f.bounces = td.bounces; f.grade = grade(f.fpm);
        const ft = Math.round((f.landing - f.takeoff) / 60000);
        notify({ kind: 'landing', title: `Gelandet${f.arr ? ' in ' + f.arr : ''} · ${f.fpm} fpm`, message: `${f.grade} · ${f.g.toFixed(2)} G${f.bounces ? ' · ' + f.bounces + '× gesprungen' : ''} · Flugzeit ${Math.floor(ft / 60)}:${String(ft % 60).padStart(2, '0')}`, priority: 3, tags: ['airplane_arriving'] });
      }
    }
    if (f && f.landing) {                                                    // steht 30 s → On-Block, Flug speichern
      still = st.gsKt < 1 ? (still || t) : 0;
      if (still && t - still > 30000) { f.onBlock = t; f.fuelInLbs = st.fuelLbs ?? null; list.unshift(f); list = list.slice(0, 200); f = null; td = null; still = 0; save(); }
    }
    wasGround = g;
  }
  /* Bridge wird beendet: angefangenen Flug trotzdem sichern, wenn gelandet */
  function flush() { if (f && f.landing) { f.onBlock = now(); list.unshift(f); f = null; save(); } }
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
    dep: j.origin?.icao_code || '', arr: j.destination?.icao_code || '', units: String(j.params?.units || 'kgs').toLowerCase()
  };
}

/* Rest entlang der Route (wie in der Handy-App): NM bis Ziel und bis TOD ab Position me */
export function along(me, plan) {
  const W = plan?.wps; if (!W?.length || !plan.total) return null;
  let bi = 0, bd = 1e9; W.forEach((w, i) => { const d = nm(me[0], me[1], w[0], w[1]); if (d < bd) { bd = d; bi = i; } });
  let nx = bi; if (bi < W.length - 1 && nm(me[0], me[1], W[bi + 1][0], W[bi + 1][1]) < nm(W[bi][0], W[bi][1], W[bi + 1][0], W[bi + 1][1])) nx = bi + 1;
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
    'vars.read': () => send({ command: 'vars.read', name: 'fenix', interval: 250 })
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
      case 'offsets.declare': if (r.name === 'pos') cmds['offsets.read'](); break;
      case 'offsets.read': if (r.data && r.name === 'pos') {
        if (!state.sim) { send({ command: 'about.read', name: 'about' }); if (!declared) cmds['vars.list'](); }   // Sim gerade verbunden
        state.sim = true; if (waitLogged) { log('Sim verbunden.'); waitLogged = false; } mon.offsets(r.data);
      } break;
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
  }
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
  /* Live-Daten aus dem Sim jede Sekunde – nur über WLAN (ntfy hat ein Tageslimit). Mit TOD/ETA entlang der Route. */
  setInterval(() => {
    const s = mon.st; if (s.lat == null) return;
    const a = plan ? along([s.lat, s.lon], plan) : null, gs = s.gsKt;
    const mins = d => d != null && gs > 80 ? Math.round(d / gs * 60) : null;
    lan.live({ lat: s.lat, lon: s.lon, alt: Math.round(s.altFt), gs: Math.round(gs), vs: s.vsFpm ?? null, gnd: s.onGround, paused: s.paused, ap: !!(s.ap1 || s.ap2),
      dA: a ? Math.round(a.dA) : null, etaMin: mins(a?.dA), todMin: a && a.dT > 1 ? mins(a.dT) : null, todNm: a && a.dT > 1 ? Math.round(a.dT) : null, t: Date.now() });
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
    try { plan = await loadTod(cfg.simbriefUser); mon.setTod(plan.tod); log(`SimBrief: ${plan.flight} · TOD ${plan.tod ? 'gefunden' : 'nicht im OFP'} · ${plan.wps.length} Wegpunkte`); }
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

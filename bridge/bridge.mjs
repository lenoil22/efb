// EFB Bridge – Sim-Warnungen aufs Handy (ntfy)
// Läuft auf dem Sim-PC neben MSFS. Liest über den FSUIPC WebSocket Server (FSUIPC7) Pause, Position und
// Fenix-L-Vars (Master Warning/Caution, AP) und schickt Push-Nachrichten über ntfy.
// Keine npm-Pakete nötig (Node ≥ 22: fetch + WebSocket eingebaut). Start: start.bat
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  /* kind = Alarmart für die Handy-App (Tag „efb-<kind>“): warning, caution, ap, pause, tod, away, test, info */
  async function send({ title, message, priority = 3, tags = [], back = false, kind = 'info' }) {
    try {
      const r = await fetchImpl(base + '/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: cfg.topic, title, message, priority, tags: [...tags, 'efb-' + kind], ...(back ? { actions: backAction } : {}) })
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
            try { const m = JSON.parse(line); if (m.event === 'message' && m.message) onCmd(String(m.message).trim().toLowerCase()); } catch { }
          }
        }
      } catch (e) { if (signal?.aborted) return; }
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return { send, listen, status, cmdTopic };
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
        if (on && !st.caut && cool('caut', 30000)) notify({ kind: 'caution', title: 'Master Caution', message: 'Im Cockpit leuchtet Master Caution.', priority: 4, tags: ['warning'] });
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
      if (st.warn && !fromAp && cool('warn', 30000)) notify({ kind: 'warning', title: 'MASTER WARNING', message: 'Im Cockpit leuchtet Master Warning. Sofort an den PC.', priority: 5, tags: ['rotating_light'] });
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
    // Weg-Modus
    if (st.away && !st.awaySent && t - st.awaySince >= cfg.awayMin * 60000) {
      notify({ kind: 'away', title: `Seit ${cfg.awayMin} min weg`, message: 'VATSIM erlaubt max. 30 min ohne Aufsicht. Zurück an den PC.', priority: 5, tags: ['alarm_clock'], back: true });
      st.awaySent = true;
    }
  }
  function cmd(c) {
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

/* ---------- SimBrief: TOD-Punkt aus dem letzten OFP ---------- */
export async function loadTod(user, fetchImpl = fetch) {
  const j = await (await fetchImpl('https://www.simbrief.com/api/xml.fetcher.php?json=1&username=' + encodeURIComponent(user))).json();
  if (j.fetch?.status && j.fetch.status !== 'Success') throw new Error(j.fetch.status);
  let fx = j.navlog?.fix || []; if (!Array.isArray(fx)) fx = [fx];
  const t = fx.find(x => String(x.ident).toUpperCase() === 'TOD');
  let cum = 0;
  const wps = fx.map(x => { cum += +x.distance || 0; return x.pos_lat && x.type !== 'apt' ? [+x.pos_lat, +x.pos_long, x.ident, cum] : null; }).filter(Boolean);
  return { flight: `${j.atc?.callsign || ''} ${j.origin?.icao_code || ''} → ${j.destination?.icao_code || ''}`.trim(), tod: t ? [+t.pos_lat, +t.pos_long] : null, wps };
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
  { name: 'paused', address: 0x0264, type: 'uint', size: 2 }
];
export function connectSim(cfg, mon, WS = globalThis.WebSocket) {
  let ws = null, names = null, declared = false, waitLogged = false, warned = false;
  const state = { ws: false, sim: false, fenix: false };
  const retry = {};
  const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const cmds = {
    'offsets.declare': () => send({ command: 'offsets.declare', name: 'pos', offsets: OFFSETS }),
    'offsets.read': () => send({ command: 'offsets.read', name: 'pos', interval: 1000 }),
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
      case 'offsets.declare': cmds['offsets.read'](); break;
      case 'offsets.read': if (r.data) {
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
  return { state, close: () => ws?.close() };
}

/* ---------- Start ---------- */
async function main() {
  const cfg = loadConfig();
  if (process.stdin.isTTY) {
    console.log('\n  EFB Bridge – Sim-Warnungen aufs Handy\n  ─────────────────────────────────────');
    console.log(`  ntfy-Kanal: ${cfg.topic}`);
    console.log('  Tasten: W = weg · D = wieder da · T = Test-Nachricht · S = Status · Q = beenden\n');
  } else log(`ntfy-Kanal: ${cfg.topic}`);
  if (cfg._new) log('NEU: In der ntfy-App auf dem Handy „+“ tippen und genau diesen Kanal abonnieren.');
  const ntfy = makeNtfy(cfg);
  const mon = makeMonitor({ cfg, notify: n => ntfy.send(n) });
  setInterval(mon.tick, 1000);
  ntfy.listen(c => { log('Befehl vom Handy:', c); mon.cmd(c); });
  /* Neuer Lotse voraus: Sektoren + Online-Lotsen (VATSIM, alle 60 s) + SimBrief-Route, Prüfung alle 30 s */
  let route = null, ctl = [];
  const sectors = makeSectors();
  sectors.load().then(() => log('Sektordaten (VATSpy) geladen.')).catch(e => log('Sektordaten nicht geladen:', e.message));
  const pullCtl = async () => { try { const j = await (await fetch('https://data.vatsim.net/v3/vatsim-data.json')).json(); ctl = (j.controllers || []).filter(c => c.facility > 0 && c.frequency !== '199.998'); } catch { } };
  pullCtl(); setInterval(pullCtl, 60000);
  setInterval(() => {
    if (!sectors.ok || mon.st.lat == null) return;
    const me = [mon.st.lat, mon.st.lon];
    mon.sector({ cur: sectors.covers(me, ctl), next: sectors.next(me, route, ctl) });
  }, 30000);
  if (cfg.simbriefUser) {
    try { const s = await loadTod(cfg.simbriefUser); mon.setTod(s.tod); route = s.wps; log(`SimBrief: ${s.flight} · TOD ${s.tod ? 'gefunden' : 'nicht im OFP'} · ${s.wps.length} Wegpunkte`); }
    catch (e) { log('SimBrief nicht geladen:', e.message); }
  } else log('Kein SimBrief-Name in config.json – TOD-Alarm aus.');
  const sim = connectSim(cfg, mon);
  ntfy.send({ kind: 'info', title: 'EFB Bridge läuft', message: 'Push kommt an. Warnungen aus dem Sim landen hier.', priority: 2, tags: ['white_check_mark'] });
  /* Status: für die Tray-App (EFB-Bridge.exe) als Zeile „@status {…}“, für die Handy-App über den Status-Kanal */
  let lastStatus = '';
  const pub = () => ({ on: true, ws: sim.state.ws, sim: sim.state.sim, fenix: sim.state.fenix, away: mon.st.away, awaySince: mon.st.away ? mon.st.awaySince : 0, awayMin: cfg.awayMin, sb: cfg.simbriefUser || '' });
  setInterval(() => {
    const s = JSON.stringify({ ws: sim.state.ws, sim: sim.state.sim, fenix: sim.state.fenix, away: mon.st.away, topic: cfg.topic });
    if (s !== lastStatus) { lastStatus = s; console.log('@status ' + s); }
    ntfy.status(pub());
  }, 1000);
  const quit = async () => {             // Handy-App: „PC-Bridge aus“
    try { await fetch(`${cfg.ntfyServer.replace(/\/$/, '')}/${cfg.topic}-status`, { method: 'POST', body: JSON.stringify({ on: false }), headers: { Priority: '1' }, signal: AbortSignal.timeout(2500) }); } catch { }
    process.exit(0);
  };
  const run = k => {
    if (k === 'w' || k === 'weg') mon.cmd('weg');
    else if (k === 'd' || k === 'da') mon.cmd('da');
    else if (k === 't') ntfy.send({ kind: 'test', title: 'Test', message: 'Test-Nachricht von der EFB Bridge.', priority: 3, tags: ['test_tube'] });
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

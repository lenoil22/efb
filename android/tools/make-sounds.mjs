// Erzeugt die eingebauten Wecker-Töne der App (eigene Synthese, keine fremden Aufnahmen).
// Aufruf: node android/tools/make-sounds.mjs  → android/app/src/main/res/raw/efb_*.wav
// Jede Datei ist eine Schleife (der Wecker spielt sie dauerhaft ab): Ton + Pause bis zur Wiederholung.
import fs from 'node:fs';
import path from 'node:path';

const SR = 22050;
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../app/src/main/res/raw');

function wav(name, seconds, fill) {
  const n = Math.round(seconds * SR), buf = new Float32Array(n);
  fill(buf);
  let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(buf[i] / (peak || 1) * 0.85 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name + '.wav'), Buffer.concat([h, data]));
  console.log(name, (44 + data.length) / 1024 | 0, 'KB');
}
/* angeschlagener Ton mit Obertönen und Abklingen (Glocke/Gong) */
function strike(buf, at, f, decay, partials, gain = 1) {
  const s = Math.round(at * SR);
  for (let i = s; i < buf.length; i++) {
    const t = (i - s) / SR, env = Math.exp(-t * decay) * Math.min(1, t / 0.004);
    let v = 0; for (const [m, a, d] of partials) v += a * Math.exp(-t * (d || 0)) * Math.sin(2 * Math.PI * f * m * t);
    buf[i] += gain * env * v;
  }
}
/* gleichmäßiger Piepton mit weichen Kanten (kein Knacken) */
function tone(buf, at, len, f, gain = 1, harm = 0.25) {
  const s = Math.round(at * SR), e = Math.min(buf.length, Math.round((at + len) * SR)), fade = 0.008;
  for (let i = s; i < e; i++) {
    const t = (i - s) / SR, env = Math.min(1, t / fade, (len - t) / fade);
    buf[i] += gain * env * (Math.sin(2 * Math.PI * f * t) + harm * Math.sin(2 * Math.PI * 3 * f * t) / 3);
  }
}
const BELL = [[1, 1], [2, .35, 1.5], [3, .12, 3], [4.16, .06, 5]];

// Gong: weiches Zwei-Ton-„Ding-Dong“, dann Ruhe
wav('efb_gong', 3.2, b => { strike(b, 0.02, 659.25, 2.2, BELL); strike(b, 0.55, 523.25, 1.8, BELL); });
// Glocke: sanft aufsteigend (zum Wachwerden, z. B. TOD)
wav('efb_glocke', 3.4, b => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => strike(b, 0.02 + i * 0.2, f, 2.6, BELL, i === 3 ? 0.8 : 0.6)); });
// Piepser: drei kurze Pieptöne wie ein Digitalwecker
wav('efb_piepser', 1.4, b => { for (let i = 0; i < 3; i++) tone(b, 0.02 + i * 0.2, 0.11, 1046.5, 1, 0.5); });
// Dringend: schneller Wechselton (für Warnungen, Absturz)
wav('efb_dringend', 1.3, b => { for (let i = 0; i < 4; i++) { tone(b, 0.02 + i * 0.26, 0.12, 880, 1, 0.35); tone(b, 0.15 + i * 0.26, 0.12, 1174.66, 1, 0.35); } });

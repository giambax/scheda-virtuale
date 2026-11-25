// link.js — "Condividi con link" ed "Esercizio": il progetto viaggia tutto dentro il link,
// compresso (fflate) e in base64url dopo il # (il pezzo dopo # non arriva mai al server).
// Va anche senza account e offline. Funziona anche in Node (strumenti/prova-link.mjs).
//
// Link:  …/public/#progetto=<dati>   oppure   …/public/#esercizio=<dati>
// Dati:  JSON { v: 1, nome, files: { "Core/Src/main.c": "testo", … }, devices, canali, breadboard?,
//               esercizio?: { titolo, testo, sola: ["Core/Inc/main.h", …] } }
//
// Il contenuto di un link è un DATO scritto da chiunque: qui si controlla tutto (dimensioni,
// nomi dei file, tipi) e niente di quello che arriva viene mai usato come HTML.
import { deflateSync, Inflate, strToU8, strFromU8 } from '../vendor/fflate/esm/browser.js';
import { parseCproject } from './build.js?v=2026-11-25g';
import { pulisciBreadboard } from './circuito.js?v=2026-11-25g';

export const LINK_MAX = 400000;          // caratteri dopo # che si accettano
const DATI_MAX = 3 * 1024 * 1024;        // JSON scompresso (contro gli "zip bomb")
const FILE_MAX = 100;
export const LINK_LUNGO = 32000;         // oltre: avviso (alcune chat/programmi tagliano i link lunghi)
export const LINK_TROPPO = 100000;       // oltre: meglio lo zip

// file che il sito non compila mai (li dà lui): non servono nel link
const MAI_COMPILATI = /(^|\/)(syscalls|sysmem|system_stm32f4xx)\.c$/;
// nomi di file accettati: Core/… e poco altro, niente "..", niente caratteri strani
const NOME_FILE = /^(?:[\w.\- ()]{1,80}\/){0,4}[\w.\- ()]{1,80}\.(c|h|ioc)$|^\.cproject$/;
const PIN = /^(P[A-H]\d{1,2})?$/;

const pulisci = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, max);

// .cproject "normale" (micro e cartelle standard): la compilazione fa lo stesso anche senza → non serve nel link
function cprojectStandard(txt) {
  let cp;
  try { cp = parseCproject(txt); } catch { return false; }
  const std = new Set(['../Core/Inc', '../Drivers/STM32F4xx_HAL_Driver/Inc', '../Drivers/STM32F4xx_HAL_Driver/Inc/Legacy', '../Drivers/CMSIS/Device/ST/STM32F4xx/Include', '../Drivers/CMSIS/Include']);
  return cp.defs.every(d => /^(USE_HAL_DRIVER|DEBUG|STM32F401xE)$/.test(d)) &&
    cp.incs.every(i => std.has(i)) && cp.entries.every(e => /^(Core|Drivers)$/.test(e));
}

const b64url = u8 => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = s => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
};

// p: { nome, files: { rel: testo }, devices, canali, esercizio } → { url, lunghezza, tolti: [file non messi] }
export function creaLink(base, p) {
  const files = {}, tolti = [];
  for (const [rel, t] of Object.entries(p.files)) {
    if (MAI_COMPILATI.test(rel) || (rel === '.cproject' && cprojectStandard(t))) { tolti.push(rel); continue; }
    if (NOME_FILE.test(rel)) files[rel] = t;
  }
  const dati = { v: 1, nome: p.nome, files, devices: Array.isArray(p.devices) ? p.devices : null };
  if (Array.isArray(p.canali) && p.canali.length) dati.canali = p.canali;
  if (p.breadboard && Array.isArray(p.breadboard.comps) && (p.breadboard.comps.length || p.breadboard.wires.length)) dati.breadboard = pulisciBreadboard(p.breadboard);
  if (p.esercizio) dati.esercizio = { titolo: p.esercizio.titolo, testo: p.esercizio.testo, sola: (p.esercizio.sola || []).filter(r => r in files) };
  const z = b64url(deflateSync(strToU8(JSON.stringify(dati)), { level: 9 }));
  const url = base.replace(/#.*$/, '') + '#' + (p.esercizio ? 'esercizio' : 'progetto') + '=' + z;
  return { url, lunghezza: url.length, tolti };
}

// scompatta a pezzi, fermandosi se il risultato supera DATI_MAX
function scomprimi(u8) {
  const parti = [];
  let tot = 0, fine = false;
  const inf = new Inflate((c, f) => { tot += c.length; if (tot > DATI_MAX) throw new Error('troppo grande'); parti.push(c); if (f) fine = true; });
  for (let i = 0; i < u8.length; i += 1024) inf.push(u8.subarray(i, i + 1024), i + 1024 >= u8.length);
  if (!fine) throw new Error('dati incompleti');
  const out = new Uint8Array(tot);
  let o = 0;
  for (const c of parti) { out.set(c, o); o += c.length; }
  return out;
}

// hash della pagina → null (non è un link condiviso) | { errore } | { tipo, nome, files, devices, canali, esercizio }
export function leggiLink(hash) {
  const m = /^#(progetto|esercizio)=([A-Za-z0-9_-]+)$/.exec(hash || '');
  if (!m) return /^#(progetto|esercizio)=/.test(hash || '') ? { errore: 'Il link è rovinato (manca un pezzo o ci sono caratteri in più): copialo di nuovo per intero.' } : null;
  if (m[2].length > LINK_MAX) return { errore: 'Il link è troppo lungo.' };
  let d;
  try { d = JSON.parse(strFromU8(scomprimi(unb64url(m[2])))); } catch (e) {
    return { errore: e.message === 'troppo grande' ? 'Il progetto nel link è troppo grande.' : 'Il link è rovinato (forse è stato tagliato): copialo di nuovo per intero.' };
  }
  if (!d || typeof d !== 'object' || d.v !== 1 || !d.files || typeof d.files !== 'object' || Array.isArray(d.files)) return { errore: 'Questo link non è di questa versione del sito.' };
  const files = {};
  for (const [rel, t] of Object.entries(d.files).slice(0, FILE_MAX)) {
    if (typeof t === 'string' && NOME_FILE.test(rel) && !rel.split('/').includes('..')) files[rel] = t;
  }
  if (!files['Core/Src/main.c']) return { errore: 'Nel link non c\'è Core/Src/main.c.' };
  const out = {
    tipo: m[1],
    nome: pulisci(d.nome, 60).replace(/\//g, '-') || 'Progetto condiviso',
    files,
    devices: Array.isArray(d.devices) ? d.devices : null,
    canali: Array.isArray(d.canali) ? d.canali.slice(0, 16).map(c => typeof c === 'string' && PIN.test(c) ? c : '') : null,
    esercizio: null,
    breadboard: d.breadboard && typeof d.breadboard === 'object' ? pulisciBreadboard(d.breadboard) : null,
  };
  if (d.esercizio && typeof d.esercizio === 'object') out.esercizio = esercizioPulito(d.esercizio, files);
  return out;
}

// metadati dell'esercizio (salvati nel progetto come ".esercizio.json")
export function esercizioPulito(e, files) {
  return {
    titolo: pulisci(e.titolo, 120) || 'Esercizio',
    testo: String(e.testo ?? '').replace(/\r\n?/g, '\n').slice(0, 20000),
    sola: Array.isArray(e.sola) ? e.sola.filter(r => typeof r === 'string' && r in files).slice(0, FILE_MAX) : [],
  };
}

// sw.js — service worker della Scheda Virtuale.
// 1) Cache: dopo la prima apertura il sito (anche il compilatore) funziona senza Internet.
//    Script, CSS e sim/ hanno ?v=<versione> (strumenti/alza-versione.sh): offline si cerca senza ?v (ignoreSearch).
//    - vendor/ (compilatore, ~100 MB non compressi): prima la cache, la rete solo se manca
//    - il resto (pagina, script, simulatore): prima la rete, la cache se si è offline
//    Due cache: VERSIONE per le pagine e gli script (cambiandola si svuota), VENDOR per vendor/ (il compilatore):
//    resta anche quando cambia VERSIONE, così nessuno riscarica 15–25 MB a ogni aggiornamento del sito.
//    Il compilatore (llvm.core.wasm, 75 MB) arriva compresso con brotli (llvm.core.wasm.br, ~14,6 MB invece
//    dei ~23 MB in gzip di GitHub Pages) e qui si decomprime una volta sola (vendor/brotli/brotli-dec.js).
// 2) Intestazioni COOP/COEP: senza queste il browser non dà lo SharedArrayBuffer
//    che serve alla simulazione (GitHub Pages non permette di impostarle dal server).
const VERSIONE = 'sv-2026-11-24h';
const VENDOR = 'sv-vendor-1';
importScripts('vendor/brotli/brotli-dec.js');

self.addEventListener('install', () => self.skipWaiting());
// all'attivazione: i file di vendor/ delle cache vecchie passano in VENDOR (niente da riscaricare), poi via le vecchie
self.addEventListener('activate', e => e.waitUntil((async () => {
  const vend = await caches.open(VENDOR);
  for (const k of await caches.keys()) {
    if (k === VERSIONE || k === VENDOR) continue;
    const c = await caches.open(k);
    for (const req of await c.keys()) if (/\/vendor\//.test(new URL(req.url).pathname) && !(await vend.match(req))) { const r = await c.match(req); if (r) await vend.put(req, r); }
    await caches.delete(k);
  }
  await self.clients.claim();
})()));

function isolate(r) {
  if (!r || r.status === 0) return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// il compilatore: si scarica la versione brotli e si decomprime qui (se non c'è, quella normale)
const LLVM = /\/vendor\/yowasp-clang\/gen\/llvm\.core\.wasm$/, LLVM_LUNGO = 75532134;
async function compilatore(req) {
  try {
    const r = await fetch(req.url + '.br');
    if (!r.ok) throw new Error('niente .br');
    const t0 = Date.now(), dati = self.BrotliDecode(new Uint8Array(await r.arrayBuffer()), LLVM_LUNGO);
    console.log(`compilatore: brotli decompresso in ${Date.now() - t0} ms`);
    return new Response(dati, { status: 200, headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(dati.length) } });
  } catch (e) {
    return fetch(req);
  }
}

async function answer(req) {
  const cache = await caches.open(VERSIONE);
  const big = /\/vendor\//.test(new URL(req.url).pathname);
  if (big) {
    const vend = await caches.open(VENDOR);
    const hit = await vend.match(req);
    if (hit) return hit;
    const r = LLVM.test(new URL(req.url).pathname) ? await compilatore(req) : await fetch(req);
    if (r.ok) await vend.put(req, r.clone());
    return r;
  }
  try {
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.ok) {
      // file con ?v=… (strumenti/alza-versione.sh): in cache resta solo l'ultima versione di ogni file
      if (new URL(req.url).searchParams.has('v')) await cache.delete(req, { ignoreSearch: true });
      cache.put(req, r.clone());
    }
    return r;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(answer(req).then(isolate));
});

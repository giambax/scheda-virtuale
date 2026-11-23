// sw.js — service worker della Scheda Virtuale.
// 1) Cache: dopo la prima apertura il sito (anche il compilatore) funziona senza Internet.
//    - vendor/ (compilatore, ~100 MB non compressi): prima la cache, la rete solo se manca
//    - il resto (pagina, script, simulatore): prima la rete, la cache se si è offline
//    Cambiando VERSIONE la cache vecchia si cancella (es. nuovo compilatore).
// 2) Intestazioni COOP/COEP: senza queste il browser non dà lo SharedArrayBuffer
//    che serve alla simulazione (GitHub Pages non permette di impostarle dal server).
const VERSIONE = 'sv-2026-11-23c';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSIONE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

function isolate(r) {
  if (!r || r.status === 0) return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

async function answer(req) {
  const cache = await caches.open(VERSIONE);
  const big = /\/vendor\//.test(new URL(req.url).pathname);
  if (big) {
    const hit = await cache.match(req);
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok) await cache.put(req, r.clone());
    return r;
  }
  try {
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.ok) cache.put(req, r.clone());
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

// sim-runtime.js — esegue la scheda compilata (scheda.wasm) in un Web Worker.
// Usato da sim-worker.js (browser) e dalle prove da terminale (Node).
//
// Canale dei comandi pagina → simulazione: un SharedArrayBuffer
//   Int32 [0] = contatore dei risvegli (Atomics.notify), [1] = byte scritti, [2] = byte letti
//   da 16 byte in poi: anello di IN_SZ byte con le righe di testo
// La simulazione ci dorme sopra (Atomics.wait) quando è avanti rispetto al tempo reale:
// un comando nuovo (es. pulsante premuto) la sveglia subito.

export const IN_SZ = 1 << 16;
export function makeInput() { return new SharedArrayBuffer(16 + IN_SZ); }

// lato pagina: accoda righe di comando
export function writeInput(sab, lines) {
  const h = new Int32Array(sab, 0, 4), ring = new Uint8Array(sab, 16, IN_SZ);
  const bytes = new TextEncoder().encode(lines.map(l => l + '\n').join(''));
  let w = Atomics.load(h, 1);
  const r = Atomics.load(h, 2);
  if (bytes.length > IN_SZ - (w - r)) return false;      // pieno: la simulazione è ferma?
  for (let i = 0; i < bytes.length; i++) ring[(w + i) % IN_SZ] = bytes[i];
  Atomics.store(h, 1, w + bytes.length);
  Atomics.add(h, 0, 1);
  Atomics.notify(h, 0);
  return true;
}

class Exit extends Error { constructor(code) { super('exit ' + code); this.code = code; } }

// onOut(testo) riceve le righe di eventi; restituisce il codice d'uscita (42 = reset software)
export function runSim(module, sab, onOut, onConsole = () => {}) {
  const h = new Int32Array(sab, 0, 4), ring = new Uint8Array(sab, 16, IN_SZ);
  const dec = new TextDecoder('latin1');
  let mem;
  const u8 = () => new Uint8Array(mem.buffer);
  const dv = () => new DataView(mem.buffer);
  const sv = {
    out: (p, n) => onOut(dec.decode(u8().slice(p, p + n))),
    now: () => performance.now(),
    in: (p, max) => {
      const w = Atomics.load(h, 1);
      let r = Atomics.load(h, 2);
      const n = Math.min(max, w - r);
      if (n <= 0) return 0;
      const m = u8();
      for (let i = 0; i < n; i++) m[p + i] = ring[(r + i) % IN_SZ];
      Atomics.store(h, 2, r + n);
      return n;
    },
    sleep: ms => {
      if (Atomics.load(h, 1) !== Atomics.load(h, 2)) return;   // c'è già un comando da leggere
      Atomics.wait(h, 0, Atomics.load(h, 0), ms);
    },
  };
  // WASI minimo: la libc usa solo queste (printf della scheda passa da sv.out)
  const wasi = {
    fd_write: (fd, iovs, n, nwritten) => {
      const d = dv();
      let tot = 0, s = '';
      for (let i = 0; i < n; i++) {
        const p = d.getUint32(iovs + i * 8, true), l = d.getUint32(iovs + i * 8 + 4, true);
        s += new TextDecoder().decode(u8().slice(p, p + l));
        tot += l;
      }
      onConsole(s);
      d.setUint32(nwritten, tot, true);
      return 0;
    },
    fd_close: () => 0,
    fd_seek: () => 70,          // ESPIPE
    proc_exit: code => { throw new Exit(code); },
  };
  const imports = { sv, wasi_snapshot_preview1: new Proxy(wasi, { get: (t, k) => t[k] || (() => 52) }) };   // 52 = ENOSYS
  const inst = new WebAssembly.Instance(module, imports);
  mem = inst.exports.memory;
  try {
    inst.exports._start();
    return 0;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}

// errore del WebAssembly → messaggio come quelli della scheda (HardFault)
export function trapMessage(e) {
  const m = String(e && e.message || e);
  if (/divide by zero|division by zero/i.test(m)) return 'Divisione intera per zero: sulla scheda vera il risultato sarebbe 0, qui il programma si ferma';
  if (/out of bounds|memory access/i.test(m)) return 'HardFault: accesso a memoria non valida (puntatore sbagliato o fuori da un array?)';
  if (/call stack|stack overflow|too much recursion/i.test(m)) return 'HardFault: stack esaurito (ricorsione infinita?)';
  if (/unreachable/i.test(m)) return 'HardFault: istruzione non valida (funzione senza return?)';
  if (/indirect call|signature mismatch|null function/i.test(m)) return 'HardFault: chiamata a un puntatore a funzione non valido';
  return 'HardFault: ' + m;
}

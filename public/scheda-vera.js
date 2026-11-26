// scheda-vera.js — la NUCLEO-F401RE vera collegata via USB (fase 3, punto M, 26/11/2026). Solo Chrome/Edge.
//
// 1) Monitor seriale sulla scheda vera (Web Serial): la porta virtuale del ST-LINK (USART2 della Nucleo)
//    diventa la linguetta «Scheda vera» della scheda Seriale, con la stessa interfaccia del simulato
//    (Testo/HEX, ora, terminatore, baud, Scarica .txt). Cambiare il baud riapre la porta.
// 2) «Carica sulla scheda»: il sito NON sa compilare per ARM (il clang in WebAssembly del sito ha solo il
//    backend WebAssembly), quindi si parte dal file che compila CubeIDE (Debug/<progetto>.elf, oppure .hex/.bin):
//    si controlla (micro giusto, tabella dei vettori, dimensione), si trasforma in .bin e lo si copia sul disco
//    NODE_F401RE del ST-LINK, che lo scrive nella flash da solo (come trascinarlo nel Finder/Esplora risorse).
//    Oppure «Scarica .bin» e lo si trascina a mano. Niente WebUSB verso il ST-LINK (protocollo chiuso, non provato).
// Le funzioni di conversione (daElf, daHex, controlla) vanno anche in Node: strumenti/prova-scheda-vera.mjs.

export const FLASH = 0x08000000, FLASH_DIM = 512 * 1024, RAM = 0x20000000, RAM_DIM = 96 * 1024;

// .elf (ARM, 32 bit little endian) → immagine della flash: segmenti PT_LOAD con l'indirizzo fisico (LMA, così
// i valori iniziali di .data finiscono dopo il codice come fa arm-none-eabi-objcopy -O binary); buchi a 0xFF
export function daElf(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 52 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) throw new Error('non è un file .elf');
  if (b[4] !== 1 || b[5] !== 1) throw new Error('.elf non a 32 bit little endian: non è per STM32');
  const mac = dv.getUint16(18, true);
  if (mac !== 40) throw new Error(`.elf per un altro processore (e_machine ${mac}, ARM = 40): è quello del simulatore o di un PC?`);
  const phoff = dv.getUint32(28, true), phsz = dv.getUint16(42, true), phn = dv.getUint16(44, true);
  const segs = [];
  for (let i = 0; i < phn; i++) {
    const o = phoff + i * phsz;
    if (o + 32 > b.length) throw new Error('.elf rovinato (intestazioni dei segmenti)');
    const tipo = dv.getUint32(o, true), off = dv.getUint32(o + 4, true), pa = dv.getUint32(o + 12, true), fsz = dv.getUint32(o + 16, true);
    if (tipo !== 1 || !fsz) continue;
    if (off + fsz > b.length) throw new Error('.elf rovinato (segmento fuori dal file)');
    segs.push({ ind: pa, dati: b.subarray(off, off + fsz) });
  }
  return { ...unisci(segs), entry: dv.getUint32(24, true) };
}

// Intel HEX (record 00 dati, 01 fine, 02/04 indirizzo esteso) → immagine
export function daHex(testo) {
  const segs = [];
  let base = 0, fine = false;
  for (const [n, r0] of String(testo).split(/\r?\n/).entries()) {
    const r = r0.trim();
    if (!r) continue;
    if (!/^:([0-9A-Fa-f]{2})+$/.test(r)) throw new Error(`riga ${n + 1} del .hex non valida`);
    const by = r.slice(1).match(/../g).map(h => parseInt(h, 16));
    if (by.reduce((a, x) => a + x, 0) & 0xff) throw new Error(`riga ${n + 1} del .hex: somma di controllo sbagliata`);
    const len = by[0], ind = by[1] << 8 | by[2], tipo = by[3], d = by.slice(4, 4 + len);
    if (tipo === 0) segs.push({ ind: base + ind, dati: Uint8Array.from(d) });
    else if (tipo === 1) { fine = true; break; }
    else if (tipo === 2) base = (d[0] << 8 | d[1]) << 4;
    else if (tipo === 4) base = ((d[0] << 8 | d[1]) << 16) >>> 0;
  }
  if (!fine) throw new Error('.hex senza la riga di fine (file tagliato?)');
  return unisci(segs);
}

function unisci(segs) {
  segs = segs.filter(s => s.dati.length);
  if (!segs.length) throw new Error('nessun dato da scrivere');
  const a = Math.min(...segs.map(s => s.ind)), z = Math.max(...segs.map(s => s.ind + s.dati.length));
  if (z - a > 2 * 1024 * 1024) throw new Error('dati sparsi su più di 2 MB: non è un programma per la flash');
  const img = new Uint8Array(z - a).fill(0xff);
  for (const s of segs) img.set(s.dati, s.ind - a);
  return { ind: a >>> 0, img };
}

// controlli prima di scrivere: [{ ok, testo }]
export function controlla({ ind, img }) {
  const dv = new DataView(img.buffer, img.byteOffset, img.byteLength), out = [];
  const sp = img.length >= 8 ? dv.getUint32(0, true) : 0, reset = img.length >= 8 ? dv.getUint32(4, true) : 0;
  out.push({ ok: ind === FLASH, testo: ind === FLASH ? 'parte dall\'inizio della flash (0x08000000)' : `parte da 0x${ind.toString(16)}, non da 0x08000000: copiato sulla scheda finirebbe nel posto sbagliato` });
  out.push({ ok: img.length <= FLASH_DIM, testo: `${(img.length / 1024).toFixed(1).replace('.', ',')} KB su ${FLASH_DIM / 1024} KB di flash` });
  out.push({ ok: sp > RAM && sp <= RAM + RAM_DIM, testo: `stack iniziale 0x${sp.toString(16).toUpperCase()} ${sp > RAM && sp <= RAM + RAM_DIM ? 'nella RAM da 96 KB dell\'F401RE' : 'fuori dalla RAM dell\'F401RE (progetto per un altro micro?)'}` });
  out.push({ ok: (reset & 1) === 1 && reset >= FLASH && reset < FLASH + img.length, testo: `Reset_Handler a 0x${(reset & ~1).toString(16).toUpperCase()}${(reset & 1) ? '' : ' (manca il bit Thumb: non parte)'}` });
  return out;
}

// ------------------------------------------------------------------
// Pagina (usa S, $, appendSerial, renderUartTabs, redrawSerial, addLog di app.js)
if (typeof document !== 'undefined' && document.getElementById('serial-form')) {
  const V = 'V';                                   // "USART" della scheda vera nella scheda Seriale
  const SER = { porta: null, lettore: null, t0: 0, chiudendo: false };
  const hex = u => [...u].map(x => x.toString(16).padStart(2, '0')).join('');
  const btn = document.getElementById('ser-vera');
  const ok = 'serial' in navigator;
  btn.disabled = !ok;
  if (!ok) btn.title = 'Serve Chrome o Edge su computer (Web Serial): Safari, Firefox e i telefoni non possono aprire la porta USB.';
  const aggiorna = () => {
    btn.textContent = SER.porta ? '⏏ Scollega la scheda' : '🔌 Scheda vera';
    btn.classList.toggle('on', !!SER.porta);
  };
  const log = (level, text) => addLog({ t: Date.now(), level, text: 'Scheda vera — ' + text });

  async function leggi(porta) {
    const dec = new TextDecoder();
    while (porta.readable && SER.porta === porta) {
      SER.lettore = porta.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await SER.lettore.read();
          if (done) break;
          if (value && value.length) appendSerial(V, dec.decode(value, { stream: true }), '', hex(value), performance.now() - SER.t0);
        }
      } catch (e) { if (!SER.chiudendo) log('warn', 'lettura interrotta: ' + (e.message || e)); }
      finally { try { SER.lettore.releaseLock(); } catch {} SER.lettore = null; }
      if (SER.chiudendo) break;
    }
  }
  async function apri(porta) {
    const baud = +document.getElementById('serial-baud').value;
    await porta.open({ baudRate: baud });
    SER.porta = porta; SER.t0 = performance.now(); SER.chiudendo = false;
    S.uart[V] = true; S.uartSel = V;
    renderUartTabs(); redrawSerial(); aggiorna();
    log('info', `porta aperta a ${baud.toLocaleString('it-IT')} baud. Il programma deve usare lo stesso baud (USART2 in CubeMX).`);
    leggi(porta);
  }
  async function chiudi() {
    const p = SER.porta;
    if (!p) return;
    SER.chiudendo = true;
    try { if (SER.lettore) await SER.lettore.cancel(); } catch {}
    try { await p.close(); } catch {}
    SER.porta = null; aggiorna();
  }
  btn.addEventListener('click', async () => {
    if (SER.porta) { await chiudi(); log('info', 'porta chiusa'); return; }
    try {
      const porta = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x0483 }] });   // 0x0483 = STMicroelectronics (ST-LINK)
      await apri(porta);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return;   // finestra chiusa senza scegliere
      log('error', `non riesco ad aprire la porta: ${e.message || e}. È già aperta da un altro programma (CubeIDE, monitor seriale)?`);
    }
  });
  // baud cambiato: si riapre la porta alla velocità nuova
  document.getElementById('serial-baud').addEventListener('change', async () => {
    if (!SER.porta) return;
    const p = SER.porta;
    await chiudi();
    try { await apri(p); } catch (e) { log('error', 'riapertura non riuscita: ' + (e.message || e)); }
  });
  if (ok) navigator.serial.addEventListener('disconnect', e => { if (e.target === SER.porta) { SER.porta = null; aggiorna(); log('warn', 'scheda scollegata dal cavo USB'); } });
  // invio dalla casella in basso quando è scelta la linguetta «Scheda vera»
  window.svSerialeVera = async bytes => {
    if (!SER.porta || !SER.porta.writable) { log('warn', 'scheda vera non collegata: premi «🔌 Scheda vera»'); return; }
    const w = SER.porta.writable.getWriter();
    try { await w.write(bytes); } finally { w.releaseLock(); }
  };
  aggiorna();

  // --------------------------------------------------------------
  // Carica sulla scheda
  const dlg = document.getElementById('carica-dlg');
  const st = { img: null, nome: '' };
  const $c = s => dlg.querySelector(s);
  function mostra(img, nome) {
    st.img = img; st.nome = nome;
    const ul = $c('[data-controlli]');
    ul.textContent = '';
    for (const c of controlla(img)) {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : 'err';
      li.textContent = (c.ok ? '✓ ' : '✗ ') + c.testo;
      ul.append(li);
    }
    const buono = controlla(img).every(c => c.ok);
    $c('[data-scarica]').disabled = !buono;
    $c('[data-scrivi]').disabled = !buono || !('showDirectoryPicker' in window);
    $c('[data-esito]').textContent = buono ? `${nome}.bin pronto.` : 'Il file non va bene per la NUCLEO-F401RE: guarda i punti segnati con ✗.';
  }
  async function leggiFile(f) {
    const nome = f.name.replace(/\.(elf|hex|bin)$/i, '').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'programma';
    try {
      if (/\.elf$/i.test(f.name)) mostra(daElf(await f.arrayBuffer()), nome);
      else if (/\.hex$/i.test(f.name)) mostra(daHex(await f.text()), nome);
      else if (/\.bin$/i.test(f.name)) mostra({ ind: FLASH, img: new Uint8Array(await f.arrayBuffer()) }, nome);
      else throw new Error('scegli il .elf (o .hex/.bin) che CubeIDE mette nella cartella Debug del progetto');
    } catch (e) { st.img = null; $c('[data-controlli]').textContent = ''; $c('[data-esito]').textContent = '✗ ' + (e.message || e); $c('[data-scarica]').disabled = $c('[data-scrivi]').disabled = true; }
  }
  // progetto della cartella collegata: il .elf si prende da solo dalla sua cartella Debug (niente selettore)
  async function daCartella() {
    const riga = $c('[data-cartella]');
    riga.hidden = true;
    const id = typeof S !== 'undefined' && S.selId, C = window.SV && SV.cartella;
    if (!id || !C || !C.eCartella(id) || !C.elf) return;
    const e = await C.elf(id).catch(() => null);
    riga.hidden = false;
    if (!e) { riga.textContent = 'Nella cartella collegata non c\'è ancora un .elf: in CubeIDE premi Build (il martello), poi riapri questa finestra.'; return; }
    riga.textContent = `Dalla cartella collegata: ${e.nome} (compilato ${new Date(e.quando).toLocaleString('it-IT')})` + (e.vecchio ? ' — ATTENZIONE: hai salvato i sorgenti dopo questa compilazione, rifai Build in CubeIDE per caricare il codice nuovo.' : '');
    const nome = e.nome.split('/').pop().replace(/\.elf$/i, '').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'programma';
    try { mostra(daElf(e.buf), nome); } catch (err) { $c('[data-esito]').textContent = '✗ ' + (err.message || err); }
  }
  document.getElementById('btn-carica').addEventListener('click', () => {
    st.img = null;
    $c('[data-controlli]').textContent = ''; $c('[data-esito]').textContent = '';
    $c('[data-scarica]').disabled = $c('[data-scrivi]').disabled = true;
    $c('[data-fs]').hidden = 'showDirectoryPicker' in window;
    dlg.showModal();
    daCartella();
  });
  $c('[data-file]').addEventListener('change', e => { const f = e.target.files[0]; if (f) leggiFile(f); e.target.value = ''; });
  $c('[data-scarica]').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([st.img.img], { type: 'application/octet-stream' }));
    a.download = st.nome + '.bin';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $c('[data-esito]').textContent = `Scaricato ${st.nome}.bin: trascinalo sul disco NODE_F401RE (la scheda lo scrive e riparte).`;
  });
  $c('[data-scrivi]').addEventListener('click', async () => {
    const esito = $c('[data-esito]');
    try {
      const dir = await window.showDirectoryPicker({ id: 'nucleo', mode: 'readwrite' });
      let mbed = false;
      for await (const [n] of dir.entries()) if (/^(MBED\.HTM|DETAILS\.TXT)$/i.test(n)) mbed = true;
      if (!mbed && !confirm(`«${dir.name}» non sembra il disco della Nucleo (manca MBED.HTM). Scrivo lo stesso ${st.nome}.bin?`)) return;
      esito.textContent = 'Scrivo…';
      const fh = await dir.getFileHandle(st.nome + '.bin', { create: true });
      const w = await fh.createWritable();
      await w.write(st.img.img);
      await w.close();
      esito.textContent = `Scritto ${st.nome}.bin su ${dir.name}: il LED COM del ST-LINK lampeggia mentre programma, poi la scheda riparte (il disco sparisce e ricompare).`;
      // dopo qualche secondo il ST-LINK mette FAIL.TXT se non è andata
      setTimeout(async () => {
        try { const f = await (await dir.getFileHandle('FAIL.TXT')).getFile(); esito.textContent = 'La scheda dice: ' + (await f.text()).trim().slice(0, 300); } catch {}
      }, 4000);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      esito.textContent = '✗ Non riesco a scrivere sul disco: ' + (e.message || e) + '. Usa «Scarica .bin» e trascinalo a mano.';
    }
  });
}

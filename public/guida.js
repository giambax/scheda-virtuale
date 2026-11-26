// guida.js — fase Q (26/11/2026): la guida completa (finestra «?» in alto, #help in index.html), consultabile in ogni
// momento: indice delle sezioni a sinistra, ricerca (tutte le parole, senza badare ad accenti e maiuscole) con le parole
// trovate evidenziate, «Giro guidato» per i 5 passi sullo schermo (layout.js). Il testo è statico, scritto da noi.
const dlg = document.getElementById('help');
if (dlg && dlg.classList.contains('guida')) {
  const testo = document.getElementById('guida-testo'), indice = document.getElementById('guida-indice'), cerca = document.getElementById('guida-cerca');
  const sezioni = [...testo.querySelectorAll('section[data-id]')];
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const testi = new Map(sezioni.map(s => [s, norm(s.textContent)]));
  // indice
  for (const s of sezioni) {
    const a = document.createElement('a');
    a.href = '#guida-' + s.dataset.id; a.dataset.id = s.dataset.id;
    a.textContent = s.querySelector('h3').textContent;
    a.addEventListener('click', e => { e.preventDefault(); vai(s.dataset.id); });
    indice.append(a);
    s.id = 'guida-' + s.dataset.id;
  }
  let fermo = 0;   // dopo un clic nell'indice lo scorrimento (morbido) non deve spostare la voce accesa
  function vai(id) {
    const s = sezioni.find(x => x.dataset.id === id);
    fermo = Date.now() + 900;
    if (!s) return;
    if (s.hidden) { cerca.value = ''; filtra(); }
    testo.scrollTop = s.offsetTop - testo.offsetTop - 4;
    indice.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.id === id));
  }
  // evidenzia le parole cercate (solo nei nodi di testo: il contenuto è nostro, niente HTML da fuori)
  function togliEvidenza() {
    for (const m of testo.querySelectorAll('mark.guida-trovato')) m.replaceWith(document.createTextNode(m.textContent));
    testo.normalize();
  }
  function evidenzia(s, parole) {
    const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT), nodi = [];
    while (w.nextNode()) nodi.push(w.currentNode);
    for (const n of nodi) {
      const t = n.nodeValue, tn = norm(t);   // stessa lunghezza: la normalizzazione toglie solo gli accenti combinati
      if (tn.length !== t.length) continue;
      const pezzi = [];
      let i = 0;
      while (i < t.length) {
        let trovato = null;
        for (const p of parole) if (tn.startsWith(p, i) && (!trovato || p.length > trovato.length)) trovato = p;
        if (trovato) { pezzi.push([i, i + trovato.length]); i += trovato.length; } else i++;
      }
      if (!pezzi.length) continue;
      const fr = document.createDocumentFragment();
      let k = 0;
      for (const [a, b] of pezzi) { if (a > k) fr.append(t.slice(k, a)); const m = document.createElement('mark'); m.className = 'guida-trovato'; m.textContent = t.slice(a, b); fr.append(m); k = b; }
      if (k < t.length) fr.append(t.slice(k));
      n.replaceWith(fr);
    }
  }
  function filtra() {
    togliEvidenza();
    const parole = norm(cerca.value).split(/\s+/).filter(p => p.length > 1);
    let n = 0;
    for (const s of sezioni) {
      const ok = !parole.length || parole.every(p => testi.get(s).includes(p));
      s.hidden = !ok; n += ok;
      indice.querySelector(`a[data-id="${s.dataset.id}"]`).hidden = !ok;
      if (ok && parole.length) evidenzia(s, parole);
    }
    testo.querySelector('.guida-vuoto').hidden = n > 0;
    testo.scrollTop = 0;
  }
  let t = null;
  cerca.addEventListener('input', () => { clearTimeout(t); t = setTimeout(filtra, 120); });
  document.getElementById('guida-chiudi').addEventListener('click', () => dlg.close());
  document.getElementById('guida-giro').addEventListener('click', () => { dlg.close(); window.SVlayout && SVlayout.tour(); });
  // la sezione in vista si accende nell'indice
  testo.addEventListener('scroll', () => {
    if (Date.now() < fermo) return;
    const y = testo.scrollTop + testo.offsetTop + 30;
    let cur = null;
    for (const s of sezioni) if (!s.hidden && s.offsetTop <= y) cur = s;
    if (cur) indice.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.id === cur.dataset.id));
  }, { passive: true });
  dlg.addEventListener('close', () => { if (cerca.value) { cerca.value = ''; filtra(); } });
  // apri(sezione): da altri punti del sito (es. il «?» del banco)
  window.SVguida = { apri(id) { if (!dlg.open) dlg.showModal(); if (id) vai(id); else cerca.focus(); }, filtra, sezioni: () => sezioni.map(s => s.dataset.id) };
}

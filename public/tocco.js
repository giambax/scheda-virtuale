// tocco.js — telefono e tablet (25/11/2026): "＋ Componente" (palette in un foglio dal basso), menu "⋯" della
// barra in alto, barretta flottante con la selezione (sul telefono non ci sono R, Canc, ⌘Z), menu della
// pressione lunga su un componente, tastiera virtuale (il foglio del pannello resta sopra).
// I gesti sulla breadboard (pizzico, due dita, tocco-tocco per i fili) sono in breadboard.js; il layout in mobile.css.
const $ = s => document.querySelector(s);
const B = window.BB;
const TEL = matchMedia('(max-width: 760px), (max-height: 520px)');
if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('tocco');
addEventListener('pointerdown', e => { if (e.pointerType === 'touch') document.body.classList.add('tocco'); }, { capture: true, passive: true });
const el = (tag, cls, txt) => { const x = document.createElement(tag); if (cls) x.className = cls; if (txt !== undefined) x.textContent = txt; return x; };
const bottone = (icona, testo, titolo, fn) => { const b = el('button'); b.type = 'button'; b.title = titolo; b.append(icona, el('span', '', testo)); b.addEventListener('click', fn); return b; };

// ------------------------------------------------------------------
// "＋ Componente": la palette sale dal basso; scelto un componente si richiude e si tocca dove posarlo
const bComp = el('button', 'primary', '＋ Componente');
bComp.type = 'button'; bComp.id = 'btn-componente'; bComp.title = 'Scegli un componente da mettere sulla breadboard';
$('.bb-barra').prepend(bComp);
export function palettaAperta(v) { document.body.classList.toggle('palette-aperta', v); bComp.classList.toggle('on', v); }
bComp.addEventListener('click', () => palettaAperta(!document.body.classList.contains('palette-aperta')));
addEventListener('bb-scelto', () => palettaAperta(false));
document.addEventListener('pointerdown', e => {
  if (document.body.classList.contains('palette-aperta') && !e.target.closest('#palette, #btn-componente')) palettaAperta(false);
});

// ------------------------------------------------------------------
// Menu "⋯": i comandi che sul telefono non stanno nella barra (Reset, Debug, velocità, Segnala, guida, tema)
const bAltro = $('#btn-altro');
const menu = el('div', 'menu-altro');
menu.setAttribute('role', 'menu');
document.body.append(menu);
function proxy(sel, icona, testo) {
  const o = $(sel);
  if (!o || o.hidden) return null;
  const b = el('button', '', `${icona}  ${testo}`);
  b.type = 'button'; b.disabled = o.disabled;
  b.addEventListener('click', () => { chiudiMenu(); o.click(); });
  return b;
}
function apriMenu() {
  menu.replaceChildren();
  const vel = $('#speed'), s = vel.cloneNode(true);
  s.removeAttribute('id'); s.value = vel.value;
  s.addEventListener('change', () => { vel.value = s.value; vel.dispatchEvent(new Event('change')); });
  const lv = el('label', '', 'Velocità'); lv.append(s);
  // vista al centro (in orizzontale i pulsanti Breadboard / Schema / Scheda sono nascosti)
  const vs = el('select');
  for (const [v, t] of [['breadboard', 'Breadboard'], ['schema', 'Schema'], ['scheda', 'Scheda e dispositivi']]) { const o = el('option', '', t); o.value = v; vs.append(o); }
  vs.value = document.body.dataset.vista || 'breadboard';
  vs.addEventListener('change', () => { chiudiMenu(); window.SVlayout && SVlayout.vista(vs.value); });
  const lvs = el('label', '', 'Vista'); lvs.append(vs);
  const voci = [lvs, proxy('#btn-reset', '⟲', 'Reset'), proxy('#btn-debug', '⏯', 'Debug passo passo'), lv, el('hr'),
    proxy('#btn-bug', '🐞', 'Segnala un bug'), proxy('#btn-segn-admin', '📋', 'Segnalazioni'), proxy('#btn-help', '?', 'Come si usa'),
    proxy('#btn-tour', '✦', 'Guida rapida'), proxy('#btn-tema', '◐', $('#btn-tema').textContent)];
  menu.append(...voci.filter(Boolean));
  const r = bAltro.getBoundingClientRect();
  menu.classList.add('aperto');
  menu.style.top = r.bottom + 6 + 'px';
  menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
  menu.style.left = 'auto';
  bAltro.setAttribute('aria-expanded', 'true');
}
function chiudiMenu() { menu.classList.remove('aperto'); bAltro.setAttribute('aria-expanded', 'false'); }
bAltro.addEventListener('click', () => menu.classList.contains('aperto') ? chiudiMenu() : apriMenu());
document.addEventListener('pointerdown', e => { if (menu.classList.contains('aperto') && !e.target.closest('.menu-altro, #btn-altro')) chiudiMenu(); });

// ------------------------------------------------------------------
// Barretta flottante: con una selezione Ruota / Copia / Elimina / Annulla (+ ◀ ▶ per encoder e potenziometro);
// mentre si posa un componente Ruota / Annulla; durante un filo Togli angolo / Annulla
const barra = el('div', 'bb-azioni');
barra.setAttribute('role', 'toolbar'); barra.setAttribute('aria-label', 'Azioni sulla selezione'); barra.hidden = true;
$('.bb-wrap').append(barra);
const solo = () => { const ids = [...B.sel]; return ids.length === 1 ? B.bb.comps.find(c => c.id === ids[0]) : null; };
let firma = '';
function aggiornaBarra() {
  const c = solo();
  const f = [B.sel.size, !!B.posa, !!B.filo, c && c.type, B.undo.length > 0, document.body.classList.contains('tocco')].join();
  if (f === firma) return;
  firma = f;
  barra.replaceChildren();
  if (B.posa) {
    barra.append(bottone('↻', 'Ruota', 'Ruota il componente prima di posarlo', () => { B.posaRot = ((B.posaRot || 0) + 1) % 4; B.sagomaPosa(); }),
      bottone('✕', 'Annulla', 'Non posarlo', () => B.annullaComando()));
  } else if (B.filo) {
    barra.append(bottone('⌫', 'Angolo', 'Togli l\'ultimo angolo del filo', () => B.togliAngolo()),
      bottone('✕', 'Annulla', 'Annulla il filo', () => B.annullaComando()));
  } else if (B.sel.size) {
    if (c && (c.type === 'encoder' || c.type === 'pot')) {
      const giro = dir => c.type === 'encoder' ? B.scatto(c.id, dir) : B.impostaPot(c, c.opt.pos + dir * 0.05);
      barra.append(bottone('◀', c.type === 'encoder' ? 'Antiorario' : 'Meno', 'Gira a sinistra', () => giro(-1)), bottone('▶', c.type === 'encoder' ? 'Orario' : 'Più', 'Gira a destra', () => giro(1)));
    }
    barra.append(bottone('↻', 'Ruota', 'Ruota di 90°', () => B.ruotaSel()), bottone('⧉', 'Copia', 'Duplica la selezione', () => B.duplica()),
      bottone('🗑', 'Elimina', 'Elimina la selezione', () => B.elimina()));
    const a = bottone('↩', 'Annulla', 'Annulla l\'ultima modifica', () => B.annulla()); a.disabled = !B.undo.length;
    barra.append(a);
  } else {
    const a = bottone('↩', 'Annulla', 'Annulla l\'ultima modifica', () => B.annulla()); a.disabled = !B.undo.length;
    barra.append(a);
  }
  barra.hidden = !(B.sel.size || B.posa || B.filo || B.undo.length);
}
setInterval(aggiornaBarra, 200);

// ------------------------------------------------------------------
// Pressione lunga su un componente: ruota, copia, elimina, proprietà
const bbMenu = el('div', 'bb-menu');
bbMenu.setAttribute('role', 'menu');
document.body.append(bbMenu);
const chiudiBbMenu = () => bbMenu.classList.remove('aperto');
addEventListener('bb-menu', e => {
  const { id, x, y } = e.detail, c = B.bb.comps.find(c => c.id === id);
  if (!c) return;
  if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
  B.sel = new Set([id]);
  const aperto = performance.now();
  // il dito che si alza dopo la pressione lunga non deve "cliccare" una voce
  const voce = (t, fn) => { const b = el('button', '', t); b.type = 'button'; b.addEventListener('click', () => { if (performance.now() - aperto < 400) return; chiudiBbMenu(); fn(); }); return b; };
  bbMenu.replaceChildren(el('b', '', `${c.label} — ${B.K.TIPI[c.type].nome}`),
    voce('↻  Ruota', () => B.ruotaSel()), voce('⧉  Copia', () => B.duplica()), voce('🗑  Elimina', () => B.elimina()),
    voce('⚙  Proprietà', () => {
      if (B.K.STRUMENTI.includes(c.type)) { B.apriPannello(id); return; }
      const i = $('#bb-prop input, #bb-prop select');
      if (i) { i.scrollIntoView({ block: 'nearest', inline: 'nearest' }); i.focus(); }
    }));
  bbMenu.classList.add('aperto');
  const w = bbMenu.offsetWidth, h = bbMenu.offsetHeight;
  // sotto il dito, o sopra, o (telefono in orizzontale) di fianco: mai coperto dal dito
  let left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)), top = y + 16;
  if (top + h > innerHeight - 8) top = y - h - 16;
  if (top < 8) { top = Math.max(8, Math.min(innerHeight - h - 8, y - h / 2)); left = x + 24 + w < innerWidth - 8 ? x + 24 : Math.max(8, x - w - 24); }
  bbMenu.style.left = left + 'px';
  bbMenu.style.top = top + 'px';
});
document.addEventListener('pointerdown', e => { if (bbMenu.classList.contains('aperto') && !e.target.closest('.bb-menu')) chiudiBbMenu(); });

// ------------------------------------------------------------------
// Tastiera virtuale (iPhone: la pagina non si accorcia): il foglio del pannello resta sopra la tastiera
if (window.visualViewport) {
  const vv = window.visualViewport;
  // anche sul tablet (punto I): il banco e il pannello si accorciano sopra la tastiera (mobile.css, body.tastiera)
  // e l'editor riporta in vista la riga dove si scrive
  const tastiera = () => {
    const h = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--tastiera', h + 'px');
    document.body.classList.toggle('tastiera', h > 80);
    const v = window.SVeditor && SVeditor.view;
    if (h > 80 && v && v.hasFocus) requestAnimationFrame(() => v.dispatch({ effects: v.constructor.scrollIntoView(v.state.selection.main.head, { y: 'center' }) }));
  };
  vv.addEventListener('resize', tastiera);
  vv.addEventListener('scroll', tastiera);
}
// il codice si scrive meglio con il foglio alto: aprendo l'editor sul telefono il pannello sale tutto
document.addEventListener('focusin', e => {
  if (TEL.matches && e.target.closest && e.target.closest('#pannello .cm-editor, #pannello input, #pannello textarea') && window.SVlayout) SVlayout.foglio('intero');
});

window.SVtocco = { palettaAperta, apriMenu, chiudiMenu, aggiornaBarra, TEL };

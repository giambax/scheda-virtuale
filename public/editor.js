// editor.js — editor del codice nel sito (CodeMirror 6, vendor/codemirror/codemirror.js).
// Sostituisce la vista "Codice" di app.js (solo lettura): file aperti a schede, colori del C,
// numeri di riga, ricerca (Ctrl/⌘+F), Salva e ricompila (Ctrl/⌘+S), errori del compilatore
// segnati nel codice. Usa S, $, showTab, doRun, selectProject di app.js.
import * as CM from '../vendor/codemirror/codemirror-2.js';

const E = {
  proj: null,          // progetto aperto nell'editor
  states: new Map(),   // file → EditorState (testo, annulla/ripeti, posizione)
  saved: new Map(),    // file → testo salvato (per sapere cosa è cambiato)
  open: [],            // schede aperte
  cur: null,
};

// debug (debug.js): breakpoint nella colonna dei numeri di riga e riga corrente evidenziata.
// Il contenuto lo decide debug.js (window.SVdbg): qui solo il disegno e il clic.
const aggiornaDbg = CM.StateEffect.define();
// ok: true, false (riga senza istruzioni) o 'cond' (con condizione o "dalla volta n", punto H)
class PuntoBP extends CM.GutterMarker { constructor(ok) { super(); this.ok = ok; } eq(o) { return o.ok === this.ok; } toDOM() { const d = document.createElement('span'); d.className = 'cm-bp' + (this.ok === 'cond' ? ' cm-bp-cond' : this.ok ? '' : ' cm-bp-no'); d.title = this.ok === 'cond' ? 'Breakpoint con condizione (clic destro per cambiarla, clic per toglierlo)' : this.ok ? 'Breakpoint (clic per toglierlo, clic destro per una condizione)' : 'Breakpoint su una riga senza istruzioni: si ferma alla prima istruzione dopo'; return d; } }
const BP_SI = new PuntoBP(true), BP_NO = new PuntoBP(false), BP_COND = new PuntoBP('cond');
const dbgGutter = () => CM.gutter({
  class: 'cm-bp-gutter',
  lineMarker(view, line) { const d = window.SVdbg; if (!d || !E.cur) return null; const n = view.state.doc.lineAt(line.from).number, st = d.statoBP(E.cur, n); return st === 1 ? BP_SI : st === 2 ? BP_NO : st === 3 ? BP_COND : null; },
  lineMarkerChange: u => u.transactions.some(t => t.effects.some(e => e.is(aggiornaDbg))),
  initialSpacer: () => BP_SI,
  domEventHandlers: {
    mousedown(view, line, ev) { if (ev.button === 2) return false; const d = window.SVdbg; if (!d || !E.cur) return false; d.cambiaBP(E.cur, view.state.doc.lineAt(line.from).number); return true; },
    contextmenu(view, line, ev) { const d = window.SVdbg; if (!d || !E.cur) return false; ev.preventDefault(); d.opzioniBP(E.cur, view.state.doc.lineAt(line.from).number); return true; },
  },
});
const rigaCorrente = CM.StateField.define({
  create: () => CM.Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(aggiornaDbg)) {
      const d = window.SVdbg, r = d && E.cur ? d.rigaCorrente(E.cur) : 0;
      if (!r || r > tr.state.doc.lines) return CM.Decoration.none;
      return CM.Decoration.set([CM.Decoration.line({ class: 'cm-riga-dbg' }).range(tr.state.doc.line(r).from)]);
    }
    return tr.docChanged ? v.map(tr.changes) : v;
  },
  provide: f => CM.EditorView.decorations.from(f),
});
function ridisegnaDbg() { view.dispatch({ effects: aggiornaDbg.of(null) }); }

// tema dell'editor: segue quello del sito (data-theme, scelto nel cassetto), anche quando cambia mentre si scrive.
// I colori di fondo, numeri di riga e selezione vengono dai token del sito (style.css, punto P); i colori della
// sintassi da oneDark (scuro) o dallo stile di base (chiaro).
const dark = () => document.documentElement.dataset.theme !== 'light';
const temaCM = new CM.Compartment();
const fondoCM = CM.EditorView.theme({
  '&': { backgroundColor: 'var(--code-bg)', color: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
});
const estTema = () => [dark() ? CM.oneDark : CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true }), fondoCM];
new MutationObserver(() => {
  const eff = { effects: temaCM.reconfigure(estTema()) };
  view.dispatch(eff);
  for (const [rel, st] of E.states) if (rel !== E.cur) E.states.set(rel, st.update(eff).state);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ro: file in sola lettura (dato da un esercizio)
function extensions(ro) {
  return [
    ...(ro ? [CM.EditorState.readOnly.of(true)] : []),
    dbgGutter(), rigaCorrente, CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.highlightSpecialChars(), CM.history(), CM.foldGutter(),
    CM.drawSelection(), CM.dropCursor(), CM.indentOnInput(), CM.bracketMatching(), CM.closeBrackets(),
    CM.rectangularSelection(), CM.crosshairCursor(), CM.highlightActiveLine(), CM.highlightSelectionMatches(),
    CM.cpp(), CM.lintGutter(),
    temaCM.of(estTema()),
    CM.keymap.of([
      ...CM.closeBracketsKeymap, ...CM.defaultKeymap, ...CM.searchKeymap, ...CM.historyKeymap, ...CM.foldKeymap, CM.indentWithTab,
    ]),
    CM.EditorView.updateListener.of(u => { if (u.docChanged) renderTabs(); }),
    CM.EditorView.theme({ '.cm-bp-gutter .cm-gutterElement': { cursor: 'pointer', padding: '0 2px 0 4px' }, '.cm-bp': { display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', background: '#e53935', boxShadow: '0 0 0 1px #0004' }, '.cm-bp-no': { background: 'transparent', border: '2px solid #e53935', width: '7px', height: '7px' }, '.cm-bp-cond': { background: '#fb8c00', borderRadius: '2px' }, '.cm-riga-dbg': { background: 'rgba(255, 196, 0, .22)', outline: '1px solid rgba(255, 196, 0, .55)' } }),
    CM.EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: '12.5px' } }),
  ];
}

const view = new CM.EditorView({ parent: document.getElementById('cm') });
view.dom.style.height = '100%';

const fileOf = rel => S.files.find(f => f.rel === rel);
const textOf = rel => E.cur === rel ? view.state.doc.toString() : (E.states.get(rel) ? E.states.get(rel).doc.toString() : (fileOf(rel) || {}).content);
const isDirty = rel => E.states.has(rel) && textOf(rel) !== E.saved.get(rel);
const errsFor = rel => {
  const f = fileOf(rel);
  return (S.server.buildErrors || []).filter(e => e.file && f && (e.file === f.rel || e.file.endsWith('/' + f.name) || e.file === f.name));
};

function diagnostics(state, rel) {
  return errsFor(rel).filter(e => e.line >= 1 && e.line <= state.doc.lines).map(e => {
    const l = state.doc.line(e.line);
    const from = Math.min(l.to, l.from + Math.max(0, (e.col || 1) - 1));
    return { from, to: Math.max(from, l.to), severity: 'error', message: e.msg };
  });
}

// passa al file rel (lo apre in una scheda se serve)
function show(rel, line) {
  const f = fileOf(rel);
  if (!f) return;
  if (E.cur && E.cur !== rel) E.states.set(E.cur, view.state);
  if (!E.states.has(rel)) {
    E.states.set(rel, CM.EditorState.create({ doc: f.content, extensions: extensions(f.ro) }));
    E.saved.set(rel, f.content);
  }
  if (!E.open.includes(rel)) E.open.push(rel);
  E.cur = rel;
  S.curFile = rel;
  view.setState(E.states.get(rel));
  view.dispatch(CM.setDiagnostics(view.state, diagnostics(view.state, rel)));
  ridisegnaDbg();
  if (line && line <= view.state.doc.lines) {
    const pos = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  }
  renderTabs();
}

function close(rel) {
  if (isDirty(rel) && !confirm(`${rel.split('/').pop()} ha modifiche non salvate: chiudere lo stesso?`)) return;
  E.open = E.open.filter(r => r !== rel);
  E.states.delete(rel);
  E.saved.delete(rel);
  if (E.cur === rel) { E.cur = null; show(E.open[E.open.length - 1] || (S.files[0] || {}).rel); }
  else renderTabs();
}

function renderTabs() {
  const el = document.getElementById('edtabs');
  el.innerHTML = E.open.map(rel => {
    const f = fileOf(rel) || { name: rel };
    const err = errsFor(rel).length > 0;
    return `<span class="edtab${rel === E.cur ? ' on' : ''}${err ? ' haserr' : ''}" data-f="${esc(rel)}" title="${esc(rel)}">${f.ro ? '<i class="ro" title="Sola lettura (lo dà l\'esercizio)">🔒</i>' : ''}${esc(f.name)}${isDirty(rel) ? '<i class="dirty" title="non salvato">●</i>' : ''}<b class="x" title="Chiudi">×</b></span>`;
  }).join('');
  el.querySelectorAll('.edtab').forEach(t => t.addEventListener('click', ev => {
    if (ev.target.classList.contains('x')) close(t.dataset.f); else show(t.dataset.f);
  }));
  const sel = document.getElementById('edopen');
  sel.innerHTML = '<option value="">＋ Apri file…</option>' + S.files.map(f => `<option value="${esc(f.rel)}">${esc(f.rel)}</option>`).join('');
  document.getElementById('btn-salva').disabled = !E.open.some(isDirty);
}

// salva i file cambiati nel browser (IndexedDB) e ricompila
async function saveAll() {
  if (E.cur) E.states.set(E.cur, view.state);
  const changed = E.open.filter(rel => isDirty(rel) && !(fileOf(rel) || {}).ro);   // i file in sola lettura non si salvano
  for (const rel of changed) {
    const t = textOf(rel);
    await SV.saveFile(E.proj, rel, t);
    E.saved.set(rel, t);
    const f = fileOf(rel);
    if (f) f.content = t;
  }
  renderTabs();
  return changed;
}
async function saveAndRun() {
  if (!S.selId) return;
  const changed = await saveAll();
  if (changed.length) SV.log('info', 'Salvato: ' + changed.map(r => r.split('/').pop()).join(', '));
  doRun(false);
}

// ------------------------------------------------------------------
// Al posto delle funzioni di app.js per la scheda "Codice"
window.renderFiles = function () {
  if (E.proj !== S.selId) {
    // cambio di progetto: le modifiche non salvate del progetto di prima si salvano da sole
    const prev = E.proj, pending = E.open.filter(isDirty).map(rel => [rel, textOf(rel)]);
    for (const [rel, t] of pending) SV.saveFile(prev, rel, t);
    E.proj = S.selId; E.states.clear(); E.saved.clear(); E.open = []; E.cur = null;
  } else {
    // stesso progetto ricaricato (es. ricaricato da una cartella): i file non toccati si aggiornano
    for (const rel of [...E.states.keys()]) {
      const f = fileOf(rel);
      if (!f) { E.states.delete(rel); E.open = E.open.filter(r => r !== rel); continue; }
      if (!isDirty(rel) && f.content !== E.saved.get(rel)) {
        E.states.set(rel, CM.EditorState.create({ doc: f.content, extensions: extensions(f.ro) }));
        E.saved.set(rel, f.content);
        if (rel === E.cur) E.cur = null;
      }
    }
  }
  renderTabs();
};
window.renderCode = function (gotoLine) {
  const rel = S.curFile && fileOf(S.curFile) ? S.curFile : (S.files[0] || {}).rel;
  if (!rel) { E.cur = null; view.setState(CM.EditorState.create({ doc: '' })); renderTabs(); return; }
  if (E.cur && E.cur !== rel) E.states.set(E.cur, view.state);
  if (E.cur === rel) E.states.set(rel, view.state);
  E.cur = null;
  show(rel, gotoLine || (!gotoLine && errsFor(rel)[0] && errsFor(rel)[0].line) || null);
};
window.gotoError = function (e) {
  const f = S.files.find(x => e.file && (x.rel === e.file || e.file.endsWith('/' + x.name) || x.name === e.file));
  if (!f) return;
  showTab('code');
  show(f.rel, e.line);
};

document.getElementById('edopen').addEventListener('change', e => { if (e.target.value) show(e.target.value); e.target.value = ''; });
document.getElementById('btn-salva').addEventListener('click', saveAndRun);
document.getElementById('btn-cerca').addEventListener('click', () => { view.focus(); CM.openSearchPanel(view); });
// Ctrl/⌘+S ovunque nella pagina: salva e ricompila
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveAndRun(); }
});
window.addEventListener('beforeunload', e => { if (E.open.some(isDirty)) { e.preventDefault(); e.returnValue = ''; } });
window.SVeditor = { show, saveAll, isDirty: () => E.open.some(isDirty), view, ridisegnaDbg, get file() { return E.cur; } };
if (S.selId) { window.renderFiles(); window.renderCode(); }

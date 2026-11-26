'use strict';
/* web-ui.js — parti dell'interfaccia che ci sono solo nella versione per il browser:
 * nome utente, progetti (nuovo, cartella/workspace, zip, rinomina, elimina, esporta).
 * L'editor del codice è in editor.js. Usa S, $, selectProject, loadProjects… di app.js. */

if (SV.account) setupAccount();
else {
  // senza account: solo un nome, come nella fase 1
  $('#utente-nome').textContent = SV.user;
  $('#btn-utente').addEventListener('click', () => {
    const n = (prompt('Nome utente (i progetti sono separati per nome):', SV.user) || '').trim();
    if (n && n !== SV.user) { SV.setUser(n); location.reload(); }
  });
}

// ------------------------------------------------------------------
// Account online (Supabase): stato della sincronizzazione e finestra "Il tuo account"
function setupAccount() {
  const acc = SV.account, R = SV.remote;
  $('#utente-nome').textContent = acc.username;
  $('#btn-utente').textContent = 'account';
  $('#btn-utente').title = 'Password, esci, elimina account, progetti di prima';
  const st = $('#sync-stato');
  st.hidden = false;
  const TXT = { ok: '☁ Sincronizzato', attesa: '☁ Da sincronizzare…', 'in corso': '☁ Sincronizzo…', offline: '☁ Offline: lavoro sulla copia nel browser', errore: '☁ Sincronizzazione non riuscita (clic per riprovare)', sessione: '☁ Sessione scaduta: clic per rientrare' };
  const showSync = x => {
    st.className = 'sync-stato small ' + x.stato.replace(' ', '');
    st.textContent = TXT[x.stato] || x.stato;
    if (x.stato === 'ok' && x.quando) st.title = 'Ultima sincronizzazione: ' + new Date(x.quando).toLocaleTimeString('it-IT') + ' — clic per sincronizzare adesso';
    if (x.errore) st.title = x.errore;
  };
  showSync(SV.syncStato);
  // sessione scaduta: ricaricando, la pagina chiede di nuovo nome utente e password (la copia nel browser resta)
  st.addEventListener('click', async () => {
    if (SV.syncStato.stato !== 'sessione') return SV.syncNow();
    if (window.SVeditor && SVeditor.isDirty()) await SVeditor.saveAll();
    location.reload();
  });
  window.addEventListener('sv-sync', async ev => {
    showSync(ev.detail);
    const r = ev.detail.rapporto;
    if (ev.detail.stato !== 'ok' || !r) return;
    if (!(r.scaricati.length || r.eliminatiQui.length || r.conflitti.length || r.inviati.length)) return;
    await loadProjects();
    if (S.selId && !S.projects.some(p => p.id === S.selId)) { if (S.projects[0]) selectProject(S.projects[0].id); }
    else if (S.selId && r.scaricati.includes(S.selId) && !(window.SVeditor && SVeditor.isDirty())) selectProject(S.selId, true);
  });

  const d = $('#account'), m = t => { $('#acc-io-msg').textContent = t; $('#acc-io-msg').className = 'acc-msg'; };
  async function fillOld() {
    const old = await SV.oldUsers();
    const el = $('#acc-vecchi');
    const names = Object.keys(old);
    if (!names.length) { el.textContent = 'Nessuno in questo browser.'; return; }
    el.innerHTML = names.map(n => `<div class="riga">«${esc(n)}»: ${old[n]} progett${old[n] === 1 ? 'o' : 'i'} <button type="button" data-old="${esc(n)}">Copia nel mio account</button></div>`).join('');
    el.querySelectorAll('[data-old]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      const got = await SV.importOld(b.dataset.old);
      m(`Copiati ${got.length} progetti: ${got.join(', ')}. Si caricano online alla prossima sincronizzazione.`);
      await loadProjects();
      SV.syncNow();
    }));
  }
  // modi di entrare: password sì/no, Google/GitHub collegati (collega / scollega)
  const NOMI = { google: 'Google', github: 'GitHub' };
  async function fillMethods() {
    const box = $('#acc-metodi-box'), el = $('#acc-metodi');
    let x;
    try { x = await R.methods(); } catch (e) { box.hidden = !(R.providers || []).length; el.textContent = 'Non riesco a leggerli adesso: ' + e.message; return; }
    const linked = Object.fromEntries(x.providers.map(p => [p.provider, p]));
    const elenco = [...new Set([...(R.providers || []), ...Object.keys(linked)])];
    $('#acc-pw-titolo').textContent = x.password ? 'Cambia password' : 'Imposta una password';
    $('#acc-pw-spiega').hidden = x.password;
    $('#btn-cambia-pw').textContent = x.password ? 'Cambia' : 'Imposta';
    box.hidden = !elenco.length;
    el.innerHTML = `<div class="riga"><span>Nome utente (o email) e password</span><b>${x.password ? 'sì' : 'no'}</b></div>` +
      elenco.map(p => linked[p]
        ? `<div class="riga"><span>${NOMI[p] || esc(p)}: collegato${linked[p].email ? ' (' + esc(linked[p].email) + ')' : ''}</span><button type="button" data-scollega="${p}" ${x.identita < 2 ? 'disabled title="È l\'unico modo con cui entri"' : ''}>Scollega</button></div>`
        : `<div class="riga"><span>${NOMI[p] || esc(p)}: non collegato</span><button type="button" data-collega="${p}">Collega</button></div>`).join('');
    el.querySelectorAll('[data-collega]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      if (window.SVeditor && SVeditor.isDirty()) await SVeditor.saveAll();
      try { await R.link(b.dataset.collega); } catch (e) { m(e.message); b.disabled = false; }   // se va, si torna qui dal provider
    }));
    el.querySelectorAll('[data-scollega]').forEach(b => b.addEventListener('click', async () => {
      const p = b.dataset.scollega;
      if (!confirm(`Scollegare ${NOMI[p] || p}? Non potrai più entrare con quell'account (puoi ricollegarlo quando vuoi).`)) return;
      b.disabled = true;
      try { await R.unlink(p); m(`${NOMI[p] || p} scollegato.`); } catch (e) { m(e.message); }
      fillMethods();
    }));
  }
  function openAccount(avviso) {
    $('#acc-io-nome').textContent = acc.username;
    $('#acc-io-email').textContent = acc.email || '';
    m(avviso ? avviso.testo : '');
    $('#acc-io-msg').className = 'acc-msg' + (avviso ? (avviso.ok ? ' ok' : ' err') : '');
    fillOld();
    fillMethods();
    if (!d.open) d.showModal();
  }
  $('#btn-utente').addEventListener('click', () => openAccount());
  // di ritorno da Google/GitHub (collega account, o errore) già dentro: il messaggio qui
  if (acc.avviso) openAccount(acc.avviso);
  $('#btn-cambia-pw').addEventListener('click', async () => {
    const pw = $('#acc-cambia-pw').value;
    if (pw.length < 8) return m('La password deve avere almeno 8 caratteri.');
    if (pw !== $('#acc-cambia-pw2').value) return m('Le due password non sono uguali.');
    const nuova = $('#btn-cambia-pw').textContent === 'Imposta';
    try {
      await R.updatePassword(pw);
      $('#acc-cambia-pw').value = $('#acc-cambia-pw2').value = '';
      m(nuova ? `Password impostata: ora puoi entrare anche con «${acc.username}» (o l'email) e questa password.` : 'Password cambiata.');
      fillMethods();
    } catch (e) { m(e.message); }
  });
  $('#btn-esci').addEventListener('click', async () => {
    if (window.SVeditor && SVeditor.isDirty()) await SVeditor.saveAll();
    await SV.syncNow();
    const n = await SV.pending();
    if (n && !confirm(`${n} modific${n === 1 ? 'a non è' : 'he non sono'} ancora online (sei offline?). Se esci adesso restano solo in questo browser e le ritrovi rientrando qui. Esco lo stesso?`)) return;
    // tutto online: la copia in questo browser si cancella (computer condivisi a scuola)
    if (!n) await SV.clearLocal();
    try { localStorage.removeItem('sv-ultimo-account'); } catch {}
    await R.signOut();
    location.reload();
  });
  $('#btn-elimina-account').addEventListener('click', async () => {
    const n = prompt(`Per eliminare l'account e TUTTI i progetti online scrivi il tuo nome utente (${acc.username}):`);
    if ((n || '').trim().toLowerCase() !== acc.username) return m('Account non eliminato.');
    try {
      await R.deleteAccount();
      await SV.clearLocal();                                  // anche la copia in questo browser
      try { localStorage.removeItem('sv-ultimo-account'); } catch {}
      alert('Account eliminato.');
      location.reload();
    } catch (e) { m('Non riuscito: ' + e.message); }
  });
}

// stato del compilatore (la prima volta si scarica: ~27 MB compressi)
function showComp(m) {
  const el = $('#comp-stato');
  if (!m) return;
  if (m.ready) el.textContent = `Compilatore pronto (${(m.ms / 1000).toFixed(1)} s)`;
  else el.textContent = `Preparo il compilatore… ${Math.round(100 * m.done / m.total)}%`;
}
window.addEventListener('sv-compilatore', ev => showComp(ev.detail));
showComp(SV.compStato);

// azioni sul progetto scelto
const _renderProjects = window.renderProjects;
window.renderProjects = function () { _renderProjects(); $('#progazioni').hidden = !S.selId; };
$('#progazioni').hidden = !S.selId;

async function afterImport(names) {
  await loadProjects();
  if (names[0]) await selectProject(names[0]);
  if (names.length) SV.log('info', 'Caricato: ' + names.join(', '));
}

// sceglie quali progetti caricare (workspace con più progetti) e se sostituire quelli con lo stesso nome
async function choose(projs) {
  const same = [];
  for (const p of projs) if (await SV.exists(p.nome)) same.push(p.nome);
  if (projs.length === 1 && !same.length) return { list: projs, replace: false };
  $('#scegli-titolo').textContent = projs.length > 1 ? `Ho trovato ${projs.length} progetti: quali carico?` : 'Questo progetto c\'è già';
  $('#scegli-lista').innerHTML = projs.map((p, i) => `<label><input type="checkbox" data-i="${i}" ${projs.length === 1 ? 'checked' : ''}> <b>${esc(p.nome)}</b> <span class="muted small">${esc(p.root || '')} · ${Object.keys(p.files).length} file${same.includes(p.nome) ? ' · c\'è già' : ''}</span></label>`).join('');
  $('#scegli-sostituisci').checked = projs.length === 1;
  $('#scegli-sostituisci').parentElement.hidden = !same.length;
  const d = $('#scegli');
  d.showModal();
  const ok = await new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'si'), { once: true }));
  if (!ok) return { list: [], replace: false };
  return { list: [...d.querySelectorAll('[data-i]')].filter(c => c.checked).map(c => projs[+c.dataset.i]), replace: $('#scegli-sostituisci').checked };
}
async function importFiles(files, fallback) {
  const projs = SV.findProjects(files, fallback);
  if (!projs.length) return alert('Non trovo nessun progetto: serve almeno un main.c (meglio la cartella del progetto CubeIDE, quella con il file .ioc).');
  const { list, replace } = await choose(projs);
  if (list.length) await afterImport(await SV.addProjects(list, replace));
}

// cartella (di un progetto o di un intero workspace): si leggono solo sorgenti, header, .ioc e .cproject
$('#in-cartella').addEventListener('change', async e => {
  const list = [...e.target.files].filter(f => /\.(c|h|ioc)$|(^|\/)\.cproject$|\.scheda-virtuale\.json$/.test(f.webkitRelativePath) &&
    !/\/(Drivers|Middlewares|Debug|Release|\.metadata)\//.test(f.webkitRelativePath));
  e.target.value = '';
  const files = {};
  await Promise.all(list.map(async f => { files[f.webkitRelativePath] = new Uint8Array(await f.arrayBuffer()); }));
  try { await importFiles(files); } catch (err) { alert(err.message); }
});
$('#in-zip').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { await importFiles(SV.unzip(await f.arrayBuffer()), f.name.replace(/\.zip$/i, '')); } catch (err) { alert('Zip non leggibile: ' + err.message); }
});

$('#btn-nuovo').addEventListener('click', async () => {
  const n = (prompt('Nome del nuovo progetto:', 'Nuovo_progetto') || '').trim();
  if (!n) return;
  const nome = await SV.newProject(n);
  await afterImport([nome]);
  showTab('code');
});
// progetti d'esempio (public/esempi, strumenti/crea-esempi.py): codice + circuito già collegato
fetch('esempi/elenco.json?v=2026-11-26c').then(r => r.json()).then(el => {
  const sel = $('#sel-esempio');
  for (const e of el) { const o = document.createElement('option'); o.value = e.id; o.textContent = e.nome; o.title = e.descr; sel.append(o); }
}).catch(() => {});
$('#sel-esempio').addEventListener('change', async e => {
  const id = e.target.value;
  e.target.value = '';
  if (!id) return;
  try {
    const nome = await SV.newProject(null, id);
    await afterImport([nome]);
    showTab('code');
  } catch (err) { alert('Esempio non caricato: ' + (err.message || err)); }
});
$('#btn-rinomina').addEventListener('click', async () => {
  const n = (prompt('Nuovo nome del progetto:', S.selId) || '').trim();
  if (!n || n === S.selId) return;
  try { const nome = await SV.rename(S.selId, n); await loadProjects(); await selectProject(nome); } catch (err) { alert(err.message); }
});
$('#btn-elimina').addEventListener('click', async () => {
  const dove = SV.account ? 'dal tuo account (anche online e sugli altri computer)' : 'da questo browser';
  if (!confirm(`Eliminare il progetto "${S.selId}" ${dove}? (Se non l'hai esportato, è perso.)`)) return;
  await SV.remove(S.selId);
  S.selId = null; S.files = []; S.proj = null;
  await loadProjects();
  if (S.projects[0]) selectProject(S.projects[0].id); else { renderFiles(); renderCode(); }
});

function download(data, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#btn-esporta').addEventListener('click', async () => download(await SV.exportZip(), `scheda-virtuale-${SV.user}.zip`));
$('#btn-esporta1').addEventListener('click', async () => {
  if (window.SVeditor) await SVeditor.saveAll();
  download(await SV.exportZip(S.selId), `${S.selId}.zip`);
});

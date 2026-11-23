// auth.js — accesso, iscrizione, password dimenticata e nuova password (dialogo #accesso).
// accedi(remote) risolve con {id, username, email} quando si è dentro. Se c'è già una sessione
// salvata (anche offline) entra subito, senza chiedere niente.
const $ = s => document.querySelector(s);

function pane(name) {
  for (const p of document.querySelectorAll('#accesso [data-pane]')) p.hidden = p.dataset.pane !== name;
  for (const t of document.querySelectorAll('#accesso [data-vai]')) t.classList.toggle('on', t.dataset.vai === name);
  $('#acc-msg').textContent = '';
  $('#acc-msg').className = 'acc-msg';
  const first = document.querySelector(`#accesso [data-pane="${name}"] input`);
  if (first) setTimeout(() => first.focus(), 0);
}
function msg(text, ok = false) { $('#acc-msg').textContent = text; $('#acc-msg').className = 'acc-msg ' + (ok ? 'ok' : 'err'); }
async function busy(form, fn) {
  const b = form.querySelector('button[type=submit]');
  b.disabled = true;
  try { return await fn(); } catch (e) { msg(e.message || String(e)); return null; } finally { b.disabled = false; }
}

// nuova password dopo il link "password dimenticata" (la sessione di recupero la crea Supabase)
function askNewPassword(remote) {
  const d = $('#accesso');
  if (!d.open) d.showModal();
  pane('nuova');
  return new Promise(res => {
    $('#acc-nuova').onsubmit = ev => {
      ev.preventDefault();
      const p1 = $('#acc-nuova-pw').value, p2 = $('#acc-nuova-pw2').value;
      if (p1.length < 8) return msg('La password deve avere almeno 8 caratteri.');
      if (p1 !== p2) return msg('Le due password non sono uguali.');
      busy(ev.target, async () => { await remote.updatePassword(p1); msg('Password cambiata.', true); res(); });
    };
  });
}

export async function accedi(remote) {
  const d = $('#accesso');
  d.addEventListener('cancel', e => e.preventDefault());
  for (const t of document.querySelectorAll('#accesso [data-vai]')) t.addEventListener('click', e => { e.preventDefault(); pane(t.dataset.vai); });
  const done = async u => {
    history.replaceState(null, '', location.pathname + location.search);   // via i token dall'indirizzo
    d.close();
    try { localStorage.setItem('sv-ultimo-account', JSON.stringify(u)); } catch {}
    return u;
  };
  let u = null;
  try { u = await remote.session(); } catch {}
  if (!u && !navigator.onLine) {
    // offline e sessione scaduta: si lavora sulla copia nel browser dell'ultimo account usato qui
    let last = null;
    try { last = JSON.parse(localStorage.getItem('sv-ultimo-account')); } catch {}
    if (last && last.id) return last;
  }
  if (u && remote.recovering) { await askNewPassword(remote); return done(u); }
  if (u) return done(u);

  d.showModal();
  pane('entra');
  if (remote.linkError) { history.replaceState(null, '', location.pathname + location.search); msg(remote.linkError); }
  return new Promise(res => {
    remote.onRecovery(async () => { await askNewPassword(remote); res(done(await remote.session())); });
    $('#acc-entra').onsubmit = ev => {
      ev.preventDefault();
      busy(ev.target, async () => { const user = await remote.signIn($('#acc-login').value, $('#acc-pw').value); res(done(user)); });
    };
    $('#acc-iscriviti').onsubmit = ev => {
      ev.preventDefault();
      const nome = $('#acc-nuovo-nome').value.trim().toLowerCase(), email = $('#acc-email').value.trim();
      const p1 = $('#acc-nuovo-pw').value, p2 = $('#acc-nuovo-pw2').value;
      if (p1.length < 8) return msg('La password deve avere almeno 8 caratteri.');
      if (p1 !== p2) return msg('Le due password non sono uguali.');
      busy(ev.target, async () => {
        const r = await remote.signUp(nome, email, p1);
        if (r.confirm) { pane('entra'); $('#acc-login').value = nome; msg(`Account creato. Ti ho mandato una mail a ${email}: apri il link per confermare, poi entra qui.`, true); return; }
        res(done(await remote.session()));
      });
    };
    $('#acc-dimenticata').onsubmit = ev => {
      ev.preventDefault();
      busy(ev.target, async () => { await remote.resetPassword($('#acc-recupero').value); msg('Se l\'email è giusta, ti arriva un link per scegliere una nuova password (guarda anche nella posta indesiderata).', true); });
    };
  });
}

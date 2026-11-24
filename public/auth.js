// auth.js — accesso, iscrizione, password dimenticata e nuova password (dialogo #accesso).
// accedi(remote) risolve con {id, username, email} quando si è dentro. Se c'è già una sessione
// salvata (anche offline) entra subito, senza chiedere niente.
// Con Google/GitHub (config.js PROVIDER_ATTIVI): pulsanti "Continua con…", e al primo accesso la
// scelta del nome utente (pane "nome"). Se si torna da Google/GitHub già dentro (collega account,
// o errore), il messaggio va in u.avviso e lo mostra web-ui.js nella finestra "Il tuo account".
import { PROVIDER } from './remote.js';
const $ = s => document.querySelector(s);
let providers = [];

function pane(name) {
  for (const p of document.querySelectorAll('#accesso [data-pane]')) p.hidden = p.dataset.pane !== name;
  $('#acc-social').hidden = !providers.length || !['entra', 'iscriviti'].includes(name);
  $('#accesso .acc-tabs').hidden = name === 'nome';
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

// primo accesso con Google/GitHub: il profilo non ha ancora un nome utente
function askUsername(remote, u) {
  const d = $('#accesso');
  if (!d.open) d.showModal();
  pane('nome');
  $('#acc-nome-scelto').value = u.suggerito || '';
  return new Promise(res => {
    $('#acc-nome').onsubmit = ev => {
      ev.preventDefault();
      busy(ev.target, async () => { u.username = await remote.setUsername($('#acc-nome-scelto').value); delete u.suggerito; res(u); });
    };
    $('#acc-nome-esci').onclick = async ev => { ev.preventDefault(); await remote.signOut(); location.reload(); };
  });
}

export async function accedi(remote) {
  const d = $('#accesso');
  d.addEventListener('cancel', e => e.preventDefault());
  providers = remote.providers || [];
  for (const b of document.querySelectorAll('#acc-social [data-provider]')) {
    b.hidden = !providers.includes(b.dataset.provider);
    b.onclick = () => {
      b.disabled = true;
      msg('');
      remote.signInOAuth(b.dataset.provider).catch(e => msg(e.message || String(e))).finally(() => { b.disabled = false; });
    };
  }
  for (const t of document.querySelectorAll('#accesso [data-vai]')) t.addEventListener('click', e => { e.preventDefault(); pane(t.dataset.vai); });
  const done = async u => {
    history.replaceState(null, '', location.pathname + location.search);   // via i token dall'indirizzo
    d.close();
    try { localStorage.setItem('sv-ultimo-account', JSON.stringify(u)); } catch {}
    return u;
  };
  const conNome = async u => (u && !u.username ? askUsername(remote, u) : u);   // OAuth: nome da scegliere
  let u = null;
  try { u = await remote.session(); } catch {}
  if (!u && !navigator.onLine) {
    // offline e sessione scaduta: si lavora sulla copia nel browser dell'ultimo account usato qui
    let last = null;
    try { last = JSON.parse(localStorage.getItem('sv-ultimo-account')); } catch {}
    if (last && last.id) return last;
  }
  if (u && remote.recovering) { await askNewPassword(remote); return done(await conNome(u)); }
  u = await conNome(u);
  if (u) {
    await done(u);
    const e = remote.oauthEsito;
    if (remote.linkError) u.avviso = { testo: remote.linkError, ok: false };
    else if (e && e.tipo === 'collega') u.avviso = { testo: `Account ${PROVIDER[e.provider] || e.provider} collegato: ora puoi entrare anche con quello.`, ok: true };
    return u;
  }

  d.showModal();
  pane('entra');
  if (remote.linkError) { history.replaceState(null, '', location.pathname + location.search); msg(remote.linkError); }
  return new Promise(res => {
    remote.onRecovery(async () => { await askNewPassword(remote); res(done(await conNome(await remote.session()))); });
    $('#acc-entra').onsubmit = ev => {
      ev.preventDefault();
      busy(ev.target, async () => {
        const user = await remote.signIn($('#acc-login').value, $('#acc-pw').value);
        res(done(await conNome(user)));   // account creato con Google/GitHub e poi password, senza nome
      });
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
        res(done(await conNome(await remote.session())));
      });
    };
    $('#acc-dimenticata').onsubmit = ev => {
      ev.preventDefault();
      busy(ev.target, async () => { await remote.resetPassword($('#acc-recupero').value); msg('Se l\'email è giusta, ti arriva un link per scegliere una nuova password (guarda anche nella posta indesiderata).', true); });
    };
  });
}

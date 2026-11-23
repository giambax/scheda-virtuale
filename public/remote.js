// remote.js — account e progetti online. Due realizzazioni con la stessa interfaccia:
//   supabaseRemote  il vero (Supabase: Auth + tabella projects, vedi supabase/schema.sql)
//   fintoRemote     finto, in memoria del browser (localStorage), per provare sito e sincronizzazione
// I file dei progetti viaggiano come testo: { "Core/Src/main.c": "…", … }.
//
// Interfaccia:
//   auth: session() → {id, username, email}|null · signUp(username, email, password) → {confirm}
//         signIn(login, password) · signOut() · resetPassword(email) · updatePassword(pw)
//         deleteAccount() · onRecovery(cb) · recovering (aperto il link "password dimenticata")
//         linkError (testo se il link di una email è scaduto o già usato)
//   dati: list() → [{id, name, version, updated_at}] · get(id) → {id, name, files, devices, version}
//         insert({name, files, devices}) → {id, version}   (errore .code 'nome' se il nome c'è già)
//         update(id, base, {name, files, devices}) → {version} | null se online è cambiato (conflitto)
//         remove(id)
// Errori (.code): 'rete' (offline: il sito resta sulla copia locale e riprova dopo), 'sessione'
// (scaduta: bisogna rientrare), 'limite' (troppi progetti o MB: si salta solo quel progetto),
// 'nome', 'auth', 'dati', 'errore'.

const USER_RE = /^[a-z0-9_.-]{3,20}$/;
export const validUsername = u => USER_RE.test(u);

class RemoteError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const isNet = e => (typeof navigator !== 'undefined' && !navigator.onLine) || /fetch|network|Failed to fetch|NetworkError|Load failed/i.test(String(e && (e.message || e)));
const wrap = e => {
  if (e instanceof RemoteError) return e;
  const m = (e && e.message) || String(e);
  if (isNet(e)) return new RemoteError('Sei offline: lavoro sulla copia nel browser.', 'rete');
  if (/^limite:/.test(m)) return new RemoteError(m.replace(/^limite:\s*/, ''), 'limite');
  if (/JWT|row-level security|permission denied/i.test(m)) return new RemoteError('Sessione scaduta: rientra nel tuo account.', 'sessione');
  return new RemoteError(m, 'errore');
};

// messaggi di Supabase Auth in italiano (i più comuni)
function authMsg(e) {
  const m = String(e && e.message || e);
  if (isNet(e) || (e && e.code === 'rete')) return 'Non riesco a collegarmi al server degli account: controlla la connessione a Internet.';
  if (/Invalid login credentials/i.test(m)) return 'Nome utente (o email) o password sbagliati.';
  if (/Email not confirmed/i.test(m)) return 'Devi ancora confermare l\'email: apri il link che ti è arrivato.';
  if (/already registered|already been registered|already exists/i.test(m)) return 'Con questa email c\'è già un account: accedi, o usa "Password dimenticata".';
  if (/Password should be at least|weak.?password/i.test(m)) return 'La password è troppo corta o troppo semplice (almeno 8 caratteri).';
  if (/should be different/i.test(m)) return 'La nuova password deve essere diversa da quella di prima.';
  if (/rate limit|too many|over_email_send_rate_limit/i.test(m)) return 'Troppi tentativi o troppe email in poco tempo: riprova tra un po\'.';
  if (/Database error saving new user/i.test(m)) return 'Nome utente non valido o già preso.';
  if (/Unable to validate email|invalid.*email/i.test(m)) return 'Email non valida.';
  if (/Auth session missing|session.*expired|refresh token/i.test(m)) return 'La sessione è scaduta: rientra nel tuo account.';
  return m;
}

// il link della email (conferma o password dimenticata) apre il sito con #…type=recovery o #error=…
function readLink(hash) {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  let linkError = null;
  if (h.get('error') || h.get('error_code')) {
    linkError = /otp_expired|expired/i.test(h.get('error_code') + ' ' + h.get('error_description'))
      ? 'Il link della email è scaduto o è già stato usato: chiedine un altro.'
      : 'Il link della email non è valido: ' + (h.get('error_description') || h.get('error')).replace(/\+/g, ' ');
  }
  return { recovering: h.get('type') === 'recovery', linkError };
}
// dove riportano i link delle email: la pagina stessa (così vale sia sotto /scheda-virtuale/ sia in locale)
function backHere(cfg) {
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin + location.pathname;
  return cfg.SITE_URL;
}

// ------------------------------------------------------------------
// createClient si può passare per le prove (strumenti/prova-auth.mjs), altrimenti è quello vero
export async function supabaseRemote(cfg, createClient = null) {
  if (!createClient) ({ createClient } = await import('../vendor/supabase/supabase.js'));
  // va letto PRIMA di createClient: supabase-js legge i token dall'indirizzo e poi lo svuota
  const link = readLink(typeof location !== 'undefined' ? location.hash : '');
  const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  const recovery = [];
  sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') { link.recovering = true; recovery.forEach(cb => cb()); } });
  const cacheKey = id => 'sv-username:' + id;
  const chk = r => { if (r.error) throw wrap(r.error); return r.data; };
  // le operazioni sui progetti solo con una sessione valida: senza, RLS darebbe un elenco vuoto
  // (e la sincronizzazione penserebbe che i progetti siano stati eliminati online)
  const need = async () => {
    let r;
    try { r = await sb.auth.getSession(); } catch (e) { throw wrap(e); }
    if (r.error && isNet(r.error)) throw wrap(r.error);
    if (!r.data || !r.data.session) throw new RemoteError('Sessione scaduta: rientra nel tuo account.', 'sessione');
  };
  const data = async fn => { await need(); try { return chk(await fn()); } catch (e) { throw wrap(e); } };

  async function who(user) {
    if (!user) return null;
    let username = null;
    try { username = localStorage.getItem(cacheKey(user.id)); } catch {}
    try {
      const r = await sb.from('profiles').select('username').eq('id', user.id).maybeSingle();
      if (r.data) { username = r.data.username; try { localStorage.setItem(cacheKey(user.id), username); } catch {} }
    } catch {}
    return { id: user.id, email: user.email, username: username || (user.user_metadata || {}).username || user.email };
  }
  return {
    kind: 'supabase',
    get recovering() { return link.recovering; },
    get linkError() { return link.linkError; },
    async session() { const { data } = await sb.auth.getSession(); return who(data && data.session && data.session.user); },
    async signUp(username, email, password) {
      username = username.trim().toLowerCase();
      if (!validUsername(username)) throw new RemoteError('Nome utente: 3–20 caratteri tra a-z, 0-9, _ . -', 'dati');
      let ok;
      try { ok = chk(await sb.rpc('username_disponibile', { nome: username })); } catch (e) { throw new RemoteError(authMsg(e), 'auth'); }
      if (!ok) throw new RemoteError('Questo nome utente è già preso.', 'dati');
      let r;
      try { r = await sb.auth.signUp({ email: email.trim(), password, options: { data: { username }, emailRedirectTo: backHere(cfg) } }); } catch (e) { throw new RemoteError(authMsg(e), 'auth'); }
      if (r.error) throw new RemoteError(authMsg(r.error), 'auth');
      // email già usata (e confermata): Supabase non dà errore ma restituisce un utente senza identità
      if (r.data.user && Array.isArray(r.data.user.identities) && !r.data.user.identities.length) throw new RemoteError(authMsg('already registered'), 'auth');
      return { confirm: !r.data.session };
    },
    async signIn(login, password) {
      let email = login.trim();
      if (!email.includes('@')) {
        try { email = chk(await sb.rpc('email_per_accesso', { nome: email, password })); } catch (e) { throw new RemoteError(authMsg(e), 'auth'); }
        if (!email) throw new RemoteError('Nome utente o password sbagliati (dopo 10 errori di fila aspetta 15 minuti, o entra con l\'email).', 'auth');
      }
      let r;
      try { r = await sb.auth.signInWithPassword({ email, password }); } catch (e) { throw new RemoteError(authMsg(e), 'auth'); }
      if (r.error) throw new RemoteError(authMsg(r.error), 'auth');
      return who(r.data.user);
    },
    async signOut() { try { await sb.auth.signOut({ scope: 'local' }); } catch {} },
    async resetPassword(email) {
      let r;
      try { r = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: backHere(cfg) }); } catch (e) { throw new RemoteError(authMsg(e), 'auth'); }
      if (r.error) throw new RemoteError(authMsg(r.error), 'auth');
    },
    async updatePassword(password) {
      let r;
      try { r = await sb.auth.updateUser({ password }); } catch (e) { throw new RemoteError(authMsg(e), 'auth'); }
      if (r.error) throw new RemoteError(authMsg(r.error), 'auth');
    },
    async deleteAccount() {
      const { data } = await sb.auth.getSession();
      chk(await sb.rpc('elimina_account'));
      try { if (data.session) localStorage.removeItem(cacheKey(data.session.user.id)); } catch {}
      try { await sb.auth.signOut({ scope: 'local' }); } catch {}
    },
    onRecovery(cb) { recovery.push(cb); },

    list: () => data(() => sb.from('projects').select('id,name,version,updated_at')),
    get: id => data(() => sb.from('projects').select('id,name,files,devices,version').eq('id', id).maybeSingle()),
    async insert(p) {
      await need();
      let r;
      try { r = await sb.from('projects').insert({ name: p.name, files: p.files, devices: p.devices }).select('id,version').single(); } catch (e) { throw wrap(e); }
      if (r.error && r.error.code === '23505') throw new RemoteError('nome già usato', 'nome');
      return chk(r);
    },
    async update(id, base, p) {
      await need();
      let r;
      try { r = await sb.from('projects').update({ name: p.name, files: p.files, devices: p.devices }).eq('id', id).eq('version', base).select('version'); } catch (e) { throw wrap(e); }
      if (r.error && r.error.code === '23505') throw new RemoteError('nome già usato', 'nome');
      const rows = chk(r);
      return rows.length ? rows[0] : null;
    },
    remove: id => data(() => sb.from('projects').delete().eq('id', id)),
  };
}

// ------------------------------------------------------------------
// Finto: stesso comportamento del database (versioni, nomi unici per utente, limiti), in localStorage.
// window.SV_FINTO_OFFLINE = true simula la rete assente. Solo per le prove.
export function fintoRemote() {
  const K = 'sv-finto-db';
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || { users: [], projects: [], session: null }; } catch { return { users: [], projects: [], session: null }; } };
  const save = db => localStorage.setItem(K, JSON.stringify(db));
  const net = () => { if (window.SV_FINTO_OFFLINE) throw new RemoteError('Sei offline: lavoro sulla copia nel browser.', 'rete'); };
  const me = db => { net(); if (!db.session) throw new RemoteError('Sessione scaduta: rientra nel tuo account.', 'sessione'); return db.session; };
  const pub = u => u && { id: u.id, email: u.email, username: u.username };
  const size = p => JSON.stringify(p.files).length + (p.devices ? JSON.stringify(p.devices).length : 0);
  const limits = (db, id, p, pid) => {
    if (size(p) > 2 * 1024 * 1024) throw new RemoteError('un progetto può essere al massimo di 2 MB', 'limite');
    const tot = db.projects.filter(x => x.owner === id && x.id !== pid).reduce((a, x) => a + size(x), 0);
    if (tot + size(p) > 10 * 1024 * 1024) throw new RemoteError('al massimo 10 MB di progetti per account', 'limite');
  };
  const link = readLink(location.hash);
  const recovery = [];
  return {
    kind: 'finto',
    get recovering() { return link.recovering; },
    get linkError() { return link.linkError; },
    async session() { const db = load(); return pub(db.users.find(u => u.id === db.session)); },
    async signUp(username, email, password) {
      net();
      const db = load();
      username = username.trim().toLowerCase();
      if (!validUsername(username)) throw new RemoteError('Nome utente: 3–20 caratteri tra a-z, 0-9, _ . -', 'dati');
      if (db.users.some(u => u.username === username)) throw new RemoteError('Questo nome utente è già preso.', 'dati');
      if (db.users.some(u => u.email === email)) throw new RemoteError(authMsg('already registered'), 'auth');
      if (password.length < 8) throw new RemoteError(authMsg('Password should be at least'), 'auth');
      const u = { id: crypto.randomUUID(), username, email, password };
      db.users.push(u); db.session = u.id; save(db);
      return { confirm: false };
    },
    async signIn(login, password) {
      net();
      const db = load();
      const u = db.users.find(x => (login.includes('@') ? x.email === login.trim() : x.username === login.trim().toLowerCase()) && x.password === password);
      if (!u) throw new RemoteError(login.includes('@') ? authMsg('Invalid login credentials') : 'Nome utente o password sbagliati (dopo 10 errori di fila aspetta 15 minuti, o entra con l\'email).', 'auth');
      db.session = u.id; save(db);
      return pub(u);
    },
    async signOut() { const db = load(); db.session = null; save(db); },
    async resetPassword() { net(); },
    async updatePassword(pw) { const db = load(); const u = db.users.find(x => x.id === me(db)); u.password = pw; save(db); },
    async deleteAccount() { const db = load(); const id = me(db); db.users = db.users.filter(u => u.id !== id); db.projects = db.projects.filter(p => p.owner !== id); db.session = null; save(db); },
    onRecovery(cb) { recovery.push(cb); window.SV_FINTO_RECOVERY = () => { link.recovering = true; recovery.forEach(f => f()); }; },

    async list() { const db = load(); const id = me(db); return db.projects.filter(p => p.owner === id).map(({ id, name, version, updated_at }) => ({ id, name, version, updated_at })); },
    async get(pid) { const db = load(); const id = me(db); const p = db.projects.find(x => x.id === pid && x.owner === id); return p ? { id: p.id, name: p.name, files: p.files, devices: p.devices, version: p.version } : null; },
    async insert(p) {
      const db = load(); const id = me(db);
      if (db.projects.some(x => x.owner === id && x.name === p.name)) throw new RemoteError('nome già usato', 'nome');
      if (db.projects.filter(x => x.owner === id).length >= 50) throw new RemoteError('al massimo 50 progetti per account', 'limite');
      limits(db, id, p, null);
      const r = { id: crypto.randomUUID(), owner: id, name: p.name, files: p.files, devices: p.devices ?? null, version: 1, updated_at: new Date().toISOString() };
      db.projects.push(r); save(db);
      return { id: r.id, version: 1 };
    },
    async update(pid, base, p) {
      const db = load(); const id = me(db);
      const r = db.projects.find(x => x.id === pid && x.owner === id);
      if (!r || r.version !== base) return null;
      if (db.projects.some(x => x.owner === id && x.name === p.name && x.id !== pid)) throw new RemoteError('nome già usato', 'nome');
      limits(db, id, p, pid);
      Object.assign(r, { name: p.name, files: p.files, devices: p.devices ?? null, version: r.version + 1, updated_at: new Date().toISOString() });
      save(db);
      return { version: r.version };
    },
    async remove(pid) { const db = load(); const id = me(db); db.projects = db.projects.filter(x => !(x.id === pid && x.owner === id)); save(db); },
  };
}

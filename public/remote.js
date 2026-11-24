// remote.js — account e progetti online. Due realizzazioni con la stessa interfaccia:
//   supabaseRemote  il vero (Supabase: Auth + tabella projects, vedi supabase/schema.sql)
//   fintoRemote     finto, in memoria del browser (localStorage), per provare sito e sincronizzazione
// I file dei progetti viaggiano come testo: { "Core/Src/main.c": "…", … }.
//
// Interfaccia:
//   auth: session() → {id, username, email}|null · signUp(username, email, password) → {confirm}
//         signIn(login, password) · signOut() · resetPassword(email) · updatePassword(pw)
//         deleteAccount() · onRecovery(cb) · recovering (aperto il link "password dimenticata")
//         linkError (testo se il link di una email è scaduto o già usato, o se Google/GitHub non è andato)
//   OAuth (Google/GitHub, flusso PKCE): providers (quelli di config.js PROVIDER_ATTIVI)
//         signInOAuth(provider) → va alla pagina del provider e torna qui · oauthEsito {tipo, provider}
//         dopo il ritorno · setUsername(nome) (chi è entrato con OAuth: session().username è null)
//         methods() → {password, providers:[{provider, email}]} · link(provider) · unlink(provider)
//   dati: list() → [{id, name, version, updated_at}] · get(id) → {id, name, files, devices, version}
//         insert({name, files, devices}) → {id, version}   (errore .code 'nome' se il nome c'è già)
//         update(id, base, {name, files, devices}) → {version} | null se online è cambiato (conflitto)
//         remove(id)
// Errori (.code): 'rete' (offline: il sito resta sulla copia locale e riprova dopo), 'sessione'
// (scaduta: bisogna rientrare), 'limite' (troppi progetti o MB: si salta solo quel progetto),
// 'nome', 'auth', 'dati', 'errore'.

const USER_RE = /^[a-z0-9_.-]{3,20}$/;
export const validUsername = u => USER_RE.test(u);
export const PROVIDER = { google: 'Google', github: 'GitHub' };
const attivi = cfg => ((cfg && cfg.PROVIDER_ATTIVI) || []).filter(p => p in PROVIDER);

// nome utente proposto a chi entra la prima volta con Google/GitHub (lo può cambiare prima di confermare)
export function suggestUsername(user) {
  const m = (user && user.user_metadata) || {};
  for (const x of [m.preferred_username, m.user_name, String((user && user.email) || '').split('@')[0], m.full_name, m.name]) {
    const s = String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
      .replace(/\s+/g, '.').replace(/[^a-z0-9_.-]/g, '').slice(0, 20);
    if (s.length >= 3) return s;
  }
  return '';
}

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
  if (/already registered|already been registered|already exists/i.test(m)) return 'Con questa email c\'è già un account: accedi (anche con Google o GitHub, se l\'hai creato così), o usa "Password dimenticata".';
  if (/Password should be at least|weak.?password/i.test(m)) return 'La password è troppo corta o troppo semplice (almeno 8 caratteri).';
  if (/should be different/i.test(m)) return 'La nuova password deve essere diversa da quella di prima.';
  if (/rate limit|too many|over_email_send_rate_limit/i.test(m)) return 'Troppi tentativi o troppe email in poco tempo: riprova tra un po\'.';
  if (/reauthenticat/i.test(m)) return 'Per sicurezza esci, rientra e imposta subito la password.';
  if (/Database error saving new user/i.test(m)) return 'Nome utente non valido o già preso.';
  if (/Unable to validate email|invalid.*email/i.test(m)) return 'Email non valida.';
  if (/Auth session missing|session.*expired|refresh token/i.test(m)) return 'La sessione è scaduta: rientra nel tuo account.';
  return m;
}

// il link della email (conferma o password dimenticata) apre il sito con #…type=recovery o #error=…;
// il ritorno da Google/GitHub (flusso PKCE) con ?code=… oppure ?error=… nella query
function readLink(hash, search = '') {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  let linkError = null, oauthError = null;
  if (h.get('error') || h.get('error_code')) {
    linkError = /otp_expired|expired/i.test(h.get('error_code') + ' ' + h.get('error_description'))
      ? 'Il link della email è scaduto o è già stato usato: chiedine un altro.'
      : 'Il link della email non è valido: ' + (h.get('error_description') || h.get('error')).replace(/\+/g, ' ');
  }
  if (q.get('error') || q.get('error_code')) oauthError = { error: q.get('error'), code: q.get('error_code'), message: q.get('error_description') || q.get('error') || '' };
  return { recovering: h.get('type') === 'recovery', linkError, code: q.get('code'), flowId: q.get('sb_flow_id'), oauthError };
}
// toglie dall'indirizzo i parametri del ritorno OAuth (prima di createClient, che altrimenti li legge)
function cleanOAuthParams() {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const q = new URLSearchParams(location.search);
  let tolto = false;
  for (const k of ['code', 'sb_flow_id', 'error', 'error_code', 'error_description', 'state']) if (q.has(k)) { q.delete(k); tolto = true; }
  if (tolto) history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
}
// errori di Google/GitHub (al ritorno o prima di partire) in italiano
function oauthMsg(e, provider) {
  const P = PROVIDER[provider] || 'Google/GitHub';
  const m = String((e && (e.message || e.error_description)) || e || ''), c = String((e && (e.code || e.error_code || e.error)) || '');
  if (isNet(e)) return 'Non riesco a collegarmi al server degli account: controlla la connessione a Internet.';
  if (/identity_already_exists|already linked/i.test(c + ' ' + m)) return `Questo account ${P} è già collegato a un altro utente della Scheda Virtuale.`;
  if (/manual_linking_disabled|manual linking/i.test(c + ' ' + m)) return 'Collegare o scollegare altri account non è ancora attivo (va acceso nel pannello Supabase: "Allow manual linking").';
  if (/single_identity_not_deletable/i.test(c)) return 'È l\'unico modo con cui entri: prima collega un altro account o imposta una password.';
  if (/provider is not enabled|Unsupported provider|provider_disabled/i.test(c + ' ' + m)) return `L'accesso con ${P} non è ancora attivo.`;
  if (/access_denied/i.test(c) || /denied|cancel/i.test(m)) return `Accesso con ${P} annullato.`;
  if (/Signups not allowed|signup_disabled/i.test(c + ' ' + m)) return 'Le iscrizioni nuove sono chiuse.';
  if (/email.*(external provider|not verified|unverified)|Error getting user email/i.test(m)) return `${P} non ci ha dato un'email verificata: controlla l'email del tuo account ${P} e riprova.`;
  if (/Database error saving new user/i.test(m)) return 'Non sono riuscito a creare l\'account: riprova tra un po\'.';
  if (/code verifier|flow state|flow_state|bad_code_verifier|invalid.*code/i.test(c + ' ' + m)) return `Accesso con ${P} non completato (forse il link è stato aperto in un altro browser o è scaduto): riprova.`;
  return `Accesso con ${P} non riuscito: ${m.replace(/\+/g, ' ')}`;
}
// dove riportano i link delle email: la pagina stessa (così vale sia sotto /scheda-virtuale/ sia in locale)
function backHere(cfg) {
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin + location.pathname;
  return cfg.SITE_URL;
}

// ------------------------------------------------------------------
// createClient si può passare per le prove (strumenti/prova-auth.mjs), altrimenti è quello vero
// go: dove andare per Google/GitHub (le prove la sostituiscono), di base location.assign
export async function supabaseRemote(cfg, createClient = null, go = null) {
  if (!createClient) ({ createClient } = await import('../vendor/supabase/supabase.js'));
  if (!go) go = url => location.assign(url);
  // va letto PRIMA di createClient: supabase-js legge i token dall'indirizzo e poi lo svuota
  const link = readLink(typeof location !== 'undefined' ? location.hash : '', typeof location !== 'undefined' ? location.search : '');
  if (link.code || link.oauthError) cleanOAuthParams();
  // client principale: flusso implicit, così i link delle email (conferma, password dimenticata)
  // funzionano anche aperti su un altro dispositivo
  const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  // Google/GitHub con PKCE: un secondo client solo per partire e per scambiare il codice del ritorno
  // (il code_verifier resta in localStorage sotto 'sv-oauth-…'); la sessione ottenuta passa al
  // client principale e qui si cancella subito. Non rinnova mai i token (lo fa solo il principale).
  const OAUTH_KEY = 'sv-oauth';
  let oc = null;
  const oauthClient = () => oc || (oc = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', storageKey: OAUTH_KEY },
  }));
  const dropOAuthSession = () => { try { localStorage.removeItem(OAUTH_KEY); localStorage.removeItem(OAUTH_KEY + '-user'); } catch {} };
  const SCOPO = 'sv-oauth-scopo';   // {tipo: 'entra'|'collega', provider, flowId}, per il ritorno
  const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : localStorage;
  let scopo = {};
  try { scopo = JSON.parse(ss.getItem(SCOPO)) || {}; ss.removeItem(SCOPO); } catch {}
  let oauthEsito = null;
  // l'errore si mostra solo se il giro è partito da qui (un link qualsiasi con ?error_description=…
  // non deve poter scrivere un messaggio a piacere nella finestra di accesso)
  if (link.oauthError) { if (scopo.provider) link.linkError = oauthMsg(link.oauthError, scopo.provider); }
  else if (link.code) {
    try {
      // flowId: così supabase-js cancella anche il code_verifier di questo giro
      const flowId = link.flowId || scopo.flowId;
      const r = await oauthClient().auth.exchangeCodeForSession(link.code, flowId ? { flowId } : undefined);
      if (r.error) throw r.error;
      const s = r.data.session;
      const r2 = await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
      if (r2.error) throw r2.error;
      oauthEsito = { tipo: scopo.tipo || 'entra', provider: scopo.provider || (s.user && s.user.app_metadata && s.user.app_metadata.provider) };
    } catch (e) { link.linkError = oauthMsg(e, scopo.provider); }
    finally { dropOAuthSession(); }
  }
  // il provider è attivo nel pannello? (altrimenti Supabase mostrerebbe una pagina di errore in inglese)
  async function providerAttivo(provider) {
    if (!(provider in PROVIDER)) throw new RemoteError('Provider sconosciuto: ' + provider, 'dati');
    let st;
    try {
      const r = await fetch(cfg.SUPABASE_URL + '/auth/v1/settings', { headers: { apikey: cfg.SUPABASE_KEY } });
      st = await r.json();
    } catch (e) { throw new RemoteError(oauthMsg(e, provider), 'rete'); }
    if (!st || !st.external || !st.external[provider]) throw new RemoteError(oauthMsg({ code: 'provider_disabled' }, provider), 'auth');
  }
  async function partiPer(tipo, provider, getUrl) {
    let r;
    try { r = await getUrl(); } catch (e) { throw new RemoteError(oauthMsg(e, provider), 'auth'); }
    if (r.error || !r.data || !r.data.url) throw new RemoteError(oauthMsg(r.error || 'nessun indirizzo', provider), 'auth');
    try { ss.setItem(SCOPO, JSON.stringify({ tipo, provider, flowId: r.data.flowId || null })); } catch {}
    go(r.data.url);
  }
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

  // username null = entrato con Google/GitHub e nome non ancora scelto (suggerito: proposta per la scelta)
  async function who(user) {
    if (!user) return null;
    let username = null, letto = false;
    try { username = localStorage.getItem(cacheKey(user.id)); } catch {}
    try {
      const r = await sb.from('profiles').select('username').eq('id', user.id).maybeSingle();
      if (r.data) { letto = true; username = r.data.username; if (username) try { localStorage.setItem(cacheKey(user.id), username); } catch {} }
    } catch {}
    // profilo non letto (offline): il nome dell'iscrizione con email, se c'è
    if (!username && !letto && ((user.app_metadata || {}).provider || 'email') === 'email') username = (user.user_metadata || {}).username || null;
    const u = { id: user.id, email: user.email, username: username || null };
    if (!u.username) u.suggerito = suggestUsername(user);
    return u;
  }
  return {
    kind: 'supabase',
    providers: attivi(cfg),
    get recovering() { return link.recovering; },
    get linkError() { return link.linkError; },
    get oauthEsito() { return oauthEsito; },
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

    // --- Google / GitHub
    async signInOAuth(provider) {
      await providerAttivo(provider);
      await partiPer('entra', provider, () => oauthClient().auth.signInWithOAuth({ provider, options: { redirectTo: backHere(cfg), skipBrowserRedirect: true } }));
    },
    async setUsername(nome) {
      nome = String(nome || '').trim().toLowerCase();
      if (!validUsername(nome)) throw new RemoteError('Nome utente: 3–20 caratteri tra a-z, 0-9, _ . -', 'dati');
      let r;
      try { r = await sb.rpc('imposta_username', { nome }); } catch (e) { throw new RemoteError(authMsg(e), 'auth'); }
      if (r.error) {
        const m = r.error.message || '';
        if (/già preso/.test(m)) throw new RemoteError('Questo nome utente è già preso.', 'dati');
        if (/già un nome/.test(m)) throw new RemoteError('Hai già un nome utente: non si può cambiare.', 'dati');
        throw new RemoteError(authMsg(r.error), 'auth');
      }
      const { data } = await sb.auth.getSession();
      try { localStorage.setItem(cacheKey(data.session.user.id), nome); } catch {}
      return nome;
    },
    // modi di entrare: password (sì/no) e account Google/GitHub collegati
    async methods() {
      await need();
      const [ri, rp] = await Promise.all([sb.auth.getUserIdentities(), sb.rpc('ha_password').then(x => x, e => ({ error: e }))]);
      if (ri.error) throw wrap(ri.error);
      const ids = (ri.data && ri.data.identities) || [];
      return {
        password: rp.error ? ids.some(i => i.provider === 'email') : !!rp.data,
        providers: ids.filter(i => i.provider in PROVIDER).map(i => ({ provider: i.provider, email: (i.identity_data || {}).email || '' })),
        identita: ids.length,
      };
    },
    async link(provider) {
      await need();
      await providerAttivo(provider);
      const { data } = await sb.auth.getSession();          // rinnova il token se è scaduto
      const s = data.session, o = oauthClient();
      try {
        const r = await o.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
        if (r.error) throw new RemoteError(authMsg(r.error), 'auth');
        await partiPer('collega', provider, () => o.auth.linkIdentity({ provider, options: { redirectTo: backHere(cfg), skipBrowserRedirect: true } }));
      } finally { dropOAuthSession(); }
    },
    async unlink(provider) {
      await need();
      const r = await sb.auth.getUserIdentities();
      if (r.error) throw wrap(r.error);
      const ids = r.data.identities || [], id = ids.find(i => i.provider === provider);
      if (!id) return;
      if (ids.length < 2) throw new RemoteError(oauthMsg({ code: 'single_identity_not_deletable' }, provider), 'auth');
      let u;
      try { u = await sb.auth.unlinkIdentity(id); } catch (e) { throw new RemoteError(oauthMsg(e, provider), 'auth'); }
      if (u.error) throw new RemoteError(oauthMsg(u.error, provider), 'auth');
      try { await sb.auth.refreshSession(); } catch {}    // il token nuovo non elenca più il provider
    },

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
// Google/GitHub finti: signInOAuth/link tornano subito alla pagina con ?code=finto… (o ?error=… se
// window.SV_FINTO_OAUTH = {annulla: true}); l'email dell'account del provider è SV_FINTO_OAUTH.email
// (di base prova.<provider>@example.com). Come Supabase, un'email già usata collega allo stesso utente.
export function fintoRemote(cfg = {}, go = null) {
  if (!go) go = url => location.assign(url);
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
  const link = readLink(location.hash, location.search);
  const recovery = [];
  // ritorno dal provider finto
  let scopo = {}, oauthEsito = null;
  try { scopo = JSON.parse(sessionStorage.getItem('sv-oauth-scopo')) || {}; sessionStorage.removeItem('sv-oauth-scopo'); } catch {}
  if (link.code || link.oauthError) cleanOAuthParams();
  if (link.oauthError) { if (scopo.provider) link.linkError = oauthMsg(link.oauthError, scopo.provider); }
  else if (link.code) {
    const [, provider, email] = decodeURIComponent(link.code).split('|');
    const db = load();
    const altro = db.users.find(u => (u.identities || []).some(i => i.provider === provider && i.email === email));
    if (scopo.tipo === 'collega') {
      const me = db.users.find(u => u.id === db.session);
      if (!me) link.linkError = oauthMsg('Auth session missing', provider);
      else if (altro && altro.id !== me.id) link.linkError = oauthMsg({ code: 'identity_already_exists' }, provider);
      else { if (!altro) me.identities.push({ provider, email }); oauthEsito = { tipo: 'collega', provider }; }
    } else {
      let u = altro || db.users.find(u => u.email === email);
      if (u && !altro) u.identities.push({ provider, email });          // collegamento automatico (stessa email)
      if (!u) db.users.push(u = { id: crypto.randomUUID(), username: null, email, password: null, identities: [{ provider, email }] });
      db.session = u.id;
      oauthEsito = { tipo: 'entra', provider };
    }
    save(db);
  }
  const parti = (tipo, provider) => {
    net();
    if (!attivi(cfg).includes(provider)) throw new RemoteError(oauthMsg({ code: 'provider_disabled' }, provider), 'auth');
    const o = window.SV_FINTO_OAUTH || {};
    try { sessionStorage.setItem('sv-oauth-scopo', JSON.stringify({ tipo, provider })); } catch {}
    const q = o.annulla ? 'error=access_denied&error_code=access_denied&error_description=The+user+denied+access'
      : 'code=' + encodeURIComponent(['finto', provider, o.email || `prova.${provider}@example.com`].join('|'));
    go(location.pathname + '?' + q);
  };
  const pubU = u => { const p = pub(u); if (p && !p.username) p.suggerito = suggestUsername({ email: u.email, user_metadata: {} }); return p; };
  return {
    kind: 'finto',
    providers: attivi(cfg),
    get recovering() { return link.recovering; },
    get linkError() { return link.linkError; },
    get oauthEsito() { return oauthEsito; },
    async session() { const db = load(); return pubU(db.users.find(u => u.id === db.session)); },
    async signUp(username, email, password) {
      net();
      const db = load();
      username = username.trim().toLowerCase();
      if (!validUsername(username)) throw new RemoteError('Nome utente: 3–20 caratteri tra a-z, 0-9, _ . -', 'dati');
      if (db.users.some(u => u.username === username)) throw new RemoteError('Questo nome utente è già preso.', 'dati');
      if (db.users.some(u => u.email === email)) throw new RemoteError(authMsg('already registered'), 'auth');
      if (password.length < 8) throw new RemoteError(authMsg('Password should be at least'), 'auth');
      const u = { id: crypto.randomUUID(), username, email, password, identities: [{ provider: 'email', email }] };
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
    async updatePassword(pw) { const db = load(); const u = db.users.find(x => x.id === me(db)); u.password = pw; save(db); },  // (come Supabase: niente identità 'email' in più)
    async deleteAccount() { const db = load(); const id = me(db); db.users = db.users.filter(u => u.id !== id); db.projects = db.projects.filter(p => p.owner !== id); db.session = null; save(db); },
    onRecovery(cb) { recovery.push(cb); window.SV_FINTO_RECOVERY = () => { link.recovering = true; recovery.forEach(f => f()); }; },

    async signInOAuth(provider) { parti('entra', provider); },
    async setUsername(nome) {
      net();
      nome = String(nome || '').trim().toLowerCase();
      if (!validUsername(nome)) throw new RemoteError('Nome utente: 3–20 caratteri tra a-z, 0-9, _ . -', 'dati');
      const db = load(), u = db.users.find(x => x.id === me(db));
      if (u.username) throw new RemoteError('Hai già un nome utente: non si può cambiare.', 'dati');
      if (db.users.some(x => x.username === nome)) throw new RemoteError('Questo nome utente è già preso.', 'dati');
      u.username = nome; save(db);
      return nome;
    },
    async methods() {
      const db = load(), u = db.users.find(x => x.id === me(db)), ids = u.identities || [];
      return { password: !!u.password, providers: ids.filter(i => i.provider in PROVIDER).map(i => ({ provider: i.provider, email: i.email })), identita: ids.length };
    },
    async link(provider) { me(load()); parti('collega', provider); },
    async unlink(provider) {
      const db = load(), u = db.users.find(x => x.id === me(db)), ids = u.identities || [];
      if (!ids.some(i => i.provider === provider)) return;
      if (ids.length < 2) throw new RemoteError(oauthMsg({ code: 'single_identity_not_deletable' }, provider), 'auth');
      if (window.SV_FINTO_NO_MANUAL_LINKING) throw new RemoteError(oauthMsg({ code: 'manual_linking_disabled' }, provider), 'auth');
      u.identities = ids.filter(i => i.provider !== provider); save(db);
    },

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

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
//   segnalazioni (supabase/migrazione-3-segnalazioni.sql): invia(s) → {id} · mie() · admin() → bool
//         tutte({stato}) · dettaglio(id) · aggiorna(id, {stato, risposta}) · nomi(ids) → [{id, username}]
//         errore .code 'assente' se la migrazione non è ancora stata applicata (tabella o funzione mancante)
//   classi (supabase/migrazione-5-classi.sql, punto N): docente() · mie() · crea(nome) · entra(codice) · membri(c) ·
//         aggiungiProf(c, nome, si) · togli(c, utente?) · archivia(c, si) · nominaDocente(nome, si) · esercizi(c) · esercizio(id) ·
//         salvaEsercizio({classe, titolo, consegna, progetto, sola, scadenza, id}) · eliminaEsercizio(id) · consegna(es, progetto) ·
//         miaConsegna(es) · consegne(es) · progettoConsegna(id) · valuta(id, commento, voto); .code 'assente' = migrazione da applicare
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

// testi della segnalazione: limiti uguali a quelli del database (migrazione-3-segnalazioni.sql)
export const SEGN = { titolo: [3, 120], descrizione: [10, 5000], passi: [0, 3000], atteso: [0, 2000], browser: [0, 300], versione: [0, 40], registro: [0, 20000], progetto: 1048576 };
export const SEGN_STATI = ['aperta', 'in corso', 'risolta', 'chiusa'];
export const CLASSI_ASSENTE = 'Le classi non sono ancora attive su questo sito: manca un aggiornamento del database (lo fa l\'amministratore). Il resto del sito funziona.';
const SEGN_ASSENTE = 'Le segnalazioni non sono ancora attive su questo sito (manca un aggiornamento del database). Il testo resta qui: riprova più tardi.';
// controlla e ripulisce una segnalazione prima di mandarla (il database ricontrolla tutto)
export function segnalazionePulita(s) {
  const out = {};
  for (const k of ['titolo', 'descrizione', 'passi', 'atteso', 'browser', 'versione', 'registro']) {
    const v = String((s && s[k]) ?? '').replace(/\r\n?/g, '\n').trim();
    const [min, max] = SEGN[k];
    if (v.length < min) throw new RemoteError(k === 'titolo' ? 'Il titolo è troppo corto (almeno 3 caratteri).' : 'La descrizione è troppo corta (almeno 10 caratteri).', 'dati');
    out[k] = v.slice(0, max);
  }
  out.progetto = s && s.progetto && typeof s.progetto === 'object' ? s.progetto : null;
  if (out.progetto && JSON.stringify(out.progetto).length > SEGN.progetto) throw new RemoteError('Il progetto è troppo grande per allegarlo (più di 1 MB): togli la spunta.', 'dati');
  return out;
}
const SEGN_ELENCO = 'id,creata,aggiornata,titolo,stato,risposta,risposta_il';

// link corti (supabase/migrazione-4-condivisioni.sql): …/public/#c=<id> → il contenuto di un link lungo.
// Si leggono anche senza accesso (funzione leggi_condivisione); null se non c'è, è revocato o la migrazione manca.
export async function leggiCorto(cfg, id) {
  if (!/^[A-Za-z0-9_-]{12}$/.test(id || '')) return null;
  if (cfg.BACKEND === 'finto') {
    let db = {}; try { db = JSON.parse(localStorage.getItem('sv-finto-db')) || {}; } catch {}
    const c = (db.condivisioni || []).find(x => x.id === id && !x.revocata);
    return c ? { tipo: c.tipo, dati: c.dati } : null;
  }
  if (!cfg.HA_ACCOUNT) return null;
  try {
    const r = await fetch(cfg.SUPABASE_URL + '/rest/v1/rpc/leggi_condivisione', { method: 'POST', headers: { apikey: cfg.SUPABASE_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_id: id }) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j[0] && /^(progetto|esercizio)$/.test(j[0].tipo) && /^[A-Za-z0-9_-]+$/.test(j[0].dati) ? { tipo: j[0].tipo, dati: j[0].dati } : null;
  } catch { return null; }
}
const corta = c => ({ tipo: c.tipo === 'esercizio' ? 'esercizio' : 'progetto', dati: String(c.dati || ''), nome: String(c.nome || '').slice(0, 80) });

class RemoteError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const isNet = e => (typeof navigator !== 'undefined' && !navigator.onLine) || /fetch|network|Failed to fetch|NetworkError|Load failed/i.test(String(e && (e.message || e)));
const wrap = e => {
  if (e instanceof RemoteError) return e;
  const m = (e && e.message) || String(e);
  if (isNet(e)) return new RemoteError('Sei offline: lavoro sulla copia nel browser.', 'rete');
  if (/^limite:/.test(m)) return new RemoteError(m.replace(/^limite:\s*/, ''), 'limite');
  if (['PGRST205', 'PGRST202', '42P01', '42883'].includes(e && e.code) || /schema cache/i.test(m)) return new RemoteError(SEGN_ASSENTE, 'assente');
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

    segnalazioni: {
      invia: async s => { const x = segnalazionePulita(s); return data(() => sb.from('segnalazioni').insert(x).select('id').single()); },
      async mie() {
        await need();
        const { data: d } = await sb.auth.getSession();
        return data(() => sb.from('segnalazioni').select(SEGN_ELENCO).eq('autore', d.session.user.id).order('creata', { ascending: false }).limit(50));
      },
      async admin() {
        try { return (await data(() => sb.rpc('is_admin'))) === true; } catch (e) { if (e.code === 'assente') return false; throw e; }
      },
      tutte: ({ stato } = {}) => data(() => { let q = sb.from('segnalazioni').select(SEGN_ELENCO + ',autore,versione').order('creata', { ascending: false }).limit(500); if (stato) q = q.eq('stato', stato); return q; }),
      dettaglio: id => data(() => sb.from('segnalazioni').select('*').eq('id', id).maybeSingle()),
      aggiorna: async (id, { stato, risposta }) => {
        if (!SEGN_STATI.includes(stato)) throw new RemoteError('Stato non valido.', 'dati');
        return data(() => sb.from('segnalazioni').update({ stato, risposta: String(risposta || '').slice(0, 5000) }).eq('id', id).select(SEGN_ELENCO).single());
      },
      nomi: ids => data(() => sb.rpc('nomi_utenti', { ids })),
    },
    // preset del banco (supabase/migrazione-6): solo i propri; insert per i nuovi, update per quelli già online
    preset: {
      tutti: () => data(() => sb.from('preset_banco').select('id,nome,codice,dati,aggiornato').order('aggiornato', { ascending: false }).limit(100)),
      crea: p => data(() => sb.from('preset_banco').insert({ id: p.id, nome: p.nome, codice: !!p.codice, dati: p.dati }).select('id,aggiornato').single()),
      cambia: p => data(() => sb.from('preset_banco').update({ nome: p.nome, codice: !!p.codice, dati: p.dati }).eq('id', p.id).select('id,aggiornato').single()),
      elimina: id => data(() => sb.from('preset_banco').delete().eq('id', id).select('id')),
    },
    condivisioni: {
      crea: async c => { const x = corta(c); return data(() => sb.from('condivisioni').insert(x).select('id').single()); },
      mie: () => data(() => sb.from('condivisioni').select('id,tipo,nome,creata,revocata,letture').order('creata', { ascending: false }).limit(50)),
      revoca: id => data(() => sb.from('condivisioni').update({ revocata: true }).eq('id', id).select('id')),
    },
    classi: (() => {
      const d = fn => data(fn).catch(e => { throw e.code === 'assente' ? new RemoteError(CLASSI_ASSENTE, 'assente') : e; });
      const rpc = (f, a) => d(() => sb.rpc(f, a));
      const uno = r => Array.isArray(r) ? r[0] || null : r;
      return {
        docente: () => rpc('is_docente'),
        mie: () => rpc('mie_classi'),
        crea: async nome => uno(await rpc('crea_classe', { nome })),
        entra: async codice => uno(await rpc('entra_in_classe', { cod: codice })),
        membri: c => rpc('membri_classe', { c }),
        aggiungiProf: (c, nome, si = true) => rpc('aggiungi_docente_classe', { c, nome, si }),
        togli: (c, u = null) => rpc('togli_dalla_classe', { c, u }),
        archivia: (c, si = true) => rpc('archivia_classe', { c, si }),
        nominaDocente: (nome, si = true) => rpc('nomina_docente', { nome, si }),
        esercizi: c => d(() => sb.from('esercizi').select('id,classe_id,titolo,consegna,sola,scadenza,creato').eq('classe_id', c).order('creato', { ascending: false })),
        esercizio: id => d(() => sb.from('esercizi').select('*').eq('id', id).maybeSingle()),
        salvaEsercizio: x => rpc('salva_esercizio', { c: x.classe, titolo: x.titolo, consegna: x.consegna || '', progetto: x.progetto, sola: x.sola || [], scadenza: x.scadenza || null, e: x.id || null }),
        eliminaEsercizio: e => rpc('elimina_esercizio', { e }),
        consegna: async (e, progetto) => uno(await rpc('consegna_esercizio', { e, progetto })),
        async miaConsegna(e) {
          await need();
          const { data: s0 } = await sb.auth.getSession();
          return uno(await d(() => sb.from('consegne').select('id,versione,consegnata,voto,commento,corretta').eq('esercizio_id', e).eq('studente', s0.session.user.id)));
        },
        consegne: e => rpc('consegne_esercizio', { e }),
        progettoConsegna: async id => (uno(await d(() => sb.from('consegne').select('progetto').eq('id', id))) || {}).progetto || null,
        valuta: (c, commento, voto) => rpc('valuta_consegna', { c, commento, voto }),
      };
    })(),
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

    // segnalazioni finte: stesse regole della migrazione 3; amministratori = db.admins (ID);
    // window.SV_FINTO_NO_SEGNALAZIONI = true simula la migrazione non ancora applicata
    segnalazioni: (() => {
      const pronta = db => { if (window.SV_FINTO_NO_SEGNALAZIONI) throw new RemoteError(SEGN_ASSENTE, 'assente'); db.segnalazioni = db.segnalazioni || []; db.admins = db.admins || []; return me(db); };
      const elenco = r => ({ id: r.id, creata: r.creata, aggiornata: r.aggiornata, titolo: r.titolo, stato: r.stato, risposta: r.risposta, risposta_il: r.risposta_il });
      const admin = (db, id) => (db.admins || []).includes(id);
      return {
        async invia(s) {
          const x = segnalazionePulita(s), db = load(), id = pronta(db), now = Date.now();
          const mie = db.segnalazioni.filter(r => r.autore === id);
          if (mie.filter(r => now - Date.parse(r.creata) < 86400000).length >= 20) throw new RemoteError('al massimo 20 segnalazioni al giorno', 'limite');
          if (mie.length >= 200) throw new RemoteError('al massimo 200 segnalazioni per account', 'limite');
          if (mie.some(r => now - Date.parse(r.creata) < 30000)) throw new RemoteError('aspetta 30 secondi tra una segnalazione e l\'altra', 'limite');
          const r = { ...x, id: (db.segnalazioni.reduce((m, r) => Math.max(m, r.id), 0) + 1), autore: id, creata: new Date(now).toISOString(), aggiornata: new Date(now).toISOString(), stato: 'aperta', risposta: '', risposta_il: null };
          db.segnalazioni.push(r); save(db);
          return { id: r.id };
        },
        async mie() { const db = load(), id = pronta(db); return db.segnalazioni.filter(r => r.autore === id).map(elenco).reverse(); },
        async admin() { try { const db = load(), id = pronta(db); return admin(db, id); } catch (e) { if (e.code === 'assente') return false; throw e; } },
        async tutte({ stato } = {}) { const db = load(), id = pronta(db); return db.segnalazioni.filter(r => (admin(db, id) || r.autore === id) && (!stato || r.stato === stato)).map(r => ({ ...elenco(r), autore: r.autore, versione: r.versione })).reverse(); },
        async dettaglio(sid) { const db = load(), id = pronta(db); const r = db.segnalazioni.find(r => r.id === sid && (admin(db, id) || r.autore === id)); return r ? { ...r } : null; },
        async aggiorna(sid, { stato, risposta }) {
          if (!SEGN_STATI.includes(stato)) throw new RemoteError('Stato non valido.', 'dati');
          const db = load(), id = pronta(db);
          if (!admin(db, id)) throw new RemoteError('Sessione scaduta: rientra nel tuo account.', 'sessione');
          const r = db.segnalazioni.find(r => r.id === sid);
          risposta = String(risposta || '').slice(0, 5000);
          if (risposta !== r.risposta) r.risposta_il = risposta ? new Date().toISOString() : null;
          Object.assign(r, { stato, risposta, aggiornata: new Date().toISOString() }); save(db);
          return elenco(r);
        },
        async nomi(ids) { const db = load(), id = pronta(db); return admin(db, id) ? db.users.filter(u => ids.includes(u.id)).map(u => ({ id: u.id, username: u.username })) : []; },
      };
    })(),
    // preset finti: stesse regole della migrazione 6 (window.SV_FINTO_NO_PRESET = migrazione assente)
    preset: (() => {
      const mie = (db, id) => (db.preset || []).filter(p => p.owner === id);
      const out = p => ({ id: p.id, nome: p.nome, codice: p.codice, dati: p.dati, aggiornato: new Date(p.aggiornato).toISOString() });
      const prima = () => { if (window.SV_FINTO_NO_PRESET) throw new RemoteError(SEGN_ASSENTE, 'assente'); const db = load(); return [db, me(db)]; };
      const nome = n => { const t = String(n || '').trim(); if (!t || t.length > 60) throw new RemoteError('Nome del preset non valido.', 'dati'); return t; };
      return {
        async tutti() { const [db, id] = prima(); return mie(db, id).sort((a, b) => b.aggiornato - a.aggiornato).map(out); },
        async crea(p) {
          const [db, id] = prima();
          if (mie(db, id).length >= 50) throw new RemoteError('al massimo 50 preset (elimina quelli che non usi)', 'limite');
          if ((db.preset || []).some(x => x.id === p.id)) throw new RemoteError('duplicate key', 'errore');
          const r = { id: p.id, owner: id, nome: nome(p.nome), codice: !!p.codice, dati: p.dati, aggiornato: Date.now() };
          (db.preset = db.preset || []).push(r); save(db); return { id: r.id, aggiornato: out(r).aggiornato };
        },
        async cambia(p) {
          const [db, id] = prima(), r = mie(db, id).find(x => x.id === p.id);
          if (!r) throw new RemoteError('preset non trovato', 'errore');
          Object.assign(r, { nome: nome(p.nome), codice: !!p.codice, dati: p.dati, aggiornato: Date.now() }); save(db); return { id: r.id, aggiornato: out(r).aggiornato };
        },
        async elimina(pid) { const [db, id] = prima(); const n = (db.preset || []).length; db.preset = (db.preset || []).filter(x => !(x.id === pid && x.owner === id)); save(db); return n !== db.preset.length ? [{ id: pid }] : []; },
      };
    })(),
    // link corti finti: stesse regole della migrazione 4
    condivisioni: {
      async crea(c) {
        const x = corta(c), db = load(), id = me(db);
        if (window.SV_FINTO_NO_CONDIVISIONI) throw new RemoteError(SEGN_ASSENTE, 'assente');
        if (!/^[A-Za-z0-9_-]{20,400000}$/.test(x.dati)) throw new RemoteError('Contenuto del link non valido.', 'dati');
        db.condivisioni = db.condivisioni || [];
        const mie = db.condivisioni.filter(r => r.owner === id);
        if (mie.filter(r => Date.now() - r.creata < 86400000).length >= 30) throw new RemoteError('al massimo 30 link corti al giorno', 'limite');
        const nuovo = { ...x, id: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9)))).replace(/\+/g, '-').replace(/\//g, '_'), owner: id, creata: Date.now(), revocata: false, letture: 0 };
        db.condivisioni.push(nuovo); save(db);
        return { id: nuovo.id };
      },
      async mie() { const db = load(), id = me(db); return (db.condivisioni || []).filter(r => r.owner === id).map(({ id, tipo, nome, creata, revocata, letture }) => ({ id, tipo, nome, creata: new Date(creata).toISOString(), revocata, letture })).reverse(); },
      async revoca(cid) { const db = load(), id = me(db); const r = (db.condivisioni || []).find(x => x.id === cid && x.owner === id); if (r) { r.revocata = true; save(db); } return r ? [{ id: cid }] : []; },
    },
    // classi finte: stesse regole della migrazione 5 (docenti = db.docenti, ID); window.SV_FINTO_NO_CLASSI = migrazione assente
    classi: (() => {
      const L = (m) => new RemoteError(m, 'limite');
      const pronta = db => { if (window.SV_FINTO_NO_CLASSI) throw new RemoteError(CLASSI_ASSENTE, 'assente'); for (const k of ['classi', 'membri', 'esercizi', 'consegne', 'docenti', 'admins']) db[k] = db[k] || []; return me(db); };
      const uid = () => crypto.randomUUID();
      const ruolo = (db, c, u) => (db.membri.find(m => m.c === c && m.u === u) || {}).ruolo || null;
      const nome = (db, u) => (db.users.find(x => x.id === u) || {}).username || null;
      const perNome = (db, n) => { const u = db.users.find(x => x.username === String(n || '').trim().toLowerCase()); if (!u) throw L(`nessun utente si chiama ${n}`); return u.id; };
      const docente = (db, u) => db.admins.includes(u) || db.docenti.includes(u);
      const grande = p => { if (!p || typeof p !== 'object' || JSON.stringify(p).length > 2097152) throw L('un progetto può essere al massimo di 2 MB'); };
      const tardi = (x, t) => !!(x.scadenza && Date.parse(t) > Date.parse(x.scadenza));
      const fai = fn => async (...a) => { const db = load(), u = pronta(db); const r = await fn(db, u, ...a); save(db); return r; };
      return {
        docente: fai((db, u) => docente(db, u)),
        mie: fai((db, u) => db.membri.filter(m => m.u === u).map(m => { const k = db.classi.find(x => x.id === m.c); return { id: k.id, nome: k.nome, codice: m.ruolo === 'prof' ? k.codice : null, ruolo: m.ruolo, creatore: k.creatore === u, archiviata: k.archiviata, membri: db.membri.filter(x => x.c === k.id && x.ruolo === 'studente').length, esercizi: db.esercizi.filter(e => e.classe_id === k.id).length }; })),
        crea: fai((db, u, n) => {
          if (!docente(db, u)) throw L('solo i docenti creano le classi (chiedi all\'amministratore del sito)');
          const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', codice = [...crypto.getRandomValues(new Uint8Array(6))].map(b => a[b % 32]).join('');
          const k = { id: uid(), nome: String(n).trim().slice(0, 60), codice, creatore: u, archiviata: false };
          db.classi.push(k); db.membri.push({ c: k.id, u, ruolo: 'prof' });
          return { id: k.id, codice };
        }),
        entra: fai((db, u, cod) => {
          const k = db.classi.find(x => x.codice === String(cod || '').trim().toUpperCase() && !x.archiviata);
          if (!k) return null;
          if (!ruolo(db, k.id, u)) db.membri.push({ c: k.id, u, ruolo: 'studente' });
          return { id: k.id, nome: k.nome };
        }),
        membri: fai((db, u, c) => ruolo(db, c, u) === 'prof' ? db.membri.filter(m => m.c === c).map(m => ({ user_id: m.u, username: nome(db, m.u), ruolo: m.ruolo })) : []),
        aggiungiProf: fai((db, u, c, n, si = true) => {
          if ((db.classi.find(k => k.id === c) || {}).creatore !== u) throw L('solo chi ha creato la classe sceglie gli altri prof');
          const v = perNome(db, n), m = db.membri.find(x => x.c === c && x.u === v);
          if (si) { if (m) m.ruolo = 'prof'; else db.membri.push({ c, u: v, ruolo: 'prof' }); } else if (m) m.ruolo = 'studente';
          return String(n).toLowerCase();
        }),
        togli: fai((db, u, c, v = null) => { v = v || u; if (v !== u && ruolo(db, c, u) !== 'prof') throw L('solo un prof della classe toglie gli altri'); db.membri = db.membri.filter(m => !(m.c === c && m.u === v)); }),
        archivia: fai((db, u, c, si = true) => { const k = db.classi.find(x => x.id === c && x.creatore === u); if (!k) throw L('solo chi ha creato la classe la archivia'); k.archiviata = si; }),
        nominaDocente: fai((db, u, n, si = true) => { if (!db.admins.includes(u)) throw L('solo l\'amministratore nomina i docenti'); const v = perNome(db, n); db.docenti = db.docenti.filter(x => x !== v); if (si) db.docenti.push(v); return String(n).toLowerCase(); }),
        esercizi: fai((db, u, c) => ruolo(db, c, u) ? db.esercizi.filter(e => e.classe_id === c).map(({ progetto, ...e }) => e).reverse() : []),
        esercizio: fai((db, u, id) => { const e = db.esercizi.find(x => x.id === id); return e && ruolo(db, e.classe_id, u) ? { ...e } : null; }),
        salvaEsercizio: fai((db, u, x) => {
          if (ruolo(db, x.classe, u) !== 'prof') throw L('solo i prof della classe danno gli esercizi');
          grande(x.progetto);
          const e = { id: x.id || uid(), classe_id: x.classe, titolo: String(x.titolo || '').trim().slice(0, 120), consegna: String(x.consegna || '').slice(0, 20000), progetto: x.progetto, sola: (x.sola || []).slice(0, 50), scadenza: x.scadenza || null, creato: new Date().toISOString() };
          if (!e.titolo) throw L('il titolo va da 1 a 120 caratteri');
          db.esercizi = db.esercizi.filter(y => y.id !== e.id); db.esercizi.push(e);
          return e.id;
        }),
        eliminaEsercizio: fai((db, u, id) => { const e = db.esercizi.find(x => x.id === id); if (!e || ruolo(db, e.classe_id, u) !== 'prof') throw L('solo i prof della classe tolgono gli esercizi'); db.esercizi = db.esercizi.filter(x => x.id !== id); db.consegne = db.consegne.filter(c => c.esercizio_id !== id); }),
        consegna: fai((db, u, id, progetto) => {
          const e = db.esercizi.find(x => x.id === id);
          if (!e || !ruolo(db, e.classe_id, u)) throw L('esercizio non trovato (sei nella classe?)');
          if (db.classi.find(k => k.id === e.classe_id).archiviata) throw L('la classe è archiviata, non si consegna più');
          grande(progetto);
          let c = db.consegne.find(x => x.esercizio_id === id && x.studente === u);
          if (c) Object.assign(c, { progetto, versione: c.versione + 1, consegnata: new Date().toISOString() });
          else db.consegne.push(c = { id: uid(), esercizio_id: id, studente: u, progetto, versione: 1, consegnata: new Date().toISOString(), voto: '', commento: '', corretta: null });
          return { versione: c.versione, consegnata: c.consegnata, in_ritardo: tardi(e, c.consegnata) };
        }),
        miaConsegna: fai((db, u, id) => { const c = db.consegne.find(x => x.esercizio_id === id && x.studente === u); return c ? (({ progetto, ...r }) => r)(c) : null; }),
        consegne: fai((db, u, id) => {
          const e = db.esercizi.find(x => x.id === id);
          if (!e || ruolo(db, e.classe_id, u) !== 'prof') return [];
          return db.membri.filter(m => m.c === e.classe_id && m.ruolo === 'studente').map(m => { const c = db.consegne.find(x => x.esercizio_id === id && x.studente === m.u); return { studente: m.u, username: nome(db, m.u), consegna_id: c ? c.id : null, versione: c ? c.versione : null, consegnata: c ? c.consegnata : null, in_ritardo: c ? tardi(e, c.consegnata) : false, voto: c ? c.voto : null, commento: c ? c.commento : null, corretta: c ? c.corretta : null }; });
        }),
        progettoConsegna: fai((db, u, id) => { const c = db.consegne.find(x => x.id === id); if (!c) return null; const e = db.esercizi.find(x => x.id === c.esercizio_id); return c.studente === u || ruolo(db, e.classe_id, u) === 'prof' ? c.progetto : null; }),
        valuta: fai((db, u, id, commento, voto) => { const c = db.consegne.find(x => x.id === id), e = c && db.esercizi.find(x => x.id === c.esercizio_id); if (!e || ruolo(db, e.classe_id, u) !== 'prof') throw L('solo i prof della classe correggono'); Object.assign(c, { commento: String(commento || '').slice(0, 5000), voto: String(voto || '').trim().slice(0, 20), corretta: new Date().toISOString() }); }),
      };
    })(),
  };
}

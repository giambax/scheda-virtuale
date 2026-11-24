// config.js — l'unico file da cambiare per collegare il sito a Supabase (vedi GUIDA-SUPABASE.md).
// Senza la chiave (o con il segnaposto qui sotto) il sito va in modalità "senza account":
// i progetti restano solo in questo browser, sotto un nome, come nel prototipo.
// La chiave "publishable" (sb_publishable_…, o la vecchia "anon public") è pubblica per natura: la
// vede chiunque apra il sito; la sicurezza la fanno le regole RLS di supabase/schema.sql.
// La chiave "secret" / service_role NON va MAI messa qui.
export const SUPABASE_URL = 'https://dnfksqfolbphdzofazdg.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_N0YRBBpQxzPN98CGEH3rCw_l_Zc5u26';
// indirizzo del sito pubblicato: le email (conferma, password dimenticata) riportano alla pagina
// da cui sono partite; questo serve solo se la pagina non ha un indirizzo http(s)
export const SITE_URL = 'https://giambax.github.io/scheda-virtuale/';
// accesso con Google / GitHub (GUIDA-LOGIN-SOCIAL.md): metti qui solo quelli già attivati nel
// pannello Supabase, es. ['google', 'github']. Vuota = nessun pulsante (solo nome utente/email e password).
export const PROVIDER_ATTIVI = ['github'];
// solo per le prove: 'finto' = account e progetti online simulati nel browser (nessuna rete)
export const BACKEND = '';

// c'è una chiave vera? (il segnaposto non conta)
export const HA_ACCOUNT = BACKEND === 'finto' || (!!SUPABASE_URL && !!SUPABASE_KEY && !SUPABASE_KEY.startsWith('INCOLLA'));

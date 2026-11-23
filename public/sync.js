// sync.js — sincronizzazione tra la copia dei progetti nel browser e quella online.
// Logica pura (niente IndexedDB né rete qui dentro): L = copia locale, R = remote.js.
// Così si prova anche in Node con un finto backend (strumenti/prova-sync.mjs).
//
// Ogni progetto locale ha sync = { id, version, dirty }:
//   id/version  la versione online da cui parte la copia locale (assenti = mai inviato)
//   dirty       modificato qui dopo l'ultima sincronizzazione
// Regola d'oro: non si perde niente. Se lo stesso progetto è cambiato sia qui sia online
// (es. da un altro computer), la versione online prende il nome originale e quella di qui
// diventa "nome (conflitto gg-mm hh.mm)", che viene poi inviata come progetto nuovo.
//
// Un progetto che online non entra (troppi progetti o MB: errore 'limite') resta solo qui e
// finisce in rapporto.nonInviati; gli altri si sincronizzano lo stesso.
//
// L: all() → [{nome, files, devices, sync}] (files come testo) · del(nome)
//    put(rec, vecchioNome?, daOnline?)  daOnline = contenuto appena scaricato (non quello di qui)
//    tombstones() → [{id, version}] (progetti eliminati qui mentre ero offline) · clearTombstone(id)

const pad = n => String(n).padStart(2, '0');
export const conflictName = (nome, d = new Date()) => `${nome} (conflitto ${pad(d.getDate())}-${pad(d.getMonth() + 1)} ${pad(d.getHours())}.${pad(d.getMinutes())})`.slice(0, 60);

export async function sincronizza(L, R, now = () => new Date()) {
  const rep = { inviati: [], scaricati: [], conflitti: [], eliminatiQui: [], eliminatiOnline: [], nonInviati: [] };
  const remote = await R.list();
  const byId = new Map(remote.map(r => [r.id, r]));
  const remoteNames = new Set(remote.map(r => r.name));
  const local = await L.all();
  const used = new Set(local.map(r => r.nome));
  const free = base => { if (!used.has(base) && !remoteNames.has(base)) return base; for (let i = 2; ; i++) { const n = `${base} (${i})`.slice(0, 60); if (!used.has(n) && !remoteNames.has(n)) return n; } };

  // nome locale cambiato: tiene aggiornato l'elenco dei nomi usati
  const putLocal = async (rec, oldName, daOnline = false) => {
    if (oldName && oldName !== rec.nome) used.delete(oldName);
    used.add(rec.nome);
    await L.put(rec, oldName, daOnline);
  };
  // troppi progetti o MB online: questo resta solo qui, gli altri vanno avanti
  const limite = (e, nome) => { if (e.code !== 'limite') throw e; rep.nonInviati.push({ nome, motivo: e.message }); };
  const pull = async (id, oldName) => {
    const full = await R.get(id);
    if (!full) return null;
    let nome = full.name;
    if (nome !== oldName && used.has(nome)) {
      // il nome è occupato da un altro progetto locale: quello locale cambia nome (e verrà inviato)
      const other = local.find(x => x.nome === nome && (!x.sync || x.sync.id !== id));
      if (other) {
        const nuovo = free(nome);
        const moved = { ...other, nome: nuovo, sync: { ...(other.sync || {}), dirty: true } };
        await putLocal(moved, other.nome);
        Object.assign(other, moved);
      }
    }
    await putLocal({ nome, files: full.files, devices: full.devices ?? null, sync: { id: full.id, version: full.version, dirty: false } }, oldName, true);
    rep.scaricati.push(nome);
    return nome;
  };
  const insert = async rec => {
    for (let k = 0; k < 3; k++) {
      try {
        const r = await R.insert({ name: rec.nome, files: rec.files, devices: rec.devices ?? null });
        await putLocal({ ...rec, sync: { id: r.id, version: r.version, dirty: false } }, rec.nome);
        remoteNames.add(rec.nome);
        rep.inviati.push(rec.nome);
        return;
      } catch (e) {
        if (e.code !== 'nome') return limite(e, rec.nome);
        // online c'è già un altro progetto con questo nome: questo prende un nome libero
        remoteNames.add(rec.nome);
        const old = rec.nome;
        rec = { ...rec, nome: free(rec.nome) };
        await putLocal({ ...rec, sync: { dirty: true } }, old);
      }
    }
  };
  const conflict = async (rec, r) => {
    const copia = { nome: free(conflictName(rec.nome, now())), files: rec.files, devices: rec.devices ?? null, sync: { dirty: true } };
    await putLocal(copia);
    rep.conflitti.push({ progetto: r.name, copia: copia.nome });
    await pull(r.id, rec.nome);
    await insert(copia);
  };

  // 1. progetti eliminati qui mentre ero offline: si eliminano online solo se nel frattempo non sono cambiati
  for (const t of await L.tombstones()) {
    const r = byId.get(t.id);
    if (r && r.version === t.version) { await R.remove(t.id); byId.delete(t.id); remoteNames.delete(r.name); rep.eliminatiOnline.push(r.name); }
    await L.clearTombstone(t.id);
  }

  // 2. progetti che ho qui
  for (const rec of local) {
    const s = rec.sync || {};
    const r = s.id ? byId.get(s.id) : null;
    if (s.id && r) {
      byId.delete(s.id);
      if (r.version === s.version) {
        if (!s.dirty) continue;
        let res = null;
        try {
          try { res = await R.update(s.id, s.version, { name: rec.nome, files: rec.files, devices: rec.devices ?? null }); }
          catch (e) {
            if (e.code !== 'nome') throw e;
            const old = rec.nome; rec.nome = free(rec.nome);
            await putLocal({ ...rec }, old);
            res = await R.update(s.id, s.version, { name: rec.nome, files: rec.files, devices: rec.devices ?? null });
          }
        } catch (e) { limite(e, rec.nome); continue; }
        if (res) { await putLocal({ ...rec, sync: { id: s.id, version: res.version, dirty: false } }, rec.nome); rep.inviati.push(rec.nome); }
        else await conflict(rec, { ...r, ...(await R.get(s.id)) });   // cambiato online proprio adesso
      } else if (!s.dirty) await pull(s.id, rec.nome);
      else await conflict(rec, r);
    } else if (s.id && !r) {
      // eliminato online (da un altro computer)
      if (s.dirty) await insert({ ...rec, sync: {} });          // qui era cambiato: lo tengo e lo rimando
      else { await L.del(rec.nome); used.delete(rec.nome); rep.eliminatiQui.push(rec.nome); }
    } else await insert(rec);
  }

  // 3. progetti nuovi online (fatti da un altro computer)
  for (const r of byId.values()) await pull(r.id, null);
  return rep;
}

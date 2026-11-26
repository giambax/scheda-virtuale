// strumenta.js — debug passo passo (fase 2, punto E): prepara un file .c per il debug, senza cambiare i numeri di riga.
//   - all'inizio di ogni istruzione (al massimo una per riga) inserisce __svr(ID), ID = (file+1)·100000 + riga:
//     lì il simulatore controlla breakpoint e passi, e se deve fermarsi aspetta la pagina (sim_hal.c, SIM_DBG);
//   - dopo ogni dichiarazione di variabile locale: __svl("nome", &nome, sizeof nome, tipo, elemento) (variabili locali);
//   - in fondo al file un costruttore che registra le variabili globali (fuori dai #if: potrebbero non esserci).
// Entrata e uscita delle funzioni: __sve all'inizio del corpo, __svx con __attribute__((cleanup)) a ogni uscita
// (in WebAssembly -finstrument-functions non va: manca __builtin_return_address).
// Non serve un parser C completo: basta riconoscere dove comincia un'istruzione. Dove sarebbe rischioso
// (corpo di if/for/while/else senza graffe, case, etichette, intestazioni dei for) non si mette niente:
// quella riga non è un punto di arresto (il breakpoint si sposta alla riga dopo che lo è).
// Punto H (25/11/2026): anche i parametri delle funzioni (registrati all'entrata), il nome del tipo di ogni variabile
// e, in fondo al file, i campi delle struct/union definite nel file (__svt, con offsetof) e i valori degli enum
// (__svn): così la pagina mostra le strutture campo per campo e gli enum per nome.
// Funziona anche in Node (strumenti/prova-strumenta.mjs).

const KW_CTRL = new Set(['if', 'for', 'while', 'switch']);
const TIPI_BASE = /^(void|char|short|int|long|float|double|signed|unsigned|_Bool|bool|size_t|ssize_t|ptrdiff_t|u?int(8|16|32|64)_t|u?int_(least|fast)(8|16|32|64)_t|uintptr_t|intptr_t|FlagStatus|ITStatus|ErrorStatus|FunctionalState|HAL_StatusTypeDef|GPIO_PinState|[A-Z][A-Za-z0-9_]*TypeDef|[A-Za-z_][A-Za-z0-9_]*_t)$/;
const QUALIF = new Set(['static', 'const', 'volatile', 'register', 'extern', 'inline', 'auto', 'struct', 'union', 'enum', 'signed', 'unsigned', 'short', 'long']);

// gettoni: { t: testo, k: 'id'|'num'|'str'|'p'(punteggiatura), riga, ini, fin } — commenti e direttive saltati
function gettoni(src) {
  const out = [];
  let i = 0, riga = 1, inizioRiga = true, cond = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { riga++; i++; inizioRiga = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') riga++; i++; } i += 2; continue; }
    if (c === '#' && inizioRiga) {   // direttiva del preprocessore, anche su più righe con "\"
      const ini = i;
      while (i < n && src[i] !== '\n') { if (src[i] === '\\' && src[i + 1] === '\n') { riga++; i += 2; continue; } if (src[i] === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') riga++; i++; } i += 2; continue; } i++; }
      // "#line N" (da hoistNested di build.js): le righe dopo contano da N, come per il compilatore
      const dir = src.slice(ini, i);
      const m = /^#\s*(?:line\s+)?(\d+)/.exec(dir);
      if (m) riga = +m[1] - 1;
      if (/^#\s*if/.test(dir)) cond++; else if (/^#\s*endif/.test(dir)) cond = Math.max(0, cond - 1);
      continue;
    }
    inizioRiga = false;
    const ini = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') i++; if (src[i] === '\n') riga++; i++; }
      i++;
      out.push({ t: src.slice(ini, i), k: 'str', riga, ini, fin: i, cond });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) { while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++; out.push({ t: src.slice(ini, i), k: 'id', riga, ini, fin: i, cond }); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) { while (i < n && /[0-9A-Za-z_.]/.test(src[i]) || (i < n && /[+-]/.test(src[i]) && /[eEpP]/.test(src[i - 1]))) i++; out.push({ t: src.slice(ini, i), k: 'num', riga, ini, fin: i, cond }); continue; }
    const tre = src.slice(i, i + 3), due = src.slice(i, i + 2);
    const p = ['<<=', '>>=', '...'].includes(tre) ? tre : ['->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##', '::'].includes(due) ? due : c;
    i += p.length;
    out.push({ t: p, k: 'p', riga, ini, fin: i, cond });
  }
  return out;
}

// tipi definiti nel file (typedef struct/enum/…): nome → tipo per la pagina ('s' struttura, 'i' enum, …)
let TIPI_UTENTE = new Map();
const tipoBase = t => TIPI_BASE.test(t) || TIPI_UTENTE.has(t);
// nome del tipo (per la pagina: campi delle strutture, nomi degli enum): l'ultimo identificatore che non è un qualificatore
function nomeTipo(tipi) {
  for (let i = tipi.length - 1; i >= 0; i--) if (!QUALIF.has(tipi[i]) || /^(struct|union|enum)$/.test(tipi[i]) && false) { if (!/^(struct|union|enum)$/.test(tipi[i])) return tipi[i]; }
  return '';
}
// tipo per la pagina: f float, d double, u senza segno, i con segno, b bool, c char, p puntatore, s struttura/altro
function tipoDi(tipi, puntatore) {
  if (puntatore) return 'p';
  const s = tipi.join(' ');
  const ut = tipi.find(t => TIPI_UTENTE.has(t));
  if (ut) return TIPI_UTENTE.get(ut);
  if (/\bfloat\b/.test(s)) return 'f';
  if (/\bdouble\b/.test(s)) return 'd';
  if (/\b(_Bool|bool)\b/.test(s)) return 'b';
  if (/\bchar\b/.test(s) && !/unsigned/.test(s)) return 'c';
  if (/\bunsigned\b|\buint|\bsize_t\b|uintptr_t|FlagStatus|GPIO_PinState/.test(s)) return 'u';
  if (/\b(int|short|long|signed|char|int\d+_t|intptr_t|ptrdiff_t|HAL_StatusTypeDef|ErrorStatus|FunctionalState)\b/.test(s)) return 'i';
  return 's';
}
// "int a = 1, *b, c[4];" (gettoni senza il ";") → [{nome, tipo, arr}] oppure null se non è una dichiarazione
function dichiarazione(g) {
  let i = 0;
  const tipi = [];
  while (i < g.length && g[i].k === 'id' && (QUALIF.has(g[i].t) || (tipoBase(g[i].t) && !tipi.some(tipoBase)) || (tipi.some(t => t === 'struct' || t === 'union' || t === 'enum') && tipi.length && !tipoBase(tipi[tipi.length - 1]) && !QUALIF.has(g[i].t) && tipi[tipi.length - 1] !== g[i].t && /^(struct|union|enum)$/.test(tipi[tipi.length - 1])))) { tipi.push(g[i].t); i++; }
  if (!tipi.some(t => tipoBase(t) || /^(struct|union|enum)$/.test(t))) return null;
  if (tipi.includes('extern') || tipi.includes('typedef') || tipi.includes('register')) return null;
  const out = [];
  let prof = 0, inizio = true, punt = false, nome = null, arr = false;
  for (; i <= g.length; i++) {
    const x = g[i];
    if (!x || (prof === 0 && x.t === ',')) {
      if (nome) out.push({ nome, tipo: tipoDi(tipi, punt && !arr), arr, punt, tn: nomeTipo(tipi) });
      inizio = true; punt = false; nome = null; arr = false;
      continue;
    }
    if (x.t === '(' || x.t === '[' || x.t === '{') { if (inizio && x.t === '(') return null; if (prof === 0 && x.t === '[' && nome) arr = true; prof++; continue; }
    if (x.t === ')' || x.t === ']' || x.t === '}') { prof--; continue; }
    if (prof > 0) continue;
    if (inizio && x.t === '*') { punt = true; continue; }
    if (inizio && x.k === 'id' && (x.t === 'const' || x.t === 'volatile')) continue;
    if (inizio && x.k === 'id') { nome = x.t; inizio = false; continue; }
    if (x.t === '=') { inizio = false; continue; }
    if (inizio) return null;
  }
  return out.length ? out : null;
}
const reg = (fn, v) => `${fn}("${v.nome}",(void*)&${v.nome},(unsigned)sizeof(${v.nome}),'${v.tipo}',(unsigned)${v.arr ? `sizeof(${v.nome}[0])` : 0},"${v.tn || ''}");`;
// struct/union/enum definite nel file (fuori dai #if): { struct: [{ nome, espr, campi }], enum: [{ nome, valori }] }
function tipiDelFile(g) {
  const out = { struct: [], enum: [] };
  let prof = 0;
  for (let k = 0; k < g.length; k++) {
    const x = g[k];
    if (x.t === '{') { prof++; continue; }
    if (x.t === '}') { prof--; continue; }
    if (prof || x.cond > 0 || !/^(struct|union|enum)$/.test(x.t)) continue;
    const td = g[k - 1] && g[k - 1].t === 'typedef', tag = g[k + 1] && g[k + 1].k === 'id' ? g[k + 1].t : null;
    const ap = tag ? k + 2 : k + 1;
    if (!g[ap] || g[ap].t !== '{') continue;
    let j = ap + 1, d = 1;
    for (; j < g.length && d; j++) { if (g[j].t === '{') d++; else if (g[j].t === '}') d--; }
    const corpo = g.slice(ap + 1, j - 1), dopo = [];
    let e = j;
    for (; e < g.length && g[e].t !== ';'; e++) dopo.push(g[e]);
    const nomeTd = td && dopo.length === 1 && dopo[0].k === 'id' ? dopo[0].t : null;
    const nome = nomeTd || tag, espr = nomeTd || (tag && `${x.t} ${tag}`);
    if (!nome || !espr) continue;
    if (x.t === 'enum') {
      const valori = [];
      let pr = 0, inizio = true;
      for (const t of corpo) { if (t.t === '(') pr++; else if (t.t === ')') pr--; else if (pr === 0 && t.t === ',') inizio = true; else if (inizio && t.k === 'id') { valori.push(t.t); inizio = false; } else inizio = false; }
      out.enum.push({ nome, valori });
      if (nomeTd) TIPI_UTENTE.set(nomeTd, 'i');
    } else {
      out.struct.push({ nome, espr, corpo });
      if (nomeTd) TIPI_UTENTE.set(nomeTd, 's');
    }
  }
  // campi (dopo, così un campo può essere di un tipo definito prima)
  for (const st of out.struct) {
    st.campi = [];
    let pezzo = [], pr = 0;
    for (const t of [...st.corpo, { t: ';' }]) {
      if (t.t === '{' || t.t === '(') pr++; else if (t.t === '}' || t.t === ')') pr--;
      if (pr === 0 && t.t === ';') {
        if (pezzo.length && !pezzo.some(q => q.t === ':' || q.t === '{')) for (const v of dichiarazione(pezzo) || []) st.campi.push(v);
        pezzo = [];
      } else pezzo.push(t);
    }
    delete st.corpo;
  }
  return out;
}
const regCampo = (st, v) => `__svt("${st.nome}","${v.nome}",(unsigned)__builtin_offsetof(${st.espr},${v.nome}),(unsigned)sizeof(((${st.espr}*)0)->${v.nome}),'${v.tipo}',(unsigned)${v.arr ? `sizeof(((${st.espr}*)0)->${v.nome}[0])` : 0},"${v.tn || ''}");`;

// dichiarazioni per i file preparati (build.js le passa con -include: niente testo in più in cima al file,
// che può cominciare con una direttiva del preprocessore)
export const PROLOGO = 'extern void __svr(unsigned);\nextern void __svl(const char*,void*,unsigned,int,unsigned,const char*);\nextern int __sve(void*,const char*);\nextern void __svx(int*);\n' +
  'extern void __svt(const char*,const char*,unsigned,unsigned,int,unsigned,const char*);\nextern void __svn(const char*,const char*,long long);\n';

// src: testo del file; idFile: numero del file (0, 1, …) → { testo, righe: [righe con __svr], funzioni: [nomi], globali: [nomi] }
export function strumenta(src, idFile) {
  const g = gettoni(src);
  TIPI_UTENTE = new Map();
  const tipiFile = tipiDelFile(g);
  const ins = [];                      // [posizione, testo] da inserire
  const righe = new Set(), funzioni = [], globali = [];
  const graffe = [];                   // 'c' codice, 'd' dati (inizializzatori, struct), 'f' corpo di funzione
  let par = 0, qua = 0;
  let aspetta = 'no';                  // 'si' = qui comincia un'istruzione; 'nohook' = sotto-istruzione senza graffe
  let intestazione = null, parIntest = -1, caso = false, stmtIni = -1, dentroDo = [];
  let ultimoBloccoDo = false;
  let forIni = -1, forDecl = null;     // "for (int i = …; …)": la variabile del for si registra all'inizio del corpo
  let fileStmt = [];                   // gettoni dell'istruzione a livello di file (per globali e funzioni)
  const inCodice = () => graffe.length && graffe[graffe.length - 1] !== 'd';
  for (let k = 0; k < g.length; k++) {
    const x = g[k], prev = g[k - 1];
    const livelloFile = graffe.length === 0;
    // inizio di un'istruzione dentro una funzione
    if (inCodice() && par === 0 && qua === 0 && (aspetta === 'si' || aspetta === 'nohook')) {
      const hook = aspetta === 'si';
      aspetta = 'no';
      const fd = forDecl; forDecl = null;
      if (x.t === '{') { graffe.push('c'); dentroDo.push(ultimoBloccoDo); ultimoBloccoDo = false; aspetta = 'si'; if (fd) ins.push([x.fin, fd.map(v => reg('__svl', v)).join('')]); continue; }
      if (x.t === '}' || x.t === ';') { k--; continue; }   // gestiti sotto
      if (x.t === 'else') { aspetta = 'nohook'; continue; }
      if (x.t === 'case' || x.t === 'default') { caso = true; continue; }
      if (x.k === 'id' && g[k + 1] && g[k + 1].t === ':' && !KW_CTRL.has(x.t)) { k++; aspetta = 'si'; continue; }   // etichetta
      if (x.t === 'while' && prev && prev.t === '}' && g[k - 1].doChiuso) { stmtIni = k; continue; }               // "} while (…);" del do
      if (hook && !righe.has(x.riga)) { ins.push([x.ini, `__svr(${(idFile + 1) * 100000 + x.riga});`]); righe.add(x.riga); }
      stmtIni = k;
      if (KW_CTRL.has(x.t)) { intestazione = x.t; parIntest = par; forIni = -1; }
      else if (x.t === 'do') { aspetta = 'nohook'; ultimoBloccoDo = true; stmtIni = -1; }
      continue;
    }
    if (livelloFile && x.t !== ';' && x.t !== '{') fileStmt.push(x);
    if (x.t === '(') { par++; if (intestazione === 'for' && par === parIntest + 1 && forIni === -1) forIni = k + 1; continue; }
    if (x.t === ';' && intestazione === 'for' && par === parIntest + 1 && forIni >= 0) { const d = k > forIni ? dichiarazione(g.slice(forIni, k)) : null; forDecl = d && d.length ? d : null; forIni = -2; }
    if (x.t === ')') {
      par--;
      if (intestazione && par === parIntest) { intestazione = null; aspetta = 'nohook'; stmtIni = -1; }
      continue;
    }
    if (x.t === '[') { qua++; continue; }
    if (x.t === ']') { qua--; continue; }
    if (par > 0 || qua > 0) continue;
    if (x.t === ':' && caso) { caso = false; aspetta = 'si'; continue; }
    if (x.t === '{') {
      if (livelloFile) {
        // corpo di funzione: ... nome ( ... ) {   (non "= {", non struct/enum/union)
        const st = fileStmt;
        let j = st.length - 1;
        if (st[j] && st[j].t === ')') {
          let d = 0;
          for (; j >= 0; j--) { if (st[j].t === ')') d++; else if (st[j].t === '(') { d--; if (d === 0) break; } }
          const nome = st[j - 1];
          if (nome && nome.k === 'id' && !st.some(t => t.t === '=')) {
            funzioni.push(nome.t); graffe.push('f'); aspetta = 'si'; fileStmt = [];
            // parametri: come variabili locali, registrati appena si entra (un array come parametro è un puntatore)
            const par = [];
            let pz = [], pd = 0;
            for (const t of [...st.slice(j + 1, -1), { t: ',' }]) {
              if (t.t === '(' || t.t === '[') pd++; else if (t.t === ')' || t.t === ']') pd--;
              if (pd === 0 && t.t === ',') { const d = pz.length ? dichiarazione(pz) : null; if (d) for (const v of d) par.push(v.arr ? { ...v, tipo: 'p', arr: false } : v); pz = []; } else pz.push(t);
            }
            // entrata nella funzione e uscita (da qualsiasi return) con __attribute__((cleanup)): stack e profondità
            ins.push([x.fin, `__attribute__((cleanup(__svx))) int __svk = __sve((void*)${nome.t},"${nome.t}");` + par.map(v => reg('__svl', v)).join('')]);
            continue;
          }
        }
        graffe.push('d'); continue;
      }
      if (!inCodice()) { graffe.push('d'); continue; }
      // dentro una funzione ma a metà istruzione: inizializzatore o struttura
      graffe.push(prev && (prev.t === ')' ) ? 'c' : 'd');
      if (graffe[graffe.length - 1] === 'c') { aspetta = 'si'; dentroDo.push(false); }
      continue;
    }
    if (x.t === '}') {
      const kind = graffe.pop();
      if (kind === 'c') { const eraDo = dentroDo.pop(); if (eraDo) x.doChiuso = true; aspetta = 'si'; }
      else if (kind === 'f') { aspetta = 'no'; fileStmt = []; }
      continue;
    }
    if (x.t === ';') {
      if (livelloFile) {
        // variabile globale: dichiarazione a livello di file senza "(" prima di "=" (no prototipi)
        const st = fileStmt;
        const uguale = st.findIndex(t => t.t === '=');
        const testa = uguale < 0 ? st : st.slice(0, uguale);
        if (!testa.some(t => t.t === '(') && !st.some(t => t.t === 'typedef')) {
          const d = dichiarazione(st);
          if (d && !st.some(t => t.cond > 0)) for (const v of d) globali.push(v);
        }
        fileStmt = [];
        continue;
      }
      if (inCodice()) {
        // dichiarazione di variabili locali → registrazione subito dopo il ";"
        if (stmtIni >= 0) {
          const st = g.slice(stmtIni, k);
          const d = dichiarazione(st);
          if (d && !st.some(t => t.t === 'static' && false)) ins.push([x.fin, d.map(v => reg('__svl', v)).join('')]);
        }
        stmtIni = -1;
        aspetta = 'si';
      }
      continue;
    }
  }
  // inserimenti dal fondo, così le posizioni restano giuste; tutto sulla stessa riga
  // a parità di posizione prima quello aggiunto dopo, così nel testo resta l'ordine di aggiunta (es. __sve prima di __svr
  // in una funzione scritta tutta su una riga)
  ins.forEach((x, i) => x.push(i));
  ins.sort((a, b) => b[0] - a[0] || b[2] - a[2]);
  let out = src;
  for (const [p, t] of ins) out = out.slice(0, p) + t + out.slice(p);
  const coda = globali.map(v => reg('__svg', v)).join('') +
    tipiFile.struct.flatMap(st => st.campi.map(v => regCampo(st, v))).join('') +
    tipiFile.enum.flatMap(en => en.valori.map(v => `__svn("${en.nome}","${v}",(long long)(${v}));`)).join('');
  out = out + `\n__attribute__((constructor)) static void __svreg_${idFile}(void){extern void __svg(const char*,void*,unsigned,int,unsigned,const char*);${coda}}\n`;
  return { testo: out, prologo: PROLOGO, righe: [...righe].sort((a, b) => a - b), funzioni, globali: globali.map(v => v.nome) };
}

// cubeide.js — fase Q (26/11/2026): esporta un progetto del sito come progetto STM32CubeIDE completo, che si importa
// con File > Import > General > Existing Projects into Workspace > Select archive file (lo zip) e si compila subito.
// Il sito tiene solo Core/, .ioc, .cproject e i suoi .json: qui si aggiungono .project, .cproject (se manca),
// linker script, startup, syscalls/sysmem/system_stm32f4xx.c (dal progetto vuoto di CubeIDE per la NUCLEO-F401RE) e
// Drivers/ (header di vendor/stm32f4/pacchetto.json + sorgenti HAL di vendor/stm32f4/cubeide-f401re.json, creato da
// strumenti/crea-cubeide.py). Funziona anche in Node (strumenti/prova-cubeide.mjs): niente DOM qui dentro.

const enc = new TextEncoder(), dec = new TextDecoder();
// nome del progetto per CubeIDE: niente spazi né simboli (make e il linker non li amano)
export const nomeCubeIDE = n => String(n || '').replace(/^📂\s*/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Progetto';

// rec: { nome, files: { rel: Uint8Array }, devices }; hal: pacchetto.json ({ files }); cube: cubeide-f401re.json ({ hal, modelli })
// → { nome, tree: { 'Nome/rel': Uint8Array }, avvisi: [testo] }
export function progettoCubeIDE(rec, hal, cube) {
  const nome = nomeCubeIDE(rec.nome), P = nome + '/', tree = {}, avvisi = [];
  const files = { ...rec.files };
  const testo = rel => dec.decode(files[rel]);
  const ha = re => Object.keys(files).some(k => re.test(k));
  // .ioc: uno solo, in cima, con il nome del progetto (CubeMX rigenera nella cartella che ha lo stesso nome)
  const iocs = Object.keys(files).filter(k => /^[^/]+\.ioc$/.test(k));
  if (iocs.length) {
    let t = testo(iocs[0]);
    const metti = (chiave, val) => { const re = new RegExp('^' + chiave.replace('.', '\\.') + '=.*$', 'm'); t = re.test(t) ? t.replace(re, `${chiave}=${val}`) : t.replace(/\s*$/, `\n${chiave}=${val}\n`); };
    metti('ProjectManager.ProjectName', nome);
    metti('ProjectManager.ProjectFileName', nome + '.ioc');
    metti('ProjectManager.TargetToolchain', 'STM32CubeIDE');
    const mcu = (t.match(/^Mcu\.UserName=(.*)$/m) || [])[1];
    if (mcu && !/^STM32F401R[DE]Tx$/.test(mcu.trim())) avvisi.push(`Il .ioc è per ${mcu.trim()}: linker script e file di avvio aggiunti qui sono per la NUCLEO-F401RE (STM32F401RETx). Se la tua scheda è un'altra, in CubeIDE apri il .ioc e rigenera il codice.`);
    for (const k of iocs) delete files[k];
    files[nome + '.ioc'] = enc.encode(t);
    if (iocs.length > 1) avvisi.push(`Il progetto aveva ${iocs.length} file .ioc: tengo solo ${iocs[0]}.`);
  } else avvisi.push('Il progetto non ha il file .ioc: CubeIDE lo compila lo stesso, ma non potrai cambiare i pin con CubeMX.');
  // doppioni di iCloud ("main 2.c" accanto a "main.c"): CubeIDE li compilerebbe tutti e due → "multiple definition"
  for (const k of Object.keys(files)) {
    const m = k.match(/^(.*) \d+(\.[ch])$/);
    if (m && files[m[1] + m[2]]) { delete files[k]; avvisi.push(`Tolto ${k}: è un doppione di ${m[1] + m[2]} (lo crea iCloud) e darebbe «multiple definition».`); }
  }
  if (!files['Core/Inc/stm32f4xx_hal_conf.h']) avvisi.push('Manca Core/Inc/stm32f4xx_hal_conf.h: in CubeIDE apri il .ioc e premi «Generate Code» (Alt+K) per crearlo.');
  // .cproject: quello del progetto (con il nome nuovo) o quello del progetto vuoto di CubeIDE
  if (files['.cproject']) {
    let t = testo('.cproject');
    const vecchio = (t.match(/<project id="([^"]+)\.null\.\d+" name="([^"]+)"/) || [])[2];
    if (vecchio && vecchio !== nome) t = t.split(`\${workspace_loc:/${vecchio}}`).join(`\${workspace_loc:/${nome}}`).split(`name="${vecchio}"`).join(`name="${nome}"`).split(`id="${vecchio}.null`).join(`id="${nome}.null`).split(`/${vecchio}/`).join(`/${nome}/`);
    files['.cproject'] = enc.encode(t);
  }
  const M = cube.modelli, metti = (rel, t) => { if (!files[rel]) files[rel] = enc.encode(t.split('{{NOME}}').join(nome)); };
  metti('.project', M['.project']);
  metti('.cproject', M['.cproject']);
  metti('.settings/org.eclipse.core.resources.prefs', M['.settings/org.eclipse.core.resources.prefs']);
  if (!ha(/^[^/]+\.ld$/)) { metti('STM32F401RETX_FLASH.ld', M['STM32F401RETX_FLASH.ld']); metti('STM32F401RETX_RAM.ld', M['STM32F401RETX_RAM.ld']); }
  if (!ha(/^Core\/Startup\/.*\.s$/i)) metti('Core/Startup/startup_stm32f401retx.s', M['Core/Startup/startup_stm32f401retx.s']);
  for (const f of ['syscalls.c', 'sysmem.c', 'system_stm32f4xx.c']) metti('Core/Src/' + f, M['Core/Src/' + f]);
  // Drivers: header e sorgenti HAL (il .cproject compila le cartelle Core e Drivers)
  for (const [k, v] of Object.entries(hal.files)) if (/^Drivers\//.test(k)) tree[P + k] = enc.encode(v);
  for (const [k, v] of Object.entries(cube.hal)) tree[P + k] = enc.encode(v);
  for (const [k, v] of Object.entries(files)) tree[P + k] = v;
  if (rec.devices) tree[P + '.scheda-virtuale.json'] = enc.encode(JSON.stringify({ devices: rec.devices }));
  tree[P + 'LEGGIMI-CubeIDE.txt'] = enc.encode(leggimi(nome, avvisi));
  return { nome, tree, avvisi };
}

function leggimi(nome, avvisi) {
  return `Progetto «${nome}» esportato dalla Scheda Virtuale STM32 (https://giambax.github.io/scheda-virtuale/) per STM32CubeIDE.

Come aprirlo in STM32CubeIDE
1. File > Import… > General > Existing Projects into Workspace > Next.
2. «Select archive file» > Browse… > scegli lo zip appena scaricato (oppure scompattalo e usa «Select root directory»).
3. Spunta «${nome}» e premi Finish. Se c'è già un progetto con lo stesso nome nel workspace, rinomina o elimina prima quello.
4. Project > Build Project (il martello): crea Debug/${nome}.elf.
5. Run > Debug As > STM32 C/C++ Application per caricarlo sulla NUCLEO-F401RE (o «⬆ Sulla scheda…» nel sito con il .elf).

Cosa c'è dentro
- Core/ e il file .ioc del sito (il codice tra USER CODE BEGIN/END è il tuo).
- .project e .cproject per CubeIDE, linker script (STM32F401RETX_FLASH.ld), file di avvio
  (Core/Startup/startup_stm32f401retx.s), syscalls.c, sysmem.c, system_stm32f4xx.c: quelli che CubeIDE crea per
  la NUCLEO-F401RE (se il progetto li aveva già, restano i suoi).
- Drivers/: CMSIS e HAL STM32F4 (STM32Cube FW_F4 V1.28.3, licenze ST nelle cartelle). Ci sono tutti i moduli della
  HAL: si compilano solo quelli accesi in Core/Inc/stm32f4xx_hal_conf.h, come nei progetti fatti da CubeMX.
- .breadboard.json e .scheda-virtuale.json: circuito e dispositivi del sito. CubeIDE li ignora; se ricarichi la
  cartella o lo zip nel sito tornano anche breadboard e dispositivi.

Se cambi i pin: apri ${nome}.ioc, modifica e premi «Generate Code» (Alt+K): CubeMX tiene il codice tra USER CODE
BEGIN/END e rifà il resto.
${avvisi.length ? '\nAvvisi\n' + avvisi.map(a => '- ' + a).join('\n') + '\n' : ''}`;
}

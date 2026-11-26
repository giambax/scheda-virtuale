'use strict';
/* nucleo.js — disegno della NUCLEO-F401RE come quella vera (fase 3, punto O, 26/11/2026), uguale nelle viste
 * Breadboard (breadboard.js) e Scheda (app.js). Disegno nostro, misure dallo user manual UM1724 (Nucleo-64):
 * scheda 70 × 82,5 mm, PCB bianco con serigrafie nere; in alto la parte ST-LINK/V2-1 (staccabile: linea
 * tratteggiata) con il connettore mini-USB, l'STM32F103, LD1 COM, CN2 e CN4 SWD; sotto B1 USER (blu) e B2 RESET
 * (nero), LD2 verde, LD3 PWR rosso, l'STM32F401RET6 in LQFP64 ruotato di 45°, il quarzo X3 da 32,768 kHz,
 * JP5 e JP6 (IDD), i connettori Morpho CN7/CN10 (maschi 2×19) ai lati e quelli Arduino CN5/CN6/CN8/CN9 (femmine).
 * Unità: 10 = un passo da 2,54 mm, come i fori di circuito.js (CN7 in x = 1–2, CN10 in 27–28, righe da y = 12).
 * Niente gradienti: colori pieni, pochi dettagli (resta leggero da ridisegnare).
 * nucleoSVG({ scheda }) → stringa SVG (senza <svg>): scheda = true aggiunge i pin cliccabili (.hp con data-pin),
 * i nomi dei pin e gli id usati da app.js (#b1, #b1cap, #b2, #ld1, #ld2, #ld3); senza, gli id della breadboard (#bb-ld2). */

const NUC = {
  // connettori come in circuito.js (stesso ordine): Morpho a due file, Arduino dall'alto in basso
  CN7: ['PC10', 'PC11', 'PC12', 'PD2', 'VDD', 'E5V', 'BOOT0', 'GND', 'NC', 'NC', 'NC', 'IOREF', 'PA13', 'RESET', 'PA14', '+3V3', 'PA15', '+5V', 'GND', 'GND',
    'PB7', 'GND', 'PC13', 'VIN', 'PC14', 'NC', 'PC15', 'PA0', 'PH0', 'PA1', 'PH1', 'PA4', 'VBAT', 'PB0', 'PC2', 'PC1', 'PC3', 'PC0'],
  CN10: ['PC9', 'PC8', 'PB8', 'PC6', 'PB9', 'PC5', 'AVDD', 'U5V', 'GND', 'NC', 'PA5', 'PA12', 'PA6', 'PA11', 'PA7', 'PB12', 'PB6', 'NC', 'PC7', 'GND',
    'PA9', 'PB2', 'PA8', 'PB1', 'PB10', 'PB15', 'PB4', 'PB14', 'PB5', 'PB13', 'PB3', 'AGND', 'PA10', 'PC4', 'PA2', 'NC', 'PA3', 'NC'],
  CN6: [['NC', ''], ['IOREF', ''], ['RESET', ''], ['3V3', ''], ['5V', ''], ['GND', ''], ['GND', ''], ['VIN', '']],
  CN8: [['A0', 'PA0'], ['A1', 'PA1'], ['A2', 'PA4'], ['A3', 'PB0'], ['A4', 'PC1'], ['A5', 'PC0']],
  CN5: [['D15', 'PB8'], ['D14', 'PB9'], ['AVDD', ''], ['GND', ''], ['D13', 'PA5'], ['D12', 'PA6'], ['D11', 'PA7'], ['D10', 'PB6'], ['D9', 'PC7'], ['D8', 'PA9']],
  CN9: [['D7', 'PA8'], ['D6', 'PB10'], ['D5', 'PB4'], ['D4', 'PB5'], ['D3', 'PB3'], ['D2', 'PA10'], ['D1', 'PA2'], ['D0', 'PA3']],
  COL: { pcb: '#f5f5f0', bordo: '#c6c6bb', silk: '#24262a', silk2: '#5b5e64', rame: '#cdb46a', plastica: '#1c1d20', metallo: '#c3c7cd', smd: '#b8a07a' },
};

function nucleoSVG(opz = {}) {
  const C = NUC.COL, s = [];
  const t = (x, y, testo, fs = 6, extra = '') => `<text x="${x}" y="${y}" font-size="${fs}" fill="${C.silk}" font-family="system-ui, sans-serif" ${extra}>${testo}</text>`;
  const smd = (x, y, w = 5, h = 2.6, r = 0) => `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="${C.smd}" transform="rotate(${r} ${x} ${y})"/>`;
  // PCB 70 × 82,5 mm (fori di montaggio, linea di taglio dell'ST-LINK)
  s.push(`<rect x="2.5" y="-13" width="285" height="325" rx="7" fill="${C.pcb}" stroke="${C.bordo}" stroke-width="1"/>`);
  for (const [x, y] of [[13, -2], [277, -2], [13, 72], [277, 72], [40, 304], [250, 304]]) s.push(`<circle cx="${x}" cy="${y}" r="4.6" fill="${C.rame}"/><circle cx="${x}" cy="${y}" r="2.9" fill="#fff" stroke="${C.bordo}" stroke-width=".5"/>`);
  s.push(`<line x1="3" y1="83" x2="287" y2="83" stroke="${C.silk2}" stroke-width=".8" stroke-dasharray="3 3"/>`);
  // --- parte ST-LINK/V2-1
  s.push(`<rect x="129" y="-21" width="32" height="22" rx="2" fill="${C.metallo}" stroke="#8b9097" stroke-width=".8"/><rect x="135" y="-17" width="20" height="6" rx="1" fill="#2a2c30"/>`);
  s.push(t(145, 9, 'CN1 USB', 4.6, 'text-anchor="middle"'));
  s.push(`<g transform="rotate(45 196 42)"><rect x="182" y="28" width="28" height="28" fill="${C.plastica}"/>` +
    Array.from({ length: 12 }, (_, i) => { const o = 184 + i * 2.2; return `<rect x="${o}" y="25.5" width="1" height="2.5" fill="#a9adb3"/><rect x="${o}" y="56" width="1" height="2.5" fill="#a9adb3"/><rect x="179.5" y="${o}" width="2.5" height="1" fill="#a9adb3"/><rect x="210" y="${o}" width="2.5" height="1" fill="#a9adb3"/>`; }).join('') + `</g>`);
  s.push(t(196, 44, 'STM32F103', 3.4, 'text-anchor="middle" fill="#cfd2d6"'));
  // LD1 COM (rosso/verde): si accende con lo stato del sito
  s.push(`<g id="${opz.scheda ? 'ld1' : 'bb-ld1'}"><rect x="96" y="20" width="9" height="6" rx="1" fill="#e9e4dc" stroke="#9c968b" stroke-width=".5"/><circle cx="100.5" cy="23" r="2.4" fill="#3a2020"/><circle class="glow" cx="100.5" cy="23" r="5" fill="none"/></g>`);
  s.push(t(100.5, 34, 'LD1 COM', 4.6, 'text-anchor="middle"'));
  // CN2 (2 ponticelli ST-LINK), CN4 SWD, JP1
  s.push(`<rect x="230" y="12" width="22" height="12" fill="${C.plastica}"/>` + [235, 247].map(x => `<rect x="${x - 4}" y="11" width="8" height="14" rx="1" fill="#d52f2f"/>`).join(''));
  s.push(t(241, 33, 'CN2', 4.6, 'text-anchor="middle"'));
  s.push(`<rect x="262" y="18" width="10" height="58" fill="${C.plastica}"/>` + Array.from({ length: 6 }, (_, i) => `<rect x="265" y="${21 + i * 9}" width="4" height="4" fill="${C.rame}"/>`).join(''));
  s.push(t(267, 14, 'CN4', 4.6, 'text-anchor="middle"') + t(267, 82, 'SWD', 4, 'text-anchor="middle"'));
  s.push(t(60, 62, 'ST-LINK/V2-1', 7, 'font-weight="700" text-anchor="middle"'));
  s.push(smd(80, 50) + smd(86, 50) + smd(118, 40, 2.6, 5) + smd(124, 40, 2.6, 5) + smd(225, 60) + smd(160, 66) + smd(166, 66));
  // --- parte del micro
  // B1 USER (blu) e B2 RESET (nero): pulsanti SMD 6 × 6 mm
  const pulsante = (id, cap, x, y, col) => `<g id="${opz.scheda ? id : 'bb-' + id}"${opz.scheda ? ' style="cursor:pointer"' : ''}><rect x="${x - 12}" y="${y - 12}" width="24" height="24" rx="2" fill="${C.metallo}" stroke="#8b9097" stroke-width=".8"/>` +
    [[-10, -10], [10, -10], [-10, 10], [10, 10]].map(([a, b]) => `<rect x="${x + a - 1.5}" y="${y + b - 1.5}" width="3" height="3" fill="#9da2a9"/>`).join('') +
    `<circle${opz.scheda ? ` id="${cap}"` : ''} cx="${x}" cy="${y}" r="7.5" fill="${col}" stroke="#0007" stroke-width=".8"/></g>`;
  s.push(pulsante('b1', 'b1cap', 82, 103, '#1f5fd1') + t(82, 124, 'B1 USER', 5, 'text-anchor="middle" font-weight="600"'));
  s.push(pulsante('b2', 'b2cap', 172, 103, '#1d1e21') + t(172, 124, 'B2 RESET', 5, 'text-anchor="middle" font-weight="600"'));
  // LD2 (verde, su PA5 come D13) e LD3 PWR (rosso)
  s.push(opz.scheda
    ? `<g id="ld2"><rect x="197" y="133" width="9" height="6" rx="1" fill="#e9e4dc" stroke="#9c968b" stroke-width=".5"/><circle class="core" cx="201.5" cy="136" r="2.4" fill="#2d4a33"/><circle class="glow" cx="201.5" cy="136" r="6" fill="#35ff7a" opacity="0" filter="url(#glow)"/></g>`
    : `<rect x="197" y="133" width="9" height="6" rx="1" fill="#e9e4dc" stroke="#9c968b" stroke-width=".5"/><circle id="bb-ld2" cx="201.5" cy="136" r="2.4" fill="#2d4a33"/>`);
  s.push(t(201.5, 147, 'LD2', 4.6, 'text-anchor="middle"'));
  s.push(`<g id="${opz.scheda ? 'ld3' : 'bb-ld3'}"><rect x="257" y="96" width="9" height="6" rx="1" fill="#e9e4dc" stroke="#9c968b" stroke-width=".5"/><circle cx="261.5" cy="99" r="2.4" fill="#ff3b30"/></g>` + t(261.5, 92, 'LD3 PWR', 4, 'text-anchor="middle"'));
  // JP5 (alimentazione U5V/E5V) e JP6 (IDD, misura della corrente del micro)
  s.push(`<rect x="111" y="92" width="8" height="24" fill="${C.plastica}"/><rect x="110" y="91" width="10" height="15" rx="1" fill="#2b2d31"/>` + t(115, 88, 'JP5', 4.4, 'text-anchor="middle"'));
  s.push(`<rect x="139" y="152" width="14" height="8" fill="${C.plastica}"/><rect x="138" y="151" width="16" height="10" rx="1" fill="#2b2d31"/>` + t(146, 168, 'JP6 IDD', 4.4, 'text-anchor="middle"'));
  // STM32F401RET6 in LQFP64 (10 × 10 mm) ruotato di 45°
  s.push(`<g transform="rotate(45 145 222)"><rect x="125" y="202" width="40" height="40" fill="${C.plastica}"/><circle cx="130" cy="207" r="1.6" fill="#33353a"/>` +
    Array.from({ length: 16 }, (_, i) => { const o = 127 + i * 2.35; return `<rect x="${o}" y="198.5" width="1.1" height="3.5" fill="#a9adb3"/><rect x="${o}" y="242" width="1.1" height="3.5" fill="#a9adb3"/><rect x="121.5" y="${o + 75}" width="3.5" height="1.1" fill="#a9adb3"/><rect x="165" y="${o + 75}" width="3.5" height="1.1" fill="#a9adb3"/>`; }).join('') + `</g>`);
  s.push(t(145, 220, 'STM32', 5.2, 'text-anchor="middle" font-weight="700" fill="#d9dbe0"') + t(145, 227, 'F401RET6', 3.8, 'text-anchor="middle" fill="#b0b4ba"'));
  s.push(t(145, 180, 'U5', 4.4, 'text-anchor="middle"'));
  // quarzo X3 32,768 kHz (LSE) e qualche condensatore attorno al micro
  s.push(`<rect x="96" y="258" width="16" height="7" rx="3" fill="${C.metallo}" stroke="#8b9097" stroke-width=".6"/>` + t(104, 274, 'X3', 4.4, 'text-anchor="middle"'));
  s.push(smd(120, 196, 2.6, 5) + smd(170, 196, 2.6, 5) + smd(120, 250, 2.6, 5) + smd(172, 250, 2.6, 5) + smd(145, 186) + smd(145, 260) + smd(100, 222, 2.6, 5) + smd(190, 222, 2.6, 5));
  // serigrafia
  s.push(t(145, 290, 'NUCLEO-F401RE', 9, 'text-anchor="middle" font-weight="800" letter-spacing=".4"'));
  s.push(t(145, 299, 'STM32 Nucleo-64', 4.4, 'text-anchor="middle" fill="' + C.silk2 + '"'));
  // connettori: Morpho maschi 2×19 (plastica nera sotto i pin) e Arduino femmine
  s.push(`<rect x="4.5" y="114.5" width="21" height="191" fill="${C.plastica}"/><rect x="264.5" y="114.5" width="21" height="191" fill="${C.plastica}"/>`);
  s.push(`<rect x="44" y="134" width="12" height="82" fill="${C.plastica}"/><rect x="44" y="224" width="12" height="62" fill="${C.plastica}"/>`);
  s.push(`<rect x="234" y="94" width="12" height="102" fill="${C.plastica}"/><rect x="234" y="204" width="12" height="82" fill="${C.plastica}"/>`);
  s.push(t(15, 110, 'CN7', 5.4, 'text-anchor="middle" font-weight="700"') + t(275, 110, 'CN10', 5.4, 'text-anchor="middle" font-weight="700"'));
  s.push(t(50, 130, 'CN6', 5, 'text-anchor="middle" font-weight="700"') + t(50, 296, 'CN8', 5, 'text-anchor="middle" font-weight="700"'));
  s.push(t(240, 90, 'CN5', 5, 'text-anchor="middle" font-weight="700"') + t(240, 296, 'CN9', 5, 'text-anchor="middle" font-weight="700"'));
  // pin numero 1 dei Morpho (triangolino)
  s.push(`<path d="M3 117 l3 3 l-3 3z" fill="${C.silk}"/><path d="M287 117 l-3 3 l3 3z" fill="${C.silk}"/>`);
  if (opz.scheda) s.push(pinScheda());
  return s.join('');
}

// vista Scheda: fori dei connettori cliccabili (.hp con data-pin = PA5…) e nomi dei pin
function pinScheda() {
  const C = NUC.COL, out = [];
  const nome = (x, y, testo, sotto, ancora, col = C.silk) => `<text x="${x}" y="${y + 2.1}" font-size="5.4" text-anchor="${ancora}" fill="${col}" font-family="ui-monospace, Menlo, monospace">${testo}${sotto ? `<tspan fill="${C.silk2}" font-size="4.4"> ${sotto}</tspan>` : ''}</text>`;
  const foro = (x, y, pin) => `<rect x="${x - 2.4}" y="${y - 2.4}" width="4.8" height="4.8" rx=".8" fill="#0d0e10"/><circle class="hp${pin ? '' : ' np'}" data-pin="${pin}" cx="${x}" cy="${y}" r="2" fill="#c8a85a"/>`;
  const colAlim = s => /^(\+?5V|\+?3V3|U5V|E5V|VIN|VDD|AVDD|IOREF|VBAT)$/.test(s) ? '#b3261e' : /^(GND|AGND)$/.test(s) ? '#111' : null;
  for (const [cn, x0] of [['CN7', 10], ['CN10', 270]]) NUC[cn].forEach((sig, i) => {
    const n = i + 1, x = x0 + (n % 2 === 0 ? 10 : 0), y = 120 + (n - 1 >> 1) * 10, pin = /^P[A-H]\d+$/.test(sig) ? sig : '';
    out.push(foro(x, y, pin));
    const fuori = cn === 'CN7' ? n % 2 === 1 : n % 2 === 0;   // nomi verso l'esterno solo per la fila esterna (dentro c'è l'altra fila)
    // fuori dalla scheda il fondo è quello della pagina (scuro o chiaro): colore del testo della pagina
    if (fuori) out.push(nome(cn === 'CN7' ? x - 4 : x + 4, y, sig.replace(/^\+/, ''), '', cn === 'CN7' ? 'end' : 'start', colAlim(sig) || 'var(--muted, #5b5e64)'));
    else out.push(nome(cn === 'CN7' ? x + 4 : x - 4, y, sig.replace(/^\+/, ''), '', cn === 'CN7' ? 'start' : 'end', colAlim(sig) || C.silk));
  });
  for (const [cn, x, y0, dentro] of [['CN6', 50, 140, 1], ['CN8', 50, 230, 1], ['CN5', 240, 100, -1], ['CN9', 240, 210, -1]]) NUC[cn].forEach(([a, p], i) => {
    const y = y0 + i * 10;
    out.push(foro(x, y, p));
    out.push(nome(x + dentro * 8, y, a, p, dentro > 0 ? 'start' : 'end', colAlim(a) || C.silk));
  });
  return out.join('');
}

/*
 * sim_bus.c — I2C, SPI e dispositivi collegati (fase 3, punto L, 25/11/2026)
 * Incluso da sim_hal.c (non si compila da solo): usa emit, consume_us, dev_now, pend_irq, deliver…
 *
 * HAL_I2C_* e HAL_SPI_* fanno davvero la trasmissione verso i dispositivi messi sulla breadboard:
 * indirizzo con ACK/NACK, tempo al baud configurato (I2C: 9 colpi di clock per byte; SPI: 8 o 16),
 * bus senza pull-up = linee basse (HAL_BUSY dopo 25 ms, come la HAL vera), _IT e _DMA con la
 * callback a fine trasferimento (passando dall'interrupt dell'NVIC o dallo stream DMA).
 *
 * Dispositivi (configurati dalla pagina con le righe "E …", vedi bus_cmd):
 *   L  LCD 16x2 HD44780 con modulo I2C PCF8574 (P0 RS, P1 RW, P2 EN, P3 retroilluminazione, P4–P7 D4–D7)
 *   O  OLED SSD1306 128x64 (I2C, oppure SPI 4 fili con CS e DC)
 *   T  sensore di temperatura LM75
 *   M  accelerometro/giroscopio MPU6050
 *   E  EEPROM 24C02 (256 byte, pagine da 8)      F  EEPROM 24LC256 (32 KB, pagine da 64, indirizzo a 2 byte)
 *   H  sensore a ultrasuoni HC-SR04 (GPIO: Trig ed Echo, l'eco arriva al µs)
 *
 * Verso la pagina:
 *   "O I bus t0_us bit_us scl sda pezzi…"   una transazione I2C per l'analizzatore (S, R, P, hhA, hhN)
 *   "O S bus t0_us bit_us sck mosi miso cpol cpha hex_mosi hex_miso"   un trasferimento SPI
 *   "F i L …" / "F i O …"   contenuto dei display; "F i w ind hex"  byte scritti in una EEPROM (si salvano nel progetto)
 *
 * Inoltre: contatori dei timer che avanzano anche dentro il millisecondo (CNT letto in un ciclo di attesa,
 * es. delay_us o la misura dell'eco) e input capture dei timer (HAL_TIM_IC_*).
 */

/* ------------------------------------------------------------------ */
/* Contatori dei timer al µs: ogni ms tim_step porta CNT al valore giusto; in mezzo al ms, a ogni      */
/* "spesa" di cicli (charge), CNT = valore a inizio ms + frazione del ms × conteggi per ms. Se il        */
/* programma scrive CNT (es. __HAL_TIM_SET_COUNTER) si riparte da lì.                                   */
typedef struct { int on; uint32_t base, scritto; double fb, tpm; } timfine_t;
static timfine_t tfine[NTIM];
static int tfine_any;

static int echo_any;
/* ogni quanti cicli aggiornare: un conteggio del timer più veloce (o 1 µs se un HC-SR04 sta misurando) */
static void fine_passo(void)
{
  double cpm = (double)cycles_per_ms(), passo = echo_any ? cpm / 1000.0 : 1e18;
  tfine_any = 0;
  for (int i = 0; i < NTIM; i++) if (tfine[i].on) { tfine_any = 1; if (cpm / tfine[i].tpm < passo) passo = cpm / tfine[i].tpm; }
  fine_step = passo < 1 ? 1 : (uint64_t)passo;
}

/* prima di tim_step: CNT torna al valore equivalente a inizio ms (tim_step aggiunge i conteggi del ms intero) */
static void tim_fine_pre(simtim_t *s)
{
  timfine_t *f = &tfine[s - tims];
  if (!f->on) return;
  TIM_TypeDef *t = s->t;
  uint64_t per = (uint64_t)tim_arr(s) + 1u;
  if (t->CNT != f->scritto) { f->base = t->CNT; f->fb = 1.0; }      /* scritto dal programma dopo l'ultimo aggiornamento */
  int64_t v = (int64_t)f->base - (int64_t)llround(f->fb * f->tpm);
  v %= (int64_t)per; if (v < 0) v += (int64_t)per;
  t->CNT = (uint32_t)v;
}
/* dopo tim_step: nuovo punto di partenza */
static void tim_fine_post(simtim_t *s)
{
  timfine_t *f = &tfine[s - tims];
  TIM_TypeDef *t = s->t;
  unsigned sms = t->SMCR & TIM_SMCR_SMS;
  f->tpm = tim_clk(s) / (double)((t->PSC & 0xFFFFu) + 1u) / 1000.0;
  f->on = (t->CR1 & TIM_CR1_CEN) && tim_clock_on(s) && !(sms >= 1u && sms <= 3u) && !(t->CR1 & (TIM_CR1_DIR | TIM_CR1_CMS))
          && f->tpm >= 2.0 && tim_arr(s) > 0;
  f->base = f->scritto = t->CNT; f->fb = 0;
  if (s == &tims[NTIM - 1]) fine_passo();           /* dopo l'ultimo timer del ms */
}

static void echo_fine(double t);
static int bus_h;
static int hexval(int c);
/* chiamata da charge() quando serve (timer veloci o un HC-SR04 in misura) */
static void bus_fine(void)
{
  double t = dev_now(), fr = t - (double)atomic_load(&sim_ms);
  if (tfine_any) {
    for (int i = 0; i < NTIM; i++) {
      timfine_t *f = &tfine[i];
      if (!f->on) continue;
      TIM_TypeDef *tt = tims[i].t;
      uint64_t per = (uint64_t)tim_arr(&tims[i]) + 1u;
      if (tt->CNT != f->scritto) { f->base = tt->CNT; f->fb = fr; }
      double d = (fr - f->fb) * f->tpm;
      uint64_t v = (uint64_t)f->base + (uint64_t)(d > 0 ? d : 0);
      if (v >= per) v %= per;
      tt->CNT = f->scritto = (uint32_t)v;
    }
  }
  if (echo_any) echo_fine(t);
}

#ifdef HAL_TIM_MODULE_ENABLED
/* ------------------------------------------------------------------ */
/* Input capture (HAL_TIM_IC_*): il fronte sul pin copia CNT in CCRx (al µs con i contatori qui sopra) */
__weak void HAL_TIM_IC_MspInit(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_IC_MspDeInit(TIM_HandleTypeDef *htim) { (void)htim; }
HAL_StatusTypeDef HAL_TIM_IC_Init(TIM_HandleTypeDef *h) { return tim_init(h, HAL_TIM_IC_MspInit); }
HAL_StatusTypeDef HAL_TIM_IC_ConfigChannel(TIM_HandleTypeDef *h, const TIM_IC_InitTypeDef *c, uint32_t Channel)
{
  TIM_TypeDef *t = h->Instance;
  int ch = (int)(Channel / 4u);
  if (ch > 3 || !c) return HAL_ERROR;
  volatile uint32_t *ccmr = ch < 2 ? &t->CCMR1 : &t->CCMR2;
  int sh = (ch & 1) * 8;
  uint32_t v = (c->ICSelection & 3u) | (c->ICPrescaler & 0xCu) | ((c->ICFilter & 0xFu) << 4);
  *ccmr = (*ccmr & ~(0xFFu << sh)) | (v << sh);
  t->CCER = (t->CCER & ~(0xAu << (4 * ch))) | ((c->ICPolarity & 0xAu) << (4 * ch));
  return HAL_OK;
}
static HAL_StatusTypeDef ic_start(TIM_HandleTypeDef *h, uint32_t Channel, int it, int on)
{
  TIM_TypeDef *t = h->Instance;
  int ch = (int)(Channel / 4u);
  if (ch > 3) return HAL_ERROR;
  if (on) {
    if (it) t->DIER |= TIM_DIER_CC1IE << ch;
    t->CCER |= TIM_CCER_CC1E << (4 * ch);
    t->CR1 |= TIM_CR1_CEN;
  } else {
    if (it) t->DIER &= ~(TIM_DIER_CC1IE << ch);
    t->CCER &= ~(TIM_CCER_CC1E << (4 * ch));
    tim_disable(t);
  }
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_IC_Start(TIM_HandleTypeDef *h, uint32_t c)    { return ic_start(h, c, 0, 1); }
HAL_StatusTypeDef HAL_TIM_IC_Stop(TIM_HandleTypeDef *h, uint32_t c)     { return ic_start(h, c, 0, 0); }
HAL_StatusTypeDef HAL_TIM_IC_Start_IT(TIM_HandleTypeDef *h, uint32_t c) { return ic_start(h, c, 1, 1); }
HAL_StatusTypeDef HAL_TIM_IC_Stop_IT(TIM_HandleTypeDef *h, uint32_t c)  { return ic_start(h, c, 1, 0); }
HAL_TIM_StateTypeDef HAL_TIM_IC_GetState(const TIM_HandleTypeDef *h) { return h->State; }
#endif

/* fronte su un pin d'ingresso a metà ms (eco dell'HC-SR04): IDR, EXTI e input capture subito */
static void pin_edge_now(int p, int pin, int v)
{
  GPIO_TypeDef *g = gp[p];
  if (!g || !port_clock_on(p)) return;
  uint32_t bit = 1u << pin, m = (g->MODER >> (2 * pin)) & 3u;
  if (m == 0u || m == 2u) { if (v) g->IDR |= bit; else g->IDR &= ~bit; }
  if (((lvl[p] >> pin) & 1) == v) return;
  if (v) lvl[p] |= (uint16_t)bit; else lvl[p] &= (uint16_t)~bit;
  if (m == 0u && (int)((SYSCFG->EXTICR[pin >> 2] >> ((pin & 3) * 4)) & 0xF) == p && (EXTI->IMR & bit)
      && ((v && (EXTI->RTSR & bit)) || (!v && (EXTI->FTSR & bit)))) { EXTI->PR |= bit; pend_irq(exti_irq(pin)); }
  if (m == 2u) {
    uint32_t af = (g->AFR[pin >> 3] >> ((pin & 7) * 4)) & 0xFu;
    for (size_t i = 0; i < sizeof tmap / sizeof tmap[0]; i++) {
      if (tmap[i][3] != p || tmap[i][4] != pin || tmap[i][2]) continue;
      simtim_t *s = &tims[tmap[i][0]];
      TIM_TypeDef *t = s->t;
      int ch = tmap[i][1];
      if (!t || (uint32_t)s->af != af || !(t->CR1 & TIM_CR1_CEN)) continue;
      uint32_t ccmr = ch < 2 ? t->CCMR1 : t->CCMR2, ccs = (ccmr >> ((ch & 1) * 8)) & 3u;
      if (ccs != 1u || !(t->CCER & (TIM_CCER_CC1E << (4 * ch)))) continue;
      uint32_t pol = (t->CCER >> (4 * ch)) & 0xAu;          /* 0 salita, 2 discesa, 0xA tutti e due */
      if (!(pol == 0xAu || (pol == 0u && v) || (pol == 2u && !v))) continue;
      tim_sanitize(s);
      if (t->SR & (TIM_SR_CC1IF << ch)) tim_setflag(s, TIM_SR_CC1OF << ch);
      (&t->CCR1)[ch] = t->CNT;
      tim_setflag(s, TIM_SR_CC1IF << ch);
      if (t->DIER & (TIM_DIER_CC1IE << ch)) pend_irq(s->irq_cc);
    }
  }
  deliver();
}

/* ------------------------------------------------------------------ */
/* Dispositivi                                                         */
#define NBUS 16
typedef struct {
  char type;
  int addr;                       /* 7 bit */
  int scl, sda, cs, dc, rst;      /* pin = porta·16 + n, -1 = non collegato (SPI: scl = SCK, sda = MOSI; HC-SR04: Trig, Echo) */
  int pull, ok;                   /* pull-up sul bus (dalla breadboard), alimentato bene */
  int sel, rd, nb;                /* transazione I2C in corso: selezionato, lettura, byte ricevuti */
  /* LCD (HD44780 + PCF8574) */
  uint8_t port, mode8, half, nib, ddram[128], cgram[64], ac, cg, id, sh, disp, cur, blink, lines, shift;
  double busy;
  /* OLED SSD1306 */
  uint8_t fb[1024], ctrl, co, dcm, cmd[8], ncmd, need, on, inv, contrast, amode, c0, c1, p0, p1, col, page, segremap, comrev, start, pump, allon;
  int dirty; double sent_t;
  /* registri (LM75, MPU6050) e memorie */
  uint8_t reg[128], ptr;
  uint8_t *mem; int msize, mpage, abytes; uint32_t ea; double wbusy; uint8_t wbuf[64]; int wn; uint32_t wstart;
  /* grandezze dalla pagina */
  double temp, dist, roll, pitch, groll, gpitch, tang;
  /* HC-SR04 */
  int trig_old; double trig_up, e_up, e_down; int e_lv;
} busdev_t;
static busdev_t bdev[NBUS];

static int pin_out_level(int pk)           /* livello che il micro mette su un pin in uscita, -1 se non è un'uscita */
{
  if (pk < 0) return -1;
  int p = pk >> 4, b = pk & 15;
  GPIO_TypeDef *g = gp[p];
  if (!g || !port_clock_on(p) || ((g->MODER >> (2 * b)) & 3u) != 1u) return -1;
  return (int)((g->ODR >> b) & 1u);
}

/* ---- LCD 16x2: HD44780 in modalità 4 bit dietro al PCF8574 ---- */
static void lcd_reset(busdev_t *d)
{
  memset(d->ddram, ' ', sizeof d->ddram);
  memset(d->cgram, 0, sizeof d->cgram);
  d->mode8 = 1; d->half = 0; d->ac = 0; d->cg = 0; d->id = 1; d->sh = 0; d->disp = 0; d->cur = 0; d->blink = 0; d->lines = 0; d->shift = 0;
  d->port = 0xFF; d->busy = 0; d->dirty = 1;
}
static void lcd_istr(busdev_t *d, uint8_t c, double t)
{
  if (t < d->busy) {
    WARN_ONCE(90, "LCD: comando 0x%02X arrivato mentre il display era ancora occupato (Clear/Home durano 1,52 ms): sul display vero va perso. Aspetta almeno 2 ms dopo 0x01 o 0x02.", c);
    return;
  }
  d->busy = t + 0.037;
  if (c & 0x80) { d->ac = c & 0x7F; d->cg = 0xFF; }
  else if (c & 0x40) { d->cg = c & 0x3F; }
  else if (c & 0x20) { d->mode8 = (c >> 4) & 1; d->lines = (c >> 3) & 1; d->half = 0; }
  else if (c & 0x10) { if (c & 0x08) d->shift = (uint8_t)((d->shift + ((c & 4) ? 39 : 1)) % 40); else d->ac = (uint8_t)((d->ac + ((c & 4) ? 1 : 127)) & 0x7F); }
  else if (c & 0x08) { d->disp = (c >> 2) & 1; d->cur = (c >> 1) & 1; d->blink = c & 1; }
  else if (c & 0x04) { d->id = (c >> 1) & 1; d->sh = c & 1; }
  else if (c & 0x02) { d->ac = 0; d->shift = 0; d->cg = 0xFF; d->busy = t + 1.52; }
  else if (c & 0x01) { memset(d->ddram, ' ', sizeof d->ddram); d->ac = 0; d->shift = 0; d->id = 1; d->cg = 0xFF; d->busy = t + 1.52; }
  d->dirty = 1;
}
static void lcd_data(busdev_t *d, uint8_t c, double t)
{
  if (t < d->busy) { WARN_ONCE(90, "LCD: carattere arrivato mentre il display era ancora occupato (Clear/Home durano 1,52 ms): sul display vero va perso."); return; }
  d->busy = t + 0.041;
  if (d->cg != 0xFF) { d->cgram[d->cg & 63] = c & 0x1F; d->cg = (uint8_t)((d->cg + 1) & 63); }
  else {
    d->ddram[d->ac & 0x7F] = c;
    d->ac = (uint8_t)((d->ac + (d->id ? 1 : 127)) & 0x7F);
    if (d->sh) d->shift = (uint8_t)((d->shift + (d->id ? 1 : 39)) % 40);
  }
  d->dirty = 1;
}
/* il PCF8574 riceve un byte: se EN passa da 1 a 0 l'HD44780 legge D4–D7 */
static void lcd_port(busdev_t *d, uint8_t v, double t)
{
  uint8_t old = d->port;
  d->port = v;
  if (((old ^ v) & 0x08)) d->dirty = 1;                 /* retroilluminazione */
  if (!((old & 0x04) && !(v & 0x04))) return;
  if (v & 0x02) return;                                  /* RW = 1: lettura (busy flag), niente da scrivere */
  uint8_t nib = old >> 4, rs = old & 1;
  if (d->mode8) { if (!rs) lcd_istr(d, (uint8_t)(nib << 4), t); return; }
  if (!d->half) { d->nib = nib; d->half = 1; return; }
  d->half = 0;
  uint8_t c = (uint8_t)((d->nib << 4) | nib);
  if (rs) lcd_data(d, c, t); else lcd_istr(d, c, t);
}

/* ---- OLED SSD1306 ---- */
static void oled_reset(busdev_t *d)
{
  memset(d->fb, 0, sizeof d->fb);
  d->ncmd = 0; d->need = 0; d->on = 0; d->inv = 0; d->contrast = 0x7F; d->amode = 2; d->c0 = 0; d->c1 = 127; d->p0 = 0; d->p1 = 7;
  d->col = 0; d->page = 0; d->segremap = 0; d->comrev = 0; d->start = 0; d->pump = 0; d->allon = 0; d->dirty = 1;
}
static int oled_args(uint8_t c)
{
  if (c == 0x81 || c == 0x20 || c == 0xA8 || c == 0xD3 || c == 0xD5 || c == 0xD9 || c == 0xDA || c == 0xDB || c == 0x8D || c == 0xA3) return 1;
  if (c == 0x21 || c == 0x22) return 2;
  if (c == 0x26 || c == 0x27) return 6;
  if (c == 0x29 || c == 0x2A) return 5;
  return 0;
}
static void oled_cmd(busdev_t *d, uint8_t c)
{
  if (d->ncmd < 8) d->cmd[d->ncmd++] = c;
  if (d->ncmd == 1) d->need = (uint8_t)oled_args(c);
  if (d->ncmd <= d->need) return;
  uint8_t *a = d->cmd;
  switch (a[0]) {
    case 0x81: d->contrast = a[1]; break;
    case 0x20: d->amode = a[1] & 3; break;
    case 0x21: d->c0 = a[1] & 127; d->c1 = a[2] & 127; d->col = d->c0; break;
    case 0x22: d->p0 = a[1] & 7; d->p1 = a[2] & 7; d->page = d->p0; break;
    case 0x8D: d->pump = (a[1] & 0x04) != 0; break;
    case 0xA4: case 0xA5: d->allon = a[0] & 1; break;
    case 0xA6: case 0xA7: d->inv = a[0] & 1; break;
    case 0xAE: case 0xAF: d->on = a[0] & 1; break;
    case 0xA0: case 0xA1: d->segremap = a[0] & 1; break;
    case 0xC0: case 0xC8: d->comrev = (a[0] & 8) != 0; break;
    default:
      if (a[0] >= 0xB0 && a[0] <= 0xB7) d->page = a[0] & 7;
      else if (a[0] <= 0x0F) d->col = (uint8_t)((d->col & 0xF0) | a[0]);
      else if (a[0] >= 0x10 && a[0] <= 0x1F) d->col = (uint8_t)(((a[0] & 0x0F) << 4) | (d->col & 0x0F));
      else if (a[0] >= 0x40 && a[0] <= 0x7F) d->start = a[0] & 63;
  }
  d->ncmd = 0;
  d->dirty = 1;
}
static void oled_data(busdev_t *d, uint8_t v)
{
  d->fb[(d->page & 7) * 128 + (d->col & 127)] = v;
  if (d->amode == 0) { if (d->col >= d->c1) { d->col = d->c0; d->page = d->page >= d->p1 ? d->p0 : d->page + 1; } else d->col++; }
  else if (d->amode == 1) { if (d->page >= d->p1) { d->page = d->p0; d->col = d->col >= d->c1 ? d->c0 : d->col + 1; } else d->page++; }
  else d->col = (uint8_t)((d->col + 1) & 127);
  d->dirty = 1;
}

/* ---- MPU6050: registri dati dalle inclinazioni ---- */
static void mpu_fill(busdev_t *d)
{
  uint8_t *r = d->reg;
  if (r[0x6B] & 0x40) return;                    /* in sleep (il valore all'accensione): i dati restano fermi */
  double rr = d->roll * M_PI / 180, pp = d->pitch * M_PI / 180;
  double ax = -sin(pp), ay = sin(rr) * cos(pp), az = cos(rr) * cos(pp);
  double as = 16384.0 / (1 << ((r[0x1C] >> 3) & 3)), gs = 131.0 / (1 << ((r[0x1B] >> 3) & 3));
  double tnow = dev_now(), age = tnow - d->tang;
  double gx = age < 100 ? d->groll : 0, gy = age < 100 ? d->gpitch : 0;
  double v[7] = {ax * as, ay * as, az * as, (25.0 - 36.53) * 340.0, gx * gs, gy * gs, 0};
  for (int i = 0; i < 7; i++) {
    double x = v[i] > 32767 ? 32767 : v[i] < -32768 ? -32768 : v[i];
    int16_t s = (int16_t)lround(x);
    r[0x3B + 2 * i] = (uint8_t)((uint16_t)s >> 8);
    r[0x3C + 2 * i] = (uint8_t)s;
  }
}

/* ---- LM75 ---- */
static void lm75_temp(busdev_t *d)
{
  int16_t v = (int16_t)lround(d->temp * 2.0) * 128;   /* 9 bit: 0,5 °C */
  d->reg[0] = (uint8_t)((uint16_t)v >> 8); d->reg[1] = (uint8_t)v;
}

static void bus_dev_reset(busdev_t *d)
{
  d->sel = 0; d->ptr = 0; d->wbusy = 0;
  if (d->type == 'L') lcd_reset(d);
  if (d->type == 'O') oled_reset(d);
  if (d->type == 'T') { memset(d->reg, 0, sizeof d->reg); d->reg[4] = 0x4B; d->reg[6] = 0x50; }   /* THYST 75 °C, TOS 80 °C */
  if (d->type == 'M') { memset(d->reg, 0, sizeof d->reg); d->reg[0x75] = 0x68; d->reg[0x6B] = 0x40; }
}

/* ---- I2C lato dispositivo: start (ACK?), byte scritto (ACK?), byte letto, stop ---- */
static int dv_start(busdev_t *d, int rd, double t)
{
  if (d->type == 'E' || d->type == 'F') {
    if (t < d->wbusy) return 0;                  /* sta scrivendo (5 ms): non risponde, come quella vera */
  }
  d->sel = 1; d->rd = rd; d->nb = 0; d->ctrl = 1;
  if (d->type == 'T' && rd) lm75_temp(d);
  if (d->type == 'M' && rd) mpu_fill(d);
  return 1;
}
static int dv_write(busdev_t *d, uint8_t v, double t)
{
  int n = d->nb++;
  switch (d->type) {
    case 'L': lcd_port(d, v, t); break;
    case 'O':                                    /* byte di controllo: Co (bit 7) e D/C# (bit 6) */
      if (d->ctrl) { d->co = (v >> 7) & 1; d->dcm = (v >> 6) & 1; d->ctrl = 0; break; }
      if (d->dcm) oled_data(d, v); else oled_cmd(d, v);
      if (d->co) d->ctrl = 1;                    /* Co = 1: dopo un byte arriva un altro byte di controllo */
      break;
    case 'T':
      if (n == 0) d->ptr = v & 3;
      else if (d->ptr == 1) d->reg[2] = v;
      else if (d->ptr >= 2) d->reg[d->ptr * 2 + (n - 1) % 2] = v;
      break;
    case 'M':
      if (n == 0) d->ptr = v & 0x7F;
      else {
        if (d->ptr == 0x6B && (v & 0x80)) { bus_dev_reset(d); break; }
        if (d->ptr != 0x75 && (d->ptr < 0x3B || d->ptr > 0x48)) d->reg[d->ptr] = v;
        d->ptr = (d->ptr + 1) & 0x7F;
      }
      break;
    case 'E': case 'F':
      if (n < d->abytes) { d->ea = n == 0 && d->abytes == 2 ? (uint32_t)v << 8 : (d->abytes == 2 ? (d->ea | v) : v); d->ea %= (uint32_t)d->msize; d->wn = 0; d->wstart = d->ea; }
      else {
        uint32_t pg = d->ea & ~(uint32_t)(d->mpage - 1);
        uint32_t a = pg + ((d->wstart - pg + (uint32_t)d->wn) % (uint32_t)d->mpage);
        if (d->wn >= d->mpage) WARN_ONCE(91, "EEPROM: hai scritto più byte di una pagina (%d): quelli in più ricominciano dall'inizio della pagina e sovrascrivono i primi, come sulla memoria vera.", d->mpage);
        d->mem[a] = v;
        d->wbuf[d->wn % 64] = v;
        d->wn++;
      }
      break;
  }
  return 1;
}
static uint8_t dv_read(busdev_t *d)
{
  d->nb++;
  switch (d->type) {
    case 'L': return d->port;
    case 'O': return (uint8_t)(d->on ? 0x00 : 0x40);
    case 'T': {
      int base = d->ptr == 1 ? 2 : d->ptr * 2;
      if (d->ptr == 1) return d->reg[2];
      uint8_t v = d->reg[base + (d->nb - 1) % 2];
      return v;
    }
    case 'M': { uint8_t v = d->reg[d->ptr]; d->ptr = (d->ptr + 1) & 0x7F; return v; }
    case 'E': case 'F': { uint8_t v = d->mem[d->ea]; d->ea = (d->ea + 1) % (uint32_t)d->msize; return v; }
  }
  return 0xFF;
}
static void dv_stop(busdev_t *d, double t)
{
  if (!d->sel) return;
  d->sel = 0;
  if ((d->type == 'E' || d->type == 'F') && !d->rd && d->nb > d->abytes && d->wn > 0) {
    d->wbusy = t + 5.0;                                    /* tWR = 5 ms */
    /* i byte scritti vanno alla pagina, che li salva nel progetto */
    int n = d->wn > d->mpage ? d->mpage : d->wn;
    uint32_t pg = d->wstart & ~(uint32_t)(d->mpage - 1);
    uint8_t tmp[64];
    uint32_t a0 = d->wn > d->mpage ? pg : d->wstart;
    for (int k = 0; k < n; k++) tmp[k] = d->mem[pg + ((a0 - pg + (uint32_t)k) % (uint32_t)d->mpage)];
    if (a0 + (uint32_t)n <= pg + (uint32_t)d->mpage) {
      char pre[32]; snprintf(pre, sizeof pre, "F %d w %u", (int)(d - bdev), (unsigned)a0);
      emit_hex(pre, tmp, (uint32_t)n);
    } else for (int k = 0; k < n; k++) {
      uint32_t a = pg + ((a0 - pg + (uint32_t)k) % (uint32_t)d->mpage);
      emit("F %d w %u %02x", (int)(d - bdev), (unsigned)a, d->mem[a]);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pin dei bus: [bus, ruolo, porta, pin, AF]  I2C ruolo 0 SCL, 1 SDA;  SPI ruolo 0 SCK, 1 MISO, 2 MOSI */
static const uint8_t i2cmap[][5] = {
  {0,0,1,6,4},{0,0,1,8,4},{0,1,1,7,4},{0,1,1,9,4},
  {1,0,1,10,4},{1,1,1,3,9},
  {2,0,0,8,4},{2,1,2,9,4},{2,1,1,4,9},
};
static const uint8_t spimap[][5] = {
  {0,0,0,5,5},{0,0,1,3,5},{0,1,0,6,5},{0,1,1,4,5},{0,2,0,7,5},{0,2,1,5,5},
  {1,0,1,10,5},{1,0,1,13,5},{1,1,1,14,5},{1,1,2,2,5},{1,2,1,15,5},{1,2,2,3,5},
  {2,0,1,3,6},{2,0,2,10,6},{2,1,1,4,6},{2,1,2,11,6},{2,2,1,5,6},{2,2,2,12,6},
};
static int bus_pin(const uint8_t (*map)[5], size_t n, int bus, int role)
{
  for (size_t i = 0; i < n; i++) {
    if (map[i][0] != bus || map[i][1] != role) continue;
    int p = map[i][2], pin = map[i][3];
    GPIO_TypeDef *g = gp[p];
    if (!g || !port_clock_on(p) || ((g->MODER >> (2 * pin)) & 3u) != 2u) continue;
    if (((g->AFR[pin >> 3] >> ((pin & 7) * 4)) & 0xFu) != map[i][4]) continue;
    return p * 16 + pin;
  }
  return -1;
}

/* ---- registro delle transazioni per l'analizzatore ("O …") ---- */
static char qb[2400];
static int qn, qbits;
static double qt0, qbit;
static int qbus, qscl, qsda;
static void q_flush(void)
{
  if (!qn) return;
  qb[qn] = 0;
  emit("O I %d %.3f %.4f %d %d%s", qbus, qt0, qbit, qscl, qsda, qb);
  qt0 += qbits * qbit; qn = 0; qbits = 0;
}
static void q_tok(const char *s, int bits)
{
  if (qn > (int)sizeof qb - 16) q_flush();
  qn += snprintf(qb + qn, sizeof qb - (size_t)qn, " %s", s);
  qbits += bits;
}

/* ------------------------------------------------------------------ */
/* I2C                                                                 */
#ifdef HAL_I2C_MODULE_ENABLED
typedef struct {
  I2C_TypeDef *i; int num, en_bit, irq_ev, irq_er;
  I2C_HandleTypeDef *h;
  int mode, kind, err; double done;     /* trasferimento _IT/_DMA in corso: fine al tempo done (ms) */
  int cplt;
} simi2c_t;
static simi2c_t i2cs[3];
static simi2c_t *i2c_of(I2C_TypeDef *i) { for (int k = 0; k < 3; k++) if (i2cs[k].i == i) return &i2cs[k]; return NULL; }

__weak void HAL_I2C_MspInit(I2C_HandleTypeDef *h) { (void)h; }
__weak void HAL_I2C_MspDeInit(I2C_HandleTypeDef *h) { (void)h; }
__weak void HAL_I2C_MasterTxCpltCallback(I2C_HandleTypeDef *h) { (void)h; }
__weak void HAL_I2C_MasterRxCpltCallback(I2C_HandleTypeDef *h) { (void)h; }
__weak void HAL_I2C_MemTxCpltCallback(I2C_HandleTypeDef *h) { (void)h; }
__weak void HAL_I2C_MemRxCpltCallback(I2C_HandleTypeDef *h) { (void)h; }
__weak void HAL_I2C_ErrorCallback(I2C_HandleTypeDef *h) { (void)h; }
__weak void HAL_I2C_AbortCpltCallback(I2C_HandleTypeDef *h) { (void)h; }

static int i2c_clock_on(simi2c_t *b) { return (RCC->APB1ENR >> b->en_bit) & 1u; }

HAL_StatusTypeDef HAL_I2C_Init(I2C_HandleTypeDef *h)
{
  if (!h) return HAL_ERROR;
  simi2c_t *b = i2c_of(h->Instance);
  if (!b) return HAL_ERROR;
  if (h->State == HAL_I2C_STATE_RESET) { h->Lock = HAL_UNLOCKED; HAL_I2C_MspInit(h); }
  if (!i2c_clock_on(b)) WARN_ONCE(92, "HAL_I2C_Init su I2C%d ma il suo clock non è abilitato (__HAL_RCC_I2C%d_CLK_ENABLE in HAL_I2C_MspInit): sulla scheda vera non trasmette.", b->num, b->num);
  if (h->Init.ClockSpeed == 0 || h->Init.ClockSpeed > 400000u) { h->State = HAL_I2C_STATE_RESET; return HAL_ERROR; }
  h->Instance->CR1 |= I2C_CR1_PE;
  h->ErrorCode = HAL_I2C_ERROR_NONE;
  h->State = HAL_I2C_STATE_READY;
  h->Mode = HAL_I2C_MODE_NONE;
  b->h = h;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_I2C_DeInit(I2C_HandleTypeDef *h)
{
  if (!h) return HAL_ERROR;
  h->State = HAL_I2C_STATE_BUSY;
  h->Instance->CR1 &= ~I2C_CR1_PE;
  HAL_I2C_MspDeInit(h);
  h->ErrorCode = HAL_I2C_ERROR_NONE;
  h->State = HAL_I2C_STATE_RESET;
  return HAL_OK;
}
HAL_I2C_StateTypeDef HAL_I2C_GetState(I2C_HandleTypeDef *h) { return h->State; }
HAL_I2C_ModeTypeDef HAL_I2C_GetMode(I2C_HandleTypeDef *h) { return h->Mode; }
uint32_t HAL_I2C_GetError(I2C_HandleTypeDef *h) { return h->ErrorCode; }

static busdev_t *i2c_find(int scl, int sda, int a7)
{
  busdev_t *f = NULL;
  for (int i = 0; i < NBUS; i++) {
    busdev_t *d = &bdev[i];
    if (!d->type || d->type == 'H' || d->cs >= 0 || d->scl != scl || d->sda != sda || d->addr != a7) continue;
    if (!d->ok) continue;
    if (f) { WARN_ONCE(93, "I2C: due dispositivi con lo stesso indirizzo 0x%02X sullo stesso bus: rispondono insieme e i dati si mescolano. Cambia l'indirizzo (A0–A2) di uno dei due.", a7); return f; }
    f = d;
  }
  return f;
}
static int i2c_pullup(int scl, int sda)
{
  for (int i = 0; i < NBUS; i++) if (bdev[i].type && bdev[i].type != 'H' && bdev[i].cs < 0 && bdev[i].scl == scl && bdev[i].sda == sda && bdev[i].pull) return 1;
  int ok = 1;
  for (int k = 0; k < 2; k++) {
    int pk = k ? sda : scl;
    if (((gp[pk >> 4]->PUPDR >> (2 * (pk & 15))) & 3u) != 1u) ok = 0;
  }
  if (ok) WARN_ONCE(94, "I2C: sul bus ci sono solo i pull-up interni del micro (~40 kΩ): qui funziona, ma sulla scheda vera a 100 kHz i fronti di salita sono troppo lenti. Metti due resistenze da 4,7 kΩ verso 3,3 V (molti moduli le hanno già).");
  return ok;
}

/* kind: 0 trasmetti, 1 ricevi, 2 scrivi in memoria, 3 leggi dalla memoria. Esito: 0 ok, 1 NACK, 2 bus bloccato */
static int i2c_run(simi2c_t *b, I2C_HandleTypeDef *h, uint16_t dev, int kind, uint16_t mem, int msz, uint8_t *p, uint16_t n, double *us)
{
  int scl = bus_pin(i2cmap, sizeof i2cmap / sizeof i2cmap[0], b->num - 1, 0), sda = bus_pin(i2cmap, sizeof i2cmap / sizeof i2cmap[0], b->num - 1, 1);
  if (scl < 0 || sda < 0) {
    WARN_ONCE(95, "I2C%d: SCL e SDA non sono configurati come funzione alternativa I2C (GPIO in AF4 open-drain, di solito in HAL_I2C_MspInit): il segnale non esce dai pin.", b->num);
    *us = 25000; return 2;
  }
  if (!i2c_pullup(scl, sda)) {
    WARN_ONCE(96, "I2C%d: sul bus non ci sono resistenze di pull-up (SDA e SCL verso 3,3 V, di solito 4,7 kΩ): le linee restano basse, la HAL vede il bus occupato e dopo 25 ms restituisce HAL_BUSY.", b->num);
    *us = 25000; return 2;
  }
  if (((gp[scl >> 4]->OTYPER >> (scl & 15)) & 1u) == 0u || ((gp[sda >> 4]->OTYPER >> (sda & 15)) & 1u) == 0u)
    WARN_ONCE(97, "I2C%d: i pin sono in push-pull: per l'I2C vanno open-drain (GPIO_MODE_AF_OD), se no il dispositivo che tira giù SDA fa un corto con il micro.", b->num);
  double bit = 1e6 / (double)(h->Init.ClockSpeed ? h->Init.ClockSpeed : 100000u);
  double t = dev_now();
  qbus = b->num; qscl = scl; qsda = sda;
  qt0 = t * 1000.0; qbit = bit; qn = 0; qbits = 0;
  int a7 = (dev >> 1) & 0x7F, res = 0;
  busdev_t *d = i2c_find(scl, sda, a7);
  char tk[8];
#define TB(v, ack) (snprintf(tk, sizeof tk, "%02x%c", (unsigned)(v) & 0xFFu, (ack) ? 'A' : 'N'), q_tok(tk, 9))
  q_tok("S", 1);
  int ack = d && dv_start(d, kind == 1, t);
  TB((a7 << 1) | (kind == 1), ack);
  if (!ack) res = 1;
  else if (kind == 1) {
    for (int k = 0; k < n; k++) { p[k] = dv_read(d); TB(p[k], k < n - 1); }
  } else {
    for (int k = 0; k < msz && res == 0; k++) { uint8_t v = (uint8_t)(msz == 2 && k == 0 ? mem >> 8 : mem); int a = dv_write(d, v, t); TB(v, a); if (!a) res = 1; }
    if (kind == 3 && res == 0) {
      q_tok("R", 1);
      int a = dv_start(d, 1, t);
      TB((a7 << 1) | 1, a);
      if (!a) res = 1;
      else for (int k = 0; k < n; k++) { p[k] = dv_read(d); TB(p[k], k < n - 1); }
    } else if (res == 0) {
      for (int k = 0; k < n; k++) {
        int a = dv_write(d, p[k], qt0 / 1000.0 + qbits * bit / 1000.0);   /* istante del byte (per l'LCD occupato) */
        TB(p[k], a);
        if (!a) { res = 1; break; }
      }
    }
  }
  q_tok("P", 1);
  q_flush();
  double tot = qt0 - t * 1000.0;                 /* µs della transazione (q_flush porta avanti qt0) */
  if (d) dv_stop(d, t + tot / 1000.0);
#undef TB
  *us = tot + 2.0;                       /* + il tempo della HAL tra un byte e l'altro, circa */
  (void)h;
  return res;
}

static void i2c_status(I2C_HandleTypeDef *h, int r)
{
  h->ErrorCode = r == 0 ? HAL_I2C_ERROR_NONE : r == 1 ? HAL_I2C_ERROR_AF : HAL_I2C_ERROR_TIMEOUT;
}
static HAL_StatusTypeDef i2c_block(I2C_HandleTypeDef *h, uint16_t dev, int kind, uint16_t mem, uint16_t msza, uint8_t *p, uint16_t n, uint32_t timeout)
{
  simi2c_t *b = h ? i2c_of(h->Instance) : NULL;
  if (!b || (n && !p)) return HAL_ERROR;
  if (h->State != HAL_I2C_STATE_READY) return HAL_BUSY;
  int msz = kind >= 2 ? (msza == I2C_MEMADD_SIZE_16BIT ? 2 : 1) : 0;
  h->State = kind == 1 || kind == 3 ? HAL_I2C_STATE_BUSY_RX : HAL_I2C_STATE_BUSY_TX;
  h->Mode = kind >= 2 ? HAL_I2C_MODE_MEM : HAL_I2C_MODE_MASTER;
  double us;
  int r = i2c_run(b, h, dev, kind, mem, msz, p, n, &us);
  if (r == 2 && timeout < 25) us = (double)timeout * 1000.0;
  consume_us(us);
  i2c_status(h, r);
  h->State = HAL_I2C_STATE_READY;
  h->Mode = HAL_I2C_MODE_NONE;
  return r == 0 ? HAL_OK : r == 1 ? HAL_ERROR : HAL_BUSY;
}
HAL_StatusTypeDef HAL_I2C_Master_Transmit(I2C_HandleTypeDef *h, uint16_t a, uint8_t *p, uint16_t n, uint32_t to) { return i2c_block(h, a, 0, 0, 0, p, n, to); }
HAL_StatusTypeDef HAL_I2C_Master_Receive(I2C_HandleTypeDef *h, uint16_t a, uint8_t *p, uint16_t n, uint32_t to)  { return i2c_block(h, a, 1, 0, 0, p, n, to); }
HAL_StatusTypeDef HAL_I2C_Mem_Write(I2C_HandleTypeDef *h, uint16_t a, uint16_t m, uint16_t ms, uint8_t *p, uint16_t n, uint32_t to) { return i2c_block(h, a, 2, m, ms, p, n, to); }
HAL_StatusTypeDef HAL_I2C_Mem_Read(I2C_HandleTypeDef *h, uint16_t a, uint16_t m, uint16_t ms, uint8_t *p, uint16_t n, uint32_t to)  { return i2c_block(h, a, 3, m, ms, p, n, to); }

HAL_StatusTypeDef HAL_I2C_IsDeviceReady(I2C_HandleTypeDef *h, uint16_t dev, uint32_t Trials, uint32_t Timeout)
{
  simi2c_t *b = h ? i2c_of(h->Instance) : NULL;
  if (!b) return HAL_ERROR;
  if (h->State != HAL_I2C_STATE_READY) return HAL_BUSY;
  h->State = HAL_I2C_STATE_BUSY;
  for (uint32_t k = 0; k < (Trials ? Trials : 1); k++) {
    double us;
    int r = i2c_run(b, h, dev, 0, 0, 0, NULL, 0, &us);
    if (r == 2 && Timeout < 25) us = (double)Timeout * 1000.0;
    consume_us(us);
    if (r == 0) { h->State = HAL_I2C_STATE_READY; h->ErrorCode = HAL_I2C_ERROR_NONE; return HAL_OK; }
    if (r == 2) { h->State = HAL_I2C_STATE_READY; h->ErrorCode = HAL_I2C_ERROR_TIMEOUT; return HAL_BUSY; }
  }
  h->State = HAL_I2C_STATE_READY;
  return HAL_ERROR;
}

static void i2c_done(void *arg)
{
  simi2c_t *b = arg;
  I2C_HandleTypeDef *h = b->h;
  if (!h) return;
  int kind = b->kind, err = b->err;
  h->State = HAL_I2C_STATE_READY;
  h->Mode = HAL_I2C_MODE_NONE;
  if (err) { HAL_I2C_ErrorCallback(h); return; }
  if (kind == 0) HAL_I2C_MasterTxCpltCallback(h);
  else if (kind == 1) HAL_I2C_MasterRxCpltCallback(h);
  else if (kind == 2) HAL_I2C_MemTxCpltCallback(h);
  else HAL_I2C_MemRxCpltCallback(h);
}
static HAL_StatusTypeDef i2c_async(I2C_HandleTypeDef *h, uint16_t dev, int kind, uint16_t mem, uint16_t msza, uint8_t *p, uint16_t n, int mode)
{
  simi2c_t *b = h ? i2c_of(h->Instance) : NULL;
  if (!b || !p || !n) return HAL_ERROR;
  if (h->State != HAL_I2C_STATE_READY) return HAL_BUSY;
  int msz = kind >= 2 ? (msza == I2C_MEMADD_SIZE_16BIT ? 2 : 1) : 0;
  double us;
  int r = i2c_run(b, h, dev, kind, mem, msz, p, n, &us);
  if (r == 2) { i2c_status(h, r); consume_us(us); return HAL_BUSY; }
  h->State = kind == 1 || kind == 3 ? HAL_I2C_STATE_BUSY_RX : HAL_I2C_STATE_BUSY_TX;
  h->Mode = kind >= 2 ? HAL_I2C_MODE_MEM : HAL_I2C_MODE_MASTER;
  h->pBuffPtr = p; h->XferSize = n; h->XferCount = 0;
  i2c_status(h, r);
  b->h = h; b->kind = kind; b->err = r; b->mode = mode; b->done = dev_now() + us / 1000.0;
  if (mode == 1 && !irq_enabled(b->irq_ev))
    WARN_ONCE(98, "I2C a interrupt (_IT) su I2C%d ma l'interrupt I2C%d_EV non è abilitato nell'NVIC: la callback non arriverà mai.", b->num, b->num);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_I2C_Master_Transmit_IT(I2C_HandleTypeDef *h, uint16_t a, uint8_t *p, uint16_t n)  { return i2c_async(h, a, 0, 0, 0, p, n, 1); }
HAL_StatusTypeDef HAL_I2C_Master_Receive_IT(I2C_HandleTypeDef *h, uint16_t a, uint8_t *p, uint16_t n)   { return i2c_async(h, a, 1, 0, 0, p, n, 1); }
HAL_StatusTypeDef HAL_I2C_Mem_Write_IT(I2C_HandleTypeDef *h, uint16_t a, uint16_t m, uint16_t ms, uint8_t *p, uint16_t n) { return i2c_async(h, a, 2, m, ms, p, n, 1); }
HAL_StatusTypeDef HAL_I2C_Mem_Read_IT(I2C_HandleTypeDef *h, uint16_t a, uint16_t m, uint16_t ms, uint8_t *p, uint16_t n)  { return i2c_async(h, a, 3, m, ms, p, n, 1); }
HAL_StatusTypeDef HAL_I2C_Master_Transmit_DMA(I2C_HandleTypeDef *h, uint16_t a, uint8_t *p, uint16_t n) { return i2c_async(h, a, 0, 0, 0, p, n, 2); }
HAL_StatusTypeDef HAL_I2C_Master_Receive_DMA(I2C_HandleTypeDef *h, uint16_t a, uint8_t *p, uint16_t n)  { return i2c_async(h, a, 1, 0, 0, p, n, 2); }
HAL_StatusTypeDef HAL_I2C_Mem_Write_DMA(I2C_HandleTypeDef *h, uint16_t a, uint16_t m, uint16_t ms, uint8_t *p, uint16_t n) { return i2c_async(h, a, 2, m, ms, p, n, 2); }
HAL_StatusTypeDef HAL_I2C_Mem_Read_DMA(I2C_HandleTypeDef *h, uint16_t a, uint16_t m, uint16_t ms, uint8_t *p, uint16_t n)  { return i2c_async(h, a, 3, m, ms, p, n, 2); }

void HAL_I2C_EV_IRQHandler(I2C_HandleTypeDef *h)
{
  simi2c_t *b = h ? i2c_of(h->Instance) : NULL;
  if (b && b->cplt == 1) { b->cplt = 0; i2c_done(b); }
}
void HAL_I2C_ER_IRQHandler(I2C_HandleTypeDef *h)
{
  simi2c_t *b = h ? i2c_of(h->Instance) : NULL;
  if (b && b->cplt == 2) { b->cplt = 0; i2c_done(b); }
}

static void i2c_step(void)
{
  double t = (double)atomic_load(&sim_ms);
  for (int k = 0; k < 3; k++) {
    simi2c_t *b = &i2cs[k];
    if (!b->mode || t < b->done) continue;
    int m = b->mode;
    b->mode = 0;
    if (m == 1 || b->err) { b->cplt = b->err ? 2 : 1; pend_irq(b->err ? b->irq_er : b->irq_ev); }
    else dma_complete(b->kind == 1 || b->kind == 3 ? b->h->hdmarx : b->h->hdmatx, i2c_done, b);
    deliver();
  }
}
static void i2c_init_all(void)
{
  i2cs[0] = (simi2c_t){.i = I2C1, .num = 1, .en_bit = 21, .irq_ev = I2C1_EV_IRQn, .irq_er = I2C1_ER_IRQn};
  i2cs[1] = (simi2c_t){.i = I2C2, .num = 2, .en_bit = 22, .irq_ev = I2C2_EV_IRQn, .irq_er = I2C2_ER_IRQn};
  i2cs[2] = (simi2c_t){.i = I2C3, .num = 3, .en_bit = 23, .irq_ev = I2C3_EV_IRQn, .irq_er = I2C3_ER_IRQn};
}
#else
static void i2c_step(void) {}
static void i2c_init_all(void) {}
#endif /* HAL_I2C_MODULE_ENABLED */

/* ------------------------------------------------------------------ */
/* SPI                                                                 */
#ifdef HAL_SPI_MODULE_ENABLED
typedef struct {
  SPI_TypeDef *i; int num, en_bit, apb2, irq;
  SPI_HandleTypeDef *h;
  int mode, kind; double done; int cplt;
} simspi_t;
static simspi_t spis[3];
static simspi_t *spi_of(SPI_TypeDef *i) { for (int k = 0; k < 3; k++) if (spis[k].i == i) return &spis[k]; return NULL; }

__weak void HAL_SPI_MspInit(SPI_HandleTypeDef *h) { (void)h; }
__weak void HAL_SPI_MspDeInit(SPI_HandleTypeDef *h) { (void)h; }
__weak void HAL_SPI_TxCpltCallback(SPI_HandleTypeDef *h) { (void)h; }
__weak void HAL_SPI_RxCpltCallback(SPI_HandleTypeDef *h) { (void)h; }
__weak void HAL_SPI_TxRxCpltCallback(SPI_HandleTypeDef *h) { (void)h; }
__weak void HAL_SPI_ErrorCallback(SPI_HandleTypeDef *h) { (void)h; }

static int spi_clock_on(simspi_t *b) { volatile uint32_t *enr = b->apb2 ? &RCC->APB2ENR : &RCC->APB1ENR; return (*enr >> b->en_bit) & 1u; }
HAL_StatusTypeDef HAL_SPI_Init(SPI_HandleTypeDef *h)
{
  if (!h) return HAL_ERROR;
  simspi_t *b = spi_of(h->Instance);
  if (!b) return HAL_ERROR;
  if (h->State == HAL_SPI_STATE_RESET) { h->Lock = HAL_UNLOCKED; HAL_SPI_MspInit(h); }
  if (!spi_clock_on(b)) WARN_ONCE(100, "HAL_SPI_Init su SPI%d ma il suo clock non è abilitato (__HAL_RCC_SPI%d_CLK_ENABLE in HAL_SPI_MspInit): sulla scheda vera non trasmette.", b->num, b->num);
  if (h->Init.Mode != SPI_MODE_MASTER) WARN_ONCE(101, "SPI%d in modo slave: il simulatore fa solo il master (il micro che genera il clock).", b->num);
  h->Instance->CR1 = (h->Init.Mode | h->Init.Direction | h->Init.DataSize | h->Init.CLKPolarity | h->Init.CLKPhase | h->Init.BaudRatePrescaler | h->Init.FirstBit) & 0xFFFFu;
  h->Instance->CR1 |= SPI_CR1_SPE;
  h->ErrorCode = HAL_SPI_ERROR_NONE;
  h->State = HAL_SPI_STATE_READY;
  b->h = h;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_SPI_DeInit(SPI_HandleTypeDef *h) { if (!h) return HAL_ERROR; h->Instance->CR1 = 0; HAL_SPI_MspDeInit(h); h->State = HAL_SPI_STATE_RESET; return HAL_OK; }
HAL_SPI_StateTypeDef HAL_SPI_GetState(const SPI_HandleTypeDef *h) { return h->State; }
uint32_t HAL_SPI_GetError(const SPI_HandleTypeDef *h) { return h->ErrorCode; }

static double spi_hz(simspi_t *b, SPI_HandleTypeDef *h)
{
  double pclk = b->apb2 ? clk_pclk2() : clk_pclk1();
  return pclk / (double)(2u << ((h->Init.BaudRatePrescaler >> 3) & 7u));
}
/* un trasferimento: i byte vanno a tutti i dispositivi SPI con CS basso; MISO: nessuno risponde → 0xFF */
static double spi_run(simspi_t *b, SPI_HandleTypeDef *h, const uint8_t *tx, uint8_t *rx, uint16_t n)
{
  int sck = bus_pin(spimap, sizeof spimap / sizeof spimap[0], b->num - 1, 0), miso = bus_pin(spimap, sizeof spimap / sizeof spimap[0], b->num - 1, 1), mosi = bus_pin(spimap, sizeof spimap / sizeof spimap[0], b->num - 1, 2);
  int w16 = h->Init.DataSize == SPI_DATASIZE_16BIT, nb = n * (w16 ? 2 : 1);
  double hz = spi_hz(b, h), bit = 1e6 / hz;
  if (sck < 0 || (tx && mosi < 0)) WARN_ONCE(102, "SPI%d: SCK/MOSI non sono configurati come funzione alternativa SPI (GPIO in AF%d, di solito in HAL_SPI_MspInit): il segnale non esce dai pin.", b->num, b->num == 3 ? 6 : 5);
  for (int i = 0; i < NBUS; i++) {
    busdev_t *d = &bdev[i];
    if (d->type != 'O' || d->cs < -1 || d->scl != sck || d->sda != mosi || !d->ok || !tx || sck < 0) continue;
    if (d->cs >= 0 && pin_out_level(d->cs) != 0) continue;              /* CS alto: non selezionato */
    if (d->rst >= 0 && pin_out_level(d->rst) == 0) continue;            /* tenuto in reset */
    if (hz > 10.5e6) WARN_ONCE(103, "SPI%d a %.1f MHz: l'SSD1306 regge al massimo 10 MHz, sul display vero i dati arriverebbero sbagliati. Aumenta il prescaler.", b->num, hz / 1e6);
    int dc = d->dc >= 0 ? pin_out_level(d->dc) : 0;
    for (int k = 0; k < nb; k++) { if (dc) oled_data(d, tx[k]); else { oled_cmd(d, tx[k]); } }
  }
  if (rx) memset(rx, 0xFF, (size_t)nb);
  if (sck >= 0) {
    char hx[2][1100];
    static const char H[] = "0123456789abcdef";
    double t0 = dev_now() * 1000.0;
    for (int off = 0; off < nb; off += 500) {
      int k = nb - off > 500 ? 500 : nb - off;
      for (int s = 0; s < 2; s++) {
        const uint8_t *src = s ? (rx ? rx + off : NULL) : (tx ? tx + off : NULL);
        if (!src) { strcpy(hx[s], "-"); continue; }
        for (int j = 0; j < k; j++) { hx[s][2 * j] = H[src[j] >> 4]; hx[s][2 * j + 1] = H[src[j] & 15]; }
        hx[s][2 * k] = 0;
      }
      emit("O S %d %.3f %.4f %d %d %d %d %d %s %s", b->num, t0 + off * 8 * bit, bit, sck, mosi, miso,
           (h->Init.CLKPolarity == SPI_POLARITY_HIGH), (h->Init.CLKPhase == SPI_PHASE_2EDGE), hx[0], hx[1]);
    }
  }
  return nb * 8 * bit + 1.0;
}
static HAL_StatusTypeDef spi_block(SPI_HandleTypeDef *h, const uint8_t *tx, uint8_t *rx, uint16_t n, int kind)
{
  simspi_t *b = h ? spi_of(h->Instance) : NULL;
  if (!b || !n) return HAL_ERROR;
  if (h->State != HAL_SPI_STATE_READY) return HAL_BUSY;
  h->State = kind == 0 ? HAL_SPI_STATE_BUSY_TX : kind == 1 ? HAL_SPI_STATE_BUSY_RX : HAL_SPI_STATE_BUSY_TX_RX;
  consume_us(spi_run(b, h, tx, rx, n));
  h->State = HAL_SPI_STATE_READY;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_SPI_Transmit(SPI_HandleTypeDef *h, const uint8_t *p, uint16_t n, uint32_t to) { (void)to; return spi_block(h, p, NULL, n, 0); }
HAL_StatusTypeDef HAL_SPI_Receive(SPI_HandleTypeDef *h, uint8_t *p, uint16_t n, uint32_t to) { (void)to; return spi_block(h, NULL, p, n, 1); }
HAL_StatusTypeDef HAL_SPI_TransmitReceive(SPI_HandleTypeDef *h, const uint8_t *tx, uint8_t *rx, uint16_t n, uint32_t to) { (void)to; return spi_block(h, tx, rx, n, 2); }

static void spi_done(void *arg)
{
  simspi_t *b = arg;
  if (!b->h) return;
  b->h->State = HAL_SPI_STATE_READY;
  if (b->kind == 0) HAL_SPI_TxCpltCallback(b->h);
  else if (b->kind == 1) HAL_SPI_RxCpltCallback(b->h);
  else HAL_SPI_TxRxCpltCallback(b->h);
}
static HAL_StatusTypeDef spi_async(SPI_HandleTypeDef *h, const uint8_t *tx, uint8_t *rx, uint16_t n, int kind, int mode)
{
  simspi_t *b = h ? spi_of(h->Instance) : NULL;
  if (!b || !n) return HAL_ERROR;
  if (h->State != HAL_SPI_STATE_READY) return HAL_BUSY;
  h->State = kind == 0 ? HAL_SPI_STATE_BUSY_TX : kind == 1 ? HAL_SPI_STATE_BUSY_RX : HAL_SPI_STATE_BUSY_TX_RX;
  double us = spi_run(b, h, tx, rx, n);
  b->h = h; b->kind = kind; b->mode = mode; b->done = dev_now() + us / 1000.0;
  if (mode == 1 && !irq_enabled(b->irq))
    WARN_ONCE(104, "SPI a interrupt (_IT) su SPI%d ma l'interrupt SPI%d non è abilitato nell'NVIC: la callback non arriverà mai.", b->num, b->num);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_SPI_Transmit_IT(SPI_HandleTypeDef *h, const uint8_t *p, uint16_t n) { return spi_async(h, p, NULL, n, 0, 1); }
HAL_StatusTypeDef HAL_SPI_Receive_IT(SPI_HandleTypeDef *h, uint8_t *p, uint16_t n) { return spi_async(h, NULL, p, n, 1, 1); }
HAL_StatusTypeDef HAL_SPI_TransmitReceive_IT(SPI_HandleTypeDef *h, const uint8_t *tx, uint8_t *rx, uint16_t n) { return spi_async(h, tx, rx, n, 2, 1); }
HAL_StatusTypeDef HAL_SPI_Transmit_DMA(SPI_HandleTypeDef *h, const uint8_t *p, uint16_t n) { return spi_async(h, p, NULL, n, 0, 2); }
HAL_StatusTypeDef HAL_SPI_Receive_DMA(SPI_HandleTypeDef *h, uint8_t *p, uint16_t n) { return spi_async(h, NULL, p, n, 1, 2); }
HAL_StatusTypeDef HAL_SPI_TransmitReceive_DMA(SPI_HandleTypeDef *h, const uint8_t *tx, uint8_t *rx, uint16_t n) { return spi_async(h, tx, rx, n, 2, 2); }
void HAL_SPI_IRQHandler(SPI_HandleTypeDef *h)
{
  simspi_t *b = h ? spi_of(h->Instance) : NULL;
  if (b && b->cplt) { b->cplt = 0; spi_done(b); }
}
static void spi_step(void)
{
  double t = (double)atomic_load(&sim_ms);
  for (int k = 0; k < 3; k++) {
    simspi_t *b = &spis[k];
    if (!b->mode || t < b->done) continue;
    int m = b->mode;
    b->mode = 0;
    if (m == 1) { b->cplt = 1; pend_irq(b->irq); }
    else dma_complete(b->kind == 1 ? b->h->hdmarx : b->h->hdmatx, spi_done, b);
    deliver();
  }
}
static void spi_init_all(void)
{
  spis[0] = (simspi_t){.i = SPI1, .num = 1, .en_bit = 12, .apb2 = 1, .irq = SPI1_IRQn};
  spis[1] = (simspi_t){.i = SPI2, .num = 2, .en_bit = 14, .apb2 = 0, .irq = SPI2_IRQn};
  spis[2] = (simspi_t){.i = SPI3, .num = 3, .en_bit = 15, .apb2 = 0, .irq = SPI3_IRQn};
}
#else
static void spi_step(void) {}
static void spi_init_all(void) {}
#endif /* HAL_SPI_MODULE_ENABLED */

/* ------------------------------------------------------------------ */
/* HC-SR04: Trig dal micro, Echo verso il micro (al µs)                 */
static uint16_t bus_in_mask[8];

static void echo_update_any(void) { echo_any = 0; for (int i = 0; i < NBUS; i++) if (bdev[i].type == 'H' && bdev[i].e_down > 0) echo_any = 1; fine_passo(); }
static void echo_fine(double t)
{
  for (int i = 0; i < NBUS; i++) {
    busdev_t *d = &bdev[i];
    if (d->type != 'H' || d->sda < 0) continue;
    int v = d->e_down > 0 && t >= d->e_up && t < d->e_down;
    if (v != d->e_lv) {
      d->e_lv = v;
      double te = v ? d->e_up : d->e_down;
      emit("O H %.3f %d %d", te * 1000.0, d->sda, v);
      pin_edge_now(d->sda >> 4, d->sda & 15, v);
    }
    if (!v && d->e_down > 0 && t >= d->e_down) { d->e_down = 0; echo_update_any(); }
  }
}
/* scrittura sui pin (HAL_GPIO_WritePin, o a fine ms per ODR/BSRR scritti a mano) */
static void bus_gpio(void)
{
  for (int i = 0; i < NBUS; i++) {
    busdev_t *d = &bdev[i];
    if (d->type != 'H' || d->scl < 0) continue;
    int v = pin_out_level(d->scl);
    if (v < 0) v = 0;
    if (v == d->trig_old) continue;
    double t = dev_now();
    d->trig_old = v;
    if (v) { d->trig_up = t; continue; }
    if (!d->ok) continue;
    if (t - d->trig_up < 0.010) { WARN_ONCE(105, "HC-SR04: l'impulso su Trig è durato %.1f µs, ne servono almeno 10: il sensore non parte.", (t - d->trig_up) * 1000.0); continue; }
    if (d->e_down > 0) continue;                            /* misura già in corso: ignora */
    double mm = d->dist < 20 ? 20 : d->dist;
    d->e_up = t + 0.46;                                     /* 8 impulsi a 40 kHz, poi Echo sale */
    d->e_down = d->e_up + (mm > 4000 ? 38.0 : 2.0 * mm / 343.0);   /* andata e ritorno a 343 m/s; fuori portata: 38 ms */
    echo_update_any();
  }
}
static int bus_in(int p, int pin)
{
  for (int i = 0; i < NBUS; i++) if (bdev[i].type == 'H' && bdev[i].sda == p * 16 + pin) return bdev[i].e_lv;
  return -1;
}

/* ------------------------------------------------------------------ */
/* Ogni ms: completamenti, display verso la pagina                       */
static void bus_step(void)
{
  i2c_step();
  spi_step();
  bus_gpio();
  if (echo_any) echo_fine((double)atomic_load(&sim_ms));
  double now = (double)atomic_load(&sim_ms);
  for (int i = 0; i < NBUS; i++) {
    busdev_t *d = &bdev[i];
    if (!d->dirty || now - d->sent_t < 33) continue;     /* al massimo ~30 volte al secondo */
    d->dirty = 0; d->sent_t = now;
    if (d->type == 'L') {
      char a[300], c[140];
      static const char H[] = "0123456789abcdef";
      for (int k = 0; k < 128; k++) { a[2 * k] = H[d->ddram[k] >> 4]; a[2 * k + 1] = H[d->ddram[k] & 15]; } a[256] = 0;
      for (int k = 0; k < 64; k++) { c[2 * k] = H[d->cgram[k] >> 4]; c[2 * k + 1] = H[d->cgram[k] & 15]; } c[128] = 0;
      emit("F %d L %d %d %d %d %d %d %d %s %s", i, d->disp, d->cur, d->blink, (d->port >> 3) & 1, d->shift, d->ac, d->lines, a, c);
    } else if (d->type == 'O') {
      char pre[96];
      snprintf(pre, sizeof pre, "F %d O %d %d %d %d %d %d %d %d", i, d->on, d->inv, d->contrast, d->segremap, d->comrev, d->start, d->pump, d->allon);
      emit_hex(pre, d->fb, 500); emit_hex("F+", d->fb + 500, 524);
    }
  }
}

/* righe "E …" dalla pagina:
 *   E -                                         toglie tutti i dispositivi
 *   E i tipo addr scl sda cs dc rst pull ok     dispositivo i (pin = porta·16+n o -1)
 *   E i v t|d|a valore [valore]                 temperatura (°C), distanza (mm), inclinazione (roll pitch, gradi)
 *   E i m ind hex                               contenuto iniziale di una EEPROM */
static void bus_cmd(char *line)
{
  char *p = line + 1;
  while (*p == ' ') p++;
  if (*p == '-') {
    for (int i = 0; i < NBUS; i++) free(bdev[i].mem);
    memset(bdev, 0, sizeof bdev);
    memset(bus_in_mask, 0, sizeof bus_in_mask);
    echo_any = 0; bus_h = 0;
    return;
  }
  char *e;
  long i = strtol(p, &e, 10);
  if (e == p || i < 0 || i >= NBUS) return;
  p = e; while (*p == ' ') p++;
  busdev_t *d = &bdev[i];
  if (*p == 'v') {
    char k = p[2];
    double a = 0, b = 0;
    sscanf(p + 3, "%lf %lf", &a, &b);
    if (k == 't') d->temp = a;
    else if (k == 'd') d->dist = a;
    else if (k == 'a') {
      double t = dev_now(), dt = t - d->tang;
      if (dt < 20) dt = 20;
      d->groll = (a - d->roll) / dt * 1000.0; d->gpitch = (b - d->pitch) / dt * 1000.0;
      d->roll = a; d->pitch = b; d->tang = t;
    }
    return;
  }
  if (*p == 'm') {
    char *q = p + 1;
    long a = strtol(q, &q, 10);
    while (*q == ' ') q++;
    if (!d->mem) return;
    while (hexval(q[0]) >= 0 && hexval(q[1]) >= 0 && a >= 0 && a < d->msize) { d->mem[a++] = (uint8_t)(hexval(q[0]) * 16 + hexval(q[1])); q += 2; }
    return;
  }
  char ty = *p++;
  long v[8];
  for (int k = 0; k < 8; k++) v[k] = strtol(p, &p, 10);
  uint8_t *mem = d->mem;
  double temp = d->temp, dist = d->dist;
  memset(d, 0, sizeof *d);
  d->temp = temp; d->dist = dist;
  if (!strchr("LOTMEFH", ty)) { free(mem); return; }
  d->type = ty; d->addr = (int)(v[0] & 0x7F);
  int *pins[5] = {&d->scl, &d->sda, &d->cs, &d->dc, &d->rst};
  for (int k = 0; k < 5; k++) *pins[k] = v[1 + k] >= 0 && v[1 + k] < 128 ? (int)v[1 + k] : -1;
  d->pull = v[6] != 0; d->ok = v[7] != 0;
  if (ty == 'E' || ty == 'F') {
    d->msize = ty == 'E' ? 256 : 32768; d->mpage = ty == 'E' ? 8 : 64; d->abytes = ty == 'E' ? 1 : 2;
    d->mem = mem ? realloc(mem, (size_t)d->msize) : malloc((size_t)d->msize);
    if (!mem && d->mem) memset(d->mem, 0xFF, (size_t)d->msize);
    mem = NULL;
  }
  free(mem);
  bus_dev_reset(d);
  memset(bus_in_mask, 0, sizeof bus_in_mask);
  bus_h = 0;
  for (int k = 0; k < NBUS; k++) bus_h |= bdev[k].type == 'H';
  for (int k = 0; k < NBUS; k++) if (bdev[k].type == 'H' && bdev[k].sda >= 0) bus_in_mask[bdev[k].sda >> 4] |= (uint16_t)(1u << (bdev[k].sda & 15));
  d->trig_old = pin_out_level(d->scl) > 0;
}

static void bus_init(void) { i2c_init_all(); spi_init_all(); }

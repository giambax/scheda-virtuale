/*
 * sim_hal.c — Scheda Virtuale STM32F4 (NUCLEO-F401RE), versione per il browser
 *
 * Il codice del progetto CubeIDE viene compilato in WebAssembly (nella pagina,
 * con clang) insieme a questo file, che sostituisce la libreria HAL. I registri
 * delle periferiche sono veri (strutture CMSIS in una zona fissa della memoria
 * lineare), il loro comportamento è simulato millisecondo per millisecondo.
 *
 * Un solo thread (un Web Worker): il WebAssembly non può sospendere un thread
 * a metà istruzione. Ogni giro di while/for, HAL_Delay e HAL_GetTick
 * "spendono" cicli; quando è passato 1 ms simulato si esegue sim_step() lì,
 * cioè periferiche e interrupt partono nei punti in cui il programma consuma
 * tempo (interrupt "cooperativi": stessa sequenza della scheda, ma un
 * interrupt non può arrivare a metà di un'istruzione C senza cicli).
 * Comunicazione con la pagina (funzioni importate da "sv", vedi sim-worker.js):
 *   sv_out  → righe di eventi (stesso protocollo della versione per Mac)
 *   sv_in   → righe di comandi dalla pagina (SharedArrayBuffer)
 *   sv_sleep→ attesa precisa (Atomics.wait) per andare a tempo reale
 */
/* Apple clang predefinisce __weak (Objective-C): qui serve quello della HAL */
#undef __weak
#define __weak __attribute__((weak))
/* Queste funzioni hanno firme diverse (const o no) a seconda della versione
 * della HAL: le rinomino mentre includo l'header e le definisco qui sotto. */
#define HAL_RCC_OscConfig HAL_RCC_OscConfig__hdr
#define HAL_RCC_ClockConfig HAL_RCC_ClockConfig__hdr
#define HAL_GPIO_Init HAL_GPIO_Init__hdr
#define HAL_GPIO_ReadPin HAL_GPIO_ReadPin__hdr
#define HAL_TIM_PWM_ConfigChannel HAL_TIM_PWM_ConfigChannel__hdr
#define HAL_TIM_OC_ConfigChannel HAL_TIM_OC_ConfigChannel__hdr
#define HAL_TIM_ConfigClockSource HAL_TIM_ConfigClockSource__hdr
#define HAL_TIMEx_MasterConfigSynchronization HAL_TIMEx_MasterConfigSynchronization__hdr
#define HAL_TIMEx_ConfigBreakDeadTime HAL_TIMEx_ConfigBreakDeadTime__hdr
#define HAL_TIM_ReadCapturedValue HAL_TIM_ReadCapturedValue__hdr
#define HAL_TIM_Base_GetState HAL_TIM_Base_GetState__hdr
#define HAL_TIM_PWM_GetState HAL_TIM_PWM_GetState__hdr
#define HAL_TIM_Encoder_Init HAL_TIM_Encoder_Init__hdr
#define HAL_UART_Transmit HAL_UART_Transmit__hdr
#define HAL_UART_Transmit_IT HAL_UART_Transmit_IT__hdr
#define HAL_UART_Transmit_DMA HAL_UART_Transmit_DMA__hdr
#define HAL_UART_GetState HAL_UART_GetState__hdr
#define HAL_UART_GetError HAL_UART_GetError__hdr
#define HAL_ADC_ConfigChannel HAL_ADC_ConfigChannel__hdr
#define HAL_ADC_GetValue HAL_ADC_GetValue__hdr
#include "stm32f4xx_hal.h"
#undef HAL_RCC_OscConfig
#undef HAL_RCC_ClockConfig
#undef HAL_GPIO_Init
#undef HAL_GPIO_ReadPin
#undef HAL_TIM_PWM_ConfigChannel
#undef HAL_TIM_OC_ConfigChannel
#undef HAL_TIM_ConfigClockSource
#undef HAL_TIMEx_MasterConfigSynchronization
#undef HAL_TIMEx_ConfigBreakDeadTime
#undef HAL_TIM_ReadCapturedValue
#undef HAL_TIM_Base_GetState
#undef HAL_TIM_PWM_GetState
#undef HAL_TIM_Encoder_Init
#undef HAL_UART_Transmit
#undef HAL_UART_Transmit_IT
#undef HAL_UART_Transmit_DMA
#undef HAL_UART_GetState
#undef HAL_UART_GetError
#undef HAL_ADC_ConfigChannel
#undef HAL_ADC_GetValue
#include <stdio.h>
#include <stddef.h>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <math.h>
#include <time.h>
#include <stdatomic.h>

/* un solo thread: niente mutex né variabili per thread */
#define __thread
#define pthread_mutex_t int
#define PTHREAD_MUTEX_INITIALIZER 0
#define pthread_mutex_lock(m) ((void)0)
#define pthread_mutex_unlock(m) ((void)0)

/* funzioni della pagina (sim-worker.js) */
#define SV_IMPORT(n) __attribute__((import_module("sv"), import_name(n)))
SV_IMPORT("out")   void sv_out(const char *p, uint32_t n);
SV_IMPORT("in")    uint32_t sv_in(char *p, uint32_t max);
SV_IMPORT("sleep") void sv_sleep(double ms);
SV_IMPORT("now")   double sv_now(void);
#define LOOP_CYC  12u          /* cicli "spesi" da ogni giro di while/for */
#ifndef GPIO_CYC
#define GPIO_CYC  12u          /* cicli di una chiamata HAL_GPIO_Read/Write/TogglePin (sulla scheda, a -O0, ~20) */
#endif

int user_main(void);

/* ------------------------------------------------------------------ */
/* Variabili che nella HAL vera stanno in stm32f4xx_hal.c / system_*.c */
__IO uint32_t uwTick;
uint32_t uwTickPrio = (1UL << __NVIC_PRIO_BITS);
HAL_TickFreqTypeDef uwTickFreq = HAL_TICK_FREQ_DEFAULT;
uint32_t SystemCoreClock = 16000000U;
const uint8_t AHBPrescTable[16] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 6, 7, 8, 9};
const uint8_t APBPrescTable[8]  = {0, 0, 0, 0, 1, 2, 3, 4};

/* ------------------------------------------------------------------ */
/* Stato del simulatore                                                */
static _Atomic uint64_t sim_ms;
static volatile double speed = 1.0;
static volatile int paused = 0;
static __thread int t_is_tick = 0;
static volatile int cpu_alive = 0;
static int step_depth = 0;
static volatile int primask = 0;
static int cur_preempt = 256;           /* soglia di preemption corrente */
static uint64_t main_mark_ms, main_cyc, isr_cyc;

/* ------------------------------------------------------------------ */
/* Uscita verso la pagina                                              */
/* (un buffer lineare, svuotato verso la pagina a ogni ms)             */
#define OUT_SZ (1u << 18)
static char out_buf[OUT_SZ];
static uint32_t out_n;
static void out_flush(void) { if (out_n) { sv_out(out_buf, out_n); out_n = 0; } }
static void out_put(const char *s, uint32_t n)
{
  if (out_n + n > OUT_SZ) out_flush();
  if (n > OUT_SZ) return;
  memcpy(out_buf + out_n, s, n);
  out_n += n;
}

static void emit_hex(const char *prefix, const uint8_t *p, uint32_t n);

/* i byte trasmessi vengono raccolti e spediti a blocchi (non uno per riga) */
typedef struct { char prefix[8]; uint8_t d[480]; uint32_t n; } txbuf_t;
static __thread txbuf_t txb;
static void tx_flush(void)
{
  if (txb.n) { uint32_t n = txb.n; txb.n = 0; emit_hex(txb.prefix, txb.d, n); }
}
static void tx_add(const char *prefix, const uint8_t *p, uint32_t n)
{
  if (txb.n && strcmp(txb.prefix, prefix) != 0) tx_flush();
  snprintf(txb.prefix, sizeof txb.prefix, "%s", prefix);
  for (uint32_t i = 0; i < n; i++) { txb.d[txb.n++] = p[i]; if (txb.n == sizeof txb.d) tx_flush(); }
}

static void emit(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void emit(const char *fmt, ...)
{
  tx_flush();
  char b[4200];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(b, sizeof b - 2, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if (n > (int)sizeof b - 2) n = sizeof b - 2;
  b[n++] = '\n';
  out_put(b, (uint32_t)n);
}

static void emit_hex(const char *prefix, const uint8_t *p, uint32_t n)
{
  static const char hx[] = "0123456789abcdef";
  char b[1100];
  while (n) {
    uint32_t k = n > 500 ? 500 : n;
    int o = snprintf(b, 32, "%s ", prefix);
    for (uint32_t i = 0; i < k; i++) { b[o++] = hx[p[i] >> 4]; b[o++] = hx[p[i] & 15]; }
    b[o++] = '\n';
    out_put(b, (uint32_t)o);
    p += k; n -= k;
  }
}

static uint8_t warned[128];
#define WARN_ONCE(id, ...) do { if (!warned[id]) { warned[id] = 1; emit("X " __VA_ARGS__); } } while (0)

void __sim_stub(const char *name)
{
  static const char *seen[64];
  for (int i = 0; i < 64; i++) {
    if (seen[i] == name) return;
    if (!seen[i]) { seen[i] = name; emit("S %s", name); return; }
  }
}

/* ------------------------------------------------------------------ */
/* Interrupt                                                           */
#define IRQ_LIST(X) \
  X(SysTick_IRQn, SysTick_Handler, "SysTick") \
  X(EXTI0_IRQn, EXTI0_IRQHandler, "EXTI0") \
  X(EXTI1_IRQn, EXTI1_IRQHandler, "EXTI1") \
  X(EXTI2_IRQn, EXTI2_IRQHandler, "EXTI2") \
  X(EXTI3_IRQn, EXTI3_IRQHandler, "EXTI3") \
  X(EXTI4_IRQn, EXTI4_IRQHandler, "EXTI4") \
  X(EXTI9_5_IRQn, EXTI9_5_IRQHandler, "EXTI9_5") \
  X(EXTI15_10_IRQn, EXTI15_10_IRQHandler, "EXTI15_10") \
  X(TIM1_BRK_TIM9_IRQn, TIM1_BRK_TIM9_IRQHandler, "TIM1_BRK_TIM9") \
  X(TIM1_UP_TIM10_IRQn, TIM1_UP_TIM10_IRQHandler, "TIM1_UP_TIM10") \
  X(TIM1_TRG_COM_TIM11_IRQn, TIM1_TRG_COM_TIM11_IRQHandler, "TIM1_TRG_COM_TIM11") \
  X(TIM1_CC_IRQn, TIM1_CC_IRQHandler, "TIM1_CC") \
  X(TIM2_IRQn, TIM2_IRQHandler, "TIM2") \
  X(TIM3_IRQn, TIM3_IRQHandler, "TIM3") \
  X(TIM4_IRQn, TIM4_IRQHandler, "TIM4") \
  X(TIM5_IRQn, TIM5_IRQHandler, "TIM5") \
  X(USART1_IRQn, USART1_IRQHandler, "USART1") \
  X(USART2_IRQn, USART2_IRQHandler, "USART2") \
  X(USART6_IRQn, USART6_IRQHandler, "USART6") \
  X(ADC_IRQn, ADC_IRQHandler, "ADC") \
  X(DMA1_Stream0_IRQn, DMA1_Stream0_IRQHandler, "DMA1_Stream0") \
  X(DMA1_Stream1_IRQn, DMA1_Stream1_IRQHandler, "DMA1_Stream1") \
  X(DMA1_Stream2_IRQn, DMA1_Stream2_IRQHandler, "DMA1_Stream2") \
  X(DMA1_Stream3_IRQn, DMA1_Stream3_IRQHandler, "DMA1_Stream3") \
  X(DMA1_Stream4_IRQn, DMA1_Stream4_IRQHandler, "DMA1_Stream4") \
  X(DMA1_Stream5_IRQn, DMA1_Stream5_IRQHandler, "DMA1_Stream5") \
  X(DMA1_Stream6_IRQn, DMA1_Stream6_IRQHandler, "DMA1_Stream6") \
  X(DMA1_Stream7_IRQn, DMA1_Stream7_IRQHandler, "DMA1_Stream7") \
  X(DMA2_Stream0_IRQn, DMA2_Stream0_IRQHandler, "DMA2_Stream0") \
  X(DMA2_Stream1_IRQn, DMA2_Stream1_IRQHandler, "DMA2_Stream1") \
  X(DMA2_Stream2_IRQn, DMA2_Stream2_IRQHandler, "DMA2_Stream2") \
  X(DMA2_Stream3_IRQn, DMA2_Stream3_IRQHandler, "DMA2_Stream3") \
  X(DMA2_Stream4_IRQn, DMA2_Stream4_IRQHandler, "DMA2_Stream4") \
  X(DMA2_Stream5_IRQn, DMA2_Stream5_IRQHandler, "DMA2_Stream5") \
  X(DMA2_Stream6_IRQn, DMA2_Stream6_IRQHandler, "DMA2_Stream6") \
  X(DMA2_Stream7_IRQn, DMA2_Stream7_IRQHandler, "DMA2_Stream7")

#define X_WEAK(n, h, s) __attribute__((weak)) void h(void) {}
IRQ_LIST(X_WEAK)

typedef void (*handler_t)(void);
static handler_t irq_handler(int irqn)
{
  switch (irqn) {
#define X_CASE(n, h, s) case n: return h;
    IRQ_LIST(X_CASE)
    default: return NULL;
  }
}
static const char *irq_name(int irqn)
{
  switch (irqn) {
#define X_NAME(n, h, s) case n: return s;
    IRQ_LIST(X_NAME)
    default: return NULL;
  }
}

#define NIRQ 128
static volatile uint8_t pend[NIRQ];
static uint64_t irq_count[NIRQ];

static void pend_irq(int irqn) { if (irqn >= -16 && irqn < NIRQ - 16) pend[irqn + 16] = 1; }

static int irq_enabled(int irqn)
{
  if (irqn == SysTick_IRQn) return (SysTick->CTRL & 3u) == 3u;
  if (irqn < 0) return 1;
  return (NVIC->ISER[irqn >> 5] >> (irqn & 31)) & 1u;
}
static int irq_prio(int irqn) { return (int)NVIC_GetPriority((IRQn_Type)irqn); }
static int irq_preempt(int irqn)
{
  uint32_t grp = NVIC_GetPriorityGrouping() & 7u;
  uint32_t subbits = ((grp + __NVIC_PRIO_BITS) < 7u) ? 0u : (grp - 7u + __NVIC_PRIO_BITS);
  return irq_prio(irqn) >> subbits;
}

static void tim_sanitize_irq(int irqn);

static void call_irq(int irqn)
{
  handler_t h = irq_handler(irqn);
  if (!h) return;
  int saved = cur_preempt;
  cur_preempt = irq_preempt(irqn);
  irq_count[irqn + 16]++;
  tim_sanitize_irq(irqn);
  h();
  cur_preempt = saved;
}

/* Esegue gli interrupt pendenti che possono interrompere il livello attuale */
static void deliver(void)
{
  for (int guard = 0; guard < 20000; guard++) {
    if (primask) return;
    int best = 999, bp = 999, bf = 999;
    for (int i = 0; i < NIRQ; i++) {
      if (!pend[i]) continue;
      int irqn = i - 16;
      if (!irq_enabled(irqn)) continue;
      int p = irq_preempt(irqn);
      if (p >= cur_preempt) continue;
      int f = irq_prio(irqn);
      if (p < bp || (p == bp && f < bf)) { best = irqn; bp = p; bf = f; }
    }
    if (best == 999) return;
    pend[best + 16] = 0;
    call_irq(best);
  }
}

void sim_enable_irq(void)  { primask = 0; }
void sim_disable_irq(void) { primask = 1; }
uint32_t sim_get_primask(void) { return (uint32_t)primask; }
void sim_set_primask(uint32_t v) { primask = (int)(v & 1u); }
void sim_nop(void) {}

void sim_NVIC_EnableIRQ(IRQn_Type n)  { if ((int)n >= 0) NVIC->ISER[n >> 5] |= 1u << (n & 31); }
void sim_NVIC_DisableIRQ(IRQn_Type n) { if ((int)n >= 0) NVIC->ISER[n >> 5] &= ~(1u << (n & 31)); }
void sim_NVIC_SetPendingIRQ(IRQn_Type n)   { pend_irq(n); }
void sim_NVIC_ClearPendingIRQ(IRQn_Type n) { if ((int)n >= -16) pend[n + 16] = 0; }
uint32_t sim_NVIC_GetPendingIRQ(IRQn_Type n) { return pend[n + 16]; }
uint32_t sim_NVIC_GetEnableIRQ(IRQn_Type n)  { return (uint32_t)irq_enabled(n); }

static void flush_rings_now(void);
void sim_NVIC_SystemReset(void)
{
  emit("Z");
  out_flush();
  exit(42);                             /* il worker vede il codice 42 e riparte */
}

/* ------------------------------------------------------------------ */
/* Clock                                                               */
static uint32_t clk_sysclk(void)
{
  uint32_t sws = (RCC->CFGR >> 2) & 3u;
  if (sws == 0) return HSI_VALUE;
  if (sws == 1) return HSE_VALUE;
  uint32_t c = RCC->PLLCFGR;
  uint32_t m = c & 0x3Fu, n = (c >> 6) & 0x1FFu, p = (((c >> 16) & 3u) + 1u) * 2u;
  uint64_t src = (c & (1u << 22)) ? HSE_VALUE : HSI_VALUE;
  if (!m || !n) return HSI_VALUE;
  return (uint32_t)(src * n / m / p);
}
static uint32_t clk_hclk(void)  { return clk_sysclk() >> AHBPrescTable[(RCC->CFGR >> 4) & 0xFu]; }
static uint32_t clk_pclk1(void) { return clk_hclk() >> APBPrescTable[(RCC->CFGR >> 10) & 7u]; }
static uint32_t clk_pclk2(void) { return clk_hclk() >> APBPrescTable[(RCC->CFGR >> 13) & 7u]; }
static uint32_t clk_tim1(void)  { return ((RCC->CFGR >> 10) & 7u) < 4u ? clk_pclk1() : clk_pclk1() * 2u; }
static uint32_t clk_tim2(void)  { return ((RCC->CFGR >> 13) & 7u) < 4u ? clk_pclk2() : clk_pclk2() * 2u; }
/* cicli per ms: si ricalcola solo quando cambiano i registri del clock (prima: divisioni a 64 bit a ogni giro di ciclo) */
static uint32_t cpm_cfgr = 0xFFFFFFFFu, cpm_pll = 0xFFFFFFFFu;
static uint64_t cpm_val;
static inline uint64_t cycles_per_ms(void)
{
  uint32_t a = RCC->CFGR, b = RCC->PLLCFGR;
  if (a != cpm_cfgr || b != cpm_pll) { uint64_t c = clk_hclk() / 1000u; cpm_val = c < 1000u ? 1000u : c; cpm_cfgr = a; cpm_pll = b; }
  return cpm_val;
}

void SystemInit(void) {}
void SystemCoreClockUpdate(void) { SystemCoreClock = clk_hclk(); }

/* ------------------------------------------------------------------ */
/* Tempo: il codice "spende" cicli; quando finisce il millisecondo      */
/* si esegue il passo di simulazione (periferiche + interrupt).          */
static void sim_step(void);

static void main_wait_tick(void)
{
  /* il programma ha speso 1 ms di cicli: periferiche e interrupt di questo ms */
  tx_flush();
  t_is_tick = 1;
  sim_step();
  t_is_tick = 0;
  main_mark_ms = atomic_load(&sim_ms);
  main_cyc = 0;
}

static void charge(uint64_t cyc)
{
  if (t_is_tick) {
    isr_cyc += cyc;
    uint64_t cpm = cycles_per_ms();
    while (isr_cyc >= cpm) { isr_cyc -= cpm; sim_step(); }
    return;
  }
  uint64_t now = atomic_load(&sim_ms);
  if (now != main_mark_ms) { main_mark_ms = now; main_cyc = 0; }
  main_cyc += cyc;
  uint64_t cpm = cycles_per_ms();
  while (main_cyc >= cpm) {
    uint64_t rest = main_cyc - cpm;
    main_wait_tick();
    main_cyc = rest;
  }
}

static void wait_one_ms(void)
{
  if (t_is_tick) { isr_cyc = 0; sim_step(); }
  else main_wait_tick();
}

static void consume_us(double us) { charge((uint64_t)(us * clk_hclk() / 1e6)); }

int __sim_loop(const char *f)
{
  if (!t_is_tick && f && f[0] == 'E' && strcmp(f, "Error_Handler") == 0)
    WARN_ONCE(1, "Error_Handler() è stato chiamato: una funzione HAL ha restituito errore (o lo chiama il tuo codice). Il programma resta fermo qui.");
  charge(LOOP_CYC);
  return 1;
}

/* ------------------------------------------------------------------ */
/* printf: come la libc della scheda passa da _write → __io_putchar      */
static int io_default_hit;
__attribute__((weak)) int __io_putchar(int ch) { io_default_hit = 1; return ch; }
__attribute__((weak)) int _write(int file, char *ptr, int len)
{
  (void)file;
  for (int i = 0; i < len; i++) {
    __io_putchar((uint8_t)ptr[i]);
    if (io_default_hit) { tx_add("P", (const uint8_t *)ptr + i, (uint32_t)(len - i)); io_default_hit = 0; return len; }
  }
  return len;
}
int sim_printf(const char *fmt, ...)
{
  char b[2048];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(b, sizeof b, fmt, ap);
  va_end(ap);
  if (n > (int)sizeof b - 1) n = sizeof b - 1;
  if (n > 0) _write(1, b, n);
  return n;
}
int sim_puts(const char *s) { _write(1, (char *)s, (int)strlen(s)); _write(1, "\n", 1); return 1; }
int sim_putchar(int c) { char ch = (char)c; _write(1, &ch, 1); return c; }

/* ------------------------------------------------------------------ */
/* GPIO                                                                */
static GPIO_TypeDef *gp[8];
static const uint8_t gp_en_bit[8] = {0, 1, 2, 3, 4, 5, 6, 7};
static const uint32_t gp_rst_moder[8] = {0xA8000000u, 0x00000280u, 0, 0, 0, 0, 0, 0};
static const uint32_t gp_rst_pupdr[8] = {0x64000000u, 0x00000100u, 0, 0, 0, 0, 0, 0};
static volatile int8_t ext_in[8][16];
static uint16_t board_pullup[8];
static uint16_t lvl[8], lvl_emitted[8];
static int lvl_emitted_valid;
static uint32_t cfg_emitted[8][8];
static int16_t pwm_emit_duty[8][16];
static int32_t pwm_emit_freq[8][16];

static int port_index(GPIO_TypeDef *g)
{
  for (int i = 0; i < 8; i++) if (gp[i] && gp[i] == g) return i;
  return -1;
}
static int port_clock_on(int p) { return (RCC->AHB1ENR >> gp_en_bit[p]) & 1u; }

/* ------------------------------------------------------------------ */
/* Dispositivi esterni collegati ai pin (configurati dal sito, "D …")   */
/*  L = luci (display multiplexato, display a 1 cifra, LED, barra LED):  */
/*      per ogni cifra × segmento si somma il tempo in cui è acceso con  */
/*      la sua cifra abilitata, a ogni scrittura GPIO che cambia un suo   */
/*      pin; ogni DEV_WIN ms si manda la luminosità media 0…255 ("B").   */
/*      Così un display multiplexato a 2 ms per cifra appare fisso come   */
/*      quello vero (persistenza della visione) e un lampeggio lento si   */
/*      vede.                                                            */
/*  U = motore passo-passo 28BYJ-48 con ULN2003 (IN1…IN4)                */
/*  S = motore passo-passo con driver A4988/DRV8825 (STEP, DIR, EN)      */
/*  K = tastierino a matrice 4×4 (righe e colonne collegate dal tasto)    */
#define NDEV 64
#define DEV_DIG 8
#define DEV_SEG 16
#define DEV_WIN 40
typedef struct {
  char type;
  int nd, ns, seg_low, dig_low;
  int8_t dig[DEV_DIG], seg[DEV_SEG];       /* pin = porta*16 + n, -1 = non collegato */
  double acc[DEV_DIG][DEV_SEG];
  uint8_t sent[DEV_DIG * DEV_SEG];
  int have_sent;
  /* motori */
  int8_t pin[4];
  int k, cur, done, mode;
  double since, last_t;
  long pos, bad, fast, j_sent[4];
  int j_have;
  int old_step;
} simdev_t;
static simdev_t devs[NDEV], devs_new[NDEV];
static volatile int devs_pending;
static pthread_mutex_t devs_mx = PTHREAD_MUTEX_INITIALIZER;
static volatile uint16_t key_mask[NDEV];  /* tasti premuti (tastierino) */
static uint16_t dev_mask[8];              /* pin osservati, per porta */
static uint16_t dev_hi[8], dev_lo[8];     /* pin pilotati alti / bassi all'ultimo controllo */
static int devs_any;
static double dev_t_last;
static uint64_t dev_win_start;
static volatile int dev_busy;

static int dev_pin_on(int pk, int low) { if (pk < 0) return 1; return (((low ? dev_lo : dev_hi)[pk >> 4]) >> (pk & 15)) & 1; }
static int dev_drv(int pk, int *lv)
{
  if (pk < 0) return 0;
  int p = pk >> 4, b = pk & 15;
  if ((dev_hi[p] >> b) & 1) { *lv = 1; return 1; }
  if ((dev_lo[p] >> b) & 1) { *lv = 0; return 1; }
  return 0;
}

/* tempo simulato in ms, con la frazione del millisecondo già "spesa" dal codice */
static double dev_now(void)
{
  uint64_t now = atomic_load(&sim_ms);
  double cpm = (double)cycles_per_ms(), f;
  if (t_is_tick) f = (double)isr_cyc / cpm;
  else f = main_mark_ms == now ? (double)main_cyc / cpm : 0;
  return (double)now + (f > 0.999 ? 0.999 : f);
}

static void dev_capture(void)
{
  for (int p = 0; p < 8; p++) {
    dev_hi[p] = dev_lo[p] = 0;
    if (!gp[p] || !dev_mask[p] || !port_clock_on(p)) continue;
    uint32_t moder = gp[p]->MODER, ot = gp[p]->OTYPER, odr = gp[p]->ODR;
    uint16_t out = 0;
    for (int b = 0; b < 16; b++) if (((moder >> (2 * b)) & 3u) == 1u && !(((ot >> b) & 1u) && ((odr >> b) & 1u))) out |= (uint16_t)(1u << b);
    dev_hi[p] = (uint16_t)(out & odr);
    dev_lo[p] = (uint16_t)(out & ~odr);
  }
}

static void lights_acc(double t)
{
  double dt = t - dev_t_last;
  if (dt <= 0) return;
  dev_t_last = t;
  for (int i = 0; i < NDEV; i++) {
    simdev_t *m = &devs[i];
    if (m->type != 'L') continue;
    for (int d = 0; d < m->nd; d++) {
      if (!dev_pin_on(m->dig[d], m->dig_low)) continue;
      for (int s = 0; s < m->ns; s++) if (m->seg[s] >= 0 && dev_pin_on(m->seg[s], m->seg_low)) m->acc[d][s] += dt;
    }
  }
}

/* 28BYJ-48: mezzi passi IN1…IN4 (bit 0 = IN1) */
static const uint8_t HALF8[8] = {0x1, 0x3, 0x2, 0x6, 0x4, 0xC, 0x8, 0x9};
static void uln_pattern(simdev_t *m, int pat, double ts)
{
  if (!pat) return;                        /* bobine spente: il rotore resta dov'è */
  int k = -1;
  for (int i = 0; i < 8; i++) if (HALF8[i] == pat) k = i;
  if (k < 0) { m->bad++; return; }         /* combinazione che non esiste (es. IN1+IN3) */
  if (m->k < 0) { m->k = k; m->last_t = ts; return; }
  int d = (k - m->k + 8) % 8;
  if (d > 4) d -= 8;
  if (!d) return;
  if (d > 2 || d < -2) { m->bad++; m->k = k; m->last_t = ts; return; }   /* salto: il rotore vibra */
  double dt = ts - m->last_t;
  m->k = k;
  m->last_t = ts;
  if (dt < (d == 2 || d == -2 ? 1.8 : 0.9)) { m->fast++; return; }       /* troppo veloce: perde il passo */
  m->pos += d;
  m->mode = d < 0 ? -d : d;
}

static void keypad_apply(simdev_t *m)
{
  int drive[8];
  for (int i = 0; i < 8; i++) drive[i] = -1;
  uint16_t km = key_mask[m - devs];
  for (int r = 0; r < 4; r++) for (int c = 0; c < 4; c++) {
    if (!((km >> (r * 4 + c)) & 1)) continue;
    int a = m->seg[r], b = m->seg[4 + c], lv;
    if (a < 0 || b < 0) continue;
    if (dev_drv(a, &lv)) drive[4 + c] = drive[4 + c] < 0 ? lv : (drive[4 + c] & lv);
    else if (dev_drv(b, &lv)) drive[r] = drive[r] < 0 ? lv : (drive[r] & lv);
  }
  for (int i = 0; i < 8; i++) {
    int pk = m->seg[i];
    if (pk < 0) continue;
    int p = pk >> 4, b = pk & 15;
    ext_in[p][b] = (int8_t)drive[i];
    /* il programma può leggere la colonna subito dopo aver scritto la riga */
    GPIO_TypeDef *g = gp[p];
    if (!g || !port_clock_on(p) || ((g->MODER >> (2 * b)) & 3u) != 0u) continue;
    int pu = (g->PUPDR >> (2 * b)) & 3, v = drive[i] >= 0 ? drive[i] : pu == 1 ? 1 : pu == 2 ? 0 : (board_pullup[p] >> b) & 1;
    if (v) g->IDR |= 1u << b; else g->IDR &= ~(1u << b);
  }
}

/* t = istante dell'ultima scrittura: chiude il periodo precedente e rilegge i pin */
static void dev_update(double t)
{
  lights_acc(t);
  dev_capture();
  for (int i = 0; i < NDEV; i++) {
    simdev_t *m = &devs[i];
    if (m->type == 'U') {
      int pat = 0;
      for (int n = 0; n < 4; n++) if (m->pin[n] >= 0 && dev_pin_on(m->pin[n], 0)) pat |= 1 << n;
      if (pat != m->cur) {
        if (t > m->since && !m->done) uln_pattern(m, m->cur, m->since);
        m->cur = pat; m->since = t; m->done = 0;
      }
    } else if (m->type == 'S') {
      int st = m->pin[0] >= 0 && dev_pin_on(m->pin[0], 0);
      if (st && !m->old_step) {
        int en = m->pin[2] < 0 || !dev_pin_on(m->pin[2], 0);        /* EN attivo basso (pull-down nel driver) */
        if (en) m->pos += (m->pin[1] >= 0 && dev_pin_on(m->pin[1], 0)) ? 1 : -1;
        else m->bad++;
      }
      m->old_step = st;
    } else if (m->type == 'K') keypad_apply(m);
  }
}

/* chiamata dalle scritture GPIO della HAL quando cambia un pin osservato */
static void dev_gpio_changed(GPIO_TypeDef *g, uint32_t changed)
{
  if (!devs_any || dev_busy) return;
  int p = -1;
  for (int i = 0; i < 8; i++) if (gp[i] == g) p = i;
  if (p < 0 || !(changed & dev_mask[p])) return;
  dev_busy = 1;
  dev_update(dev_now());
  dev_busy = 0;
}

static void devs_apply_pending(uint64_t now)
{
  pthread_mutex_lock(&devs_mx);
  memcpy(devs, devs_new, sizeof devs);
  devs_pending = 0;
  pthread_mutex_unlock(&devs_mx);
  memset(dev_mask, 0, sizeof dev_mask);
  devs_any = 0;
  for (int i = 0; i < NDEV; i++) {
    simdev_t *m = &devs[i];
    if (!m->type) continue;
    devs_any = 1;
    for (int n = 0; n < DEV_DIG; n++) if (m->dig[n] >= 0) dev_mask[m->dig[n] >> 4] |= (uint16_t)(1u << (m->dig[n] & 15));
    for (int n = 0; n < DEV_SEG; n++) if (m->seg[n] >= 0) dev_mask[m->seg[n] >> 4] |= (uint16_t)(1u << (m->seg[n] & 15));
    for (int n = 0; n < 4; n++) if (m->pin[n] >= 0) dev_mask[m->pin[n] >> 4] |= (uint16_t)(1u << (m->pin[n] & 15));
    m->k = -1; m->cur = 0; m->done = 1; m->since = (double)now;
  }
  dev_t_last = (double)now;
  dev_win_start = now;
  dev_capture();
  for (int i = 0; i < NDEV; i++) if (devs[i].type == 'S') devs[i].old_step = devs[i].pin[0] >= 0 && dev_pin_on(devs[i].pin[0], 0);
}

static void hexbytes(char *o, const uint8_t *v, int n) { for (int i = 0; i < n; i++) { o[2 * i] = "0123456789abcdef"[v[i] >> 4]; o[2 * i + 1] = "0123456789abcdef"[v[i] & 15]; } o[2 * n] = 0; }

/* ogni ms dal tick thread (cpu sospesa) */
static void devs_step(void)
{
  if (dev_busy) return;                    /* la cpu è stata fermata a metà di dev_update: al prossimo ms */
  uint64_t now = atomic_load(&sim_ms);
  if (devs_pending) devs_apply_pending(now);
  if (!devs_any) return;
  dev_update((double)now);                 /* prende anche le scritture dirette nei registri (ODR, BSRR) */
  for (int i = 0; i < NDEV; i++) {
    simdev_t *m = &devs[i];
    if (m->type == 'U' && !m->done && (double)now > m->since) { uln_pattern(m, m->cur, m->since); m->done = 1; }
  }
  if (now - dev_win_start < DEV_WIN) return;
  double win = (double)(now - dev_win_start);
  dev_win_start = now;
  for (int i = 0; i < NDEV; i++) {
    simdev_t *m = &devs[i];
    if (m->type == 'L') {
      uint8_t v[DEV_DIG * DEV_SEG];
      int n = m->nd * m->ns;
      for (int d = 0; d < m->nd; d++) for (int s = 0; s < m->ns; s++) {
        double x = m->acc[d][s] / win * 255.0 + 0.5;
        v[d * m->ns + s] = (uint8_t)(x > 255 ? 255 : x);
        m->acc[d][s] = 0;
      }
      if (!m->have_sent || memcmp(v, m->sent, (size_t)n)) {
        char hx[2 * DEV_DIG * DEV_SEG + 1];
        memcpy(m->sent, v, (size_t)n);
        m->have_sent = 1;
        hexbytes(hx, v, n);
        emit("B %d %s", i, hx);
      }
    } else if (m->type == 'U' || m->type == 'S') {
      long j[4] = {m->pos, m->bad, m->fast, m->type == 'U' ? m->cur * 4 + m->mode : 0};
      if (!m->j_have || memcmp(j, m->j_sent, sizeof j)) {
        memcpy(m->j_sent, j, sizeof j);
        m->j_have = 1;
        emit("J %d %ld %ld %ld %ld", i, j[0], j[1], j[2], j[3]);
      }
    }
  }
}

/* riga "D …" dal sito (thread stdin): la nuova configurazione si applica al prossimo ms */
static void devs_parse(const char *line)
{
  const char *p = line + 1;
  while (*p == ' ') p++;
  pthread_mutex_lock(&devs_mx);
  if (*p == '-') memset(devs_new, 0, sizeof devs_new);
  else {
    char *e;
    long i = strtol(p, &e, 10);
    p = e;
    while (*p == ' ') p++;
    char ty = *p ? *p++ : 0;
    if (i >= 0 && i < NDEV) {
      simdev_t *m = &devs_new[i];
      memset(m, 0, sizeof *m);
      memset(m->dig, -1, sizeof m->dig);
      memset(m->seg, -1, sizeof m->seg);
      memset(m->pin, -1, sizeof m->pin);
      long v[64];
      int n = 0;
      while (n < 64) { long x = strtol(p, &e, 10); if (e == p) break; v[n++] = x; p = e; }
      int ok = 1;
      if (ty == 'L' && n >= 3) {
        m->seg_low = (int)v[0]; m->dig_low = (int)v[1];
        m->nd = (int)v[2];
        if (m->nd < 1 || m->nd > DEV_DIG || n < 4 + m->nd) ok = 0;
        else {
          for (int d = 0; d < m->nd; d++) m->dig[d] = (int8_t)(v[3 + d] >= 0 && v[3 + d] < 128 ? v[3 + d] : -1);
          m->ns = (int)v[3 + m->nd];
          if (m->ns < 1 || m->ns > DEV_SEG || n < 4 + m->nd + m->ns) ok = 0;
          else for (int s = 0; s < m->ns; s++) { long x = v[4 + m->nd + s]; m->seg[s] = (int8_t)(x >= 0 && x < 128 ? x : -1); }
        }
      } else if ((ty == 'U' && n >= 4) || (ty == 'S' && n >= 3)) {
        for (int k = 0; k < (ty == 'U' ? 4 : 3); k++) m->pin[k] = (int8_t)(v[k] >= 0 && v[k] < 128 ? v[k] : -1);
      } else if (ty == 'K' && n >= 8) {
        for (int k = 0; k < 8; k++) m->seg[k] = (int8_t)(v[k] >= 0 && v[k] < 128 ? v[k] : -1);
      } else ok = 0;
      if (ok) m->type = ty; else m->type = 0;
    }
  }
  devs_pending = 1;
  pthread_mutex_unlock(&devs_mx);
}

void HAL_GPIO_Init(GPIO_TypeDef *GPIOx, GPIO_InitTypeDef *GPIO_Init)
{
  int p = port_index(GPIOx);
  if (p < 0 || !GPIO_Init) return;
  if (!port_clock_on(p)) {
    WARN_ONCE(10 + p, "HAL_GPIO_Init su GPIO%c ma il clock della porta non è abilitato (__HAL_RCC_GPIO%c_CLK_ENABLE): sulla scheda vera la configurazione viene ignorata.", "ABCDEFGH"[p], "ABCDEFGH"[p]);
    return;
  }
  for (uint32_t pos = 0; pos < 16; pos++) {
    uint32_t bit = 1u << pos;
    if (!(GPIO_Init->Pin & bit)) continue;
    uint32_t mode = GPIO_Init->Mode;
    uint32_t m = mode & 3u;
    if (m == 1u || m == 2u) {
      GPIOx->OSPEEDR = (GPIOx->OSPEEDR & ~(3u << (pos * 2))) | ((GPIO_Init->Speed & 3u) << (pos * 2));
      GPIOx->OTYPER = (GPIOx->OTYPER & ~bit) | (((mode >> 4) & 1u) << pos);
    }
    if (m != 3u)
      GPIOx->PUPDR = (GPIOx->PUPDR & ~(3u << (pos * 2))) | ((GPIO_Init->Pull & 3u) << (pos * 2));
    if (m == 2u) {
      uint32_t sh = (pos & 7u) * 4u;
      GPIOx->AFR[pos >> 3] = (GPIOx->AFR[pos >> 3] & ~(0xFu << sh)) | ((GPIO_Init->Alternate & 0xFu) << sh);
    }
    GPIOx->MODER = (GPIOx->MODER & ~(3u << (pos * 2))) | (m << (pos * 2));
    if (mode & 0x30000u) {
      uint32_t sh = (pos & 3u) * 4u;
      SYSCFG->EXTICR[pos >> 2] = (SYSCFG->EXTICR[pos >> 2] & ~(0xFu << sh)) | ((uint32_t)p << sh);
      EXTI->IMR  = (mode & 0x10000u)  ? (EXTI->IMR | bit)  : (EXTI->IMR & ~bit);
      EXTI->EMR  = (mode & 0x20000u)  ? (EXTI->EMR | bit)  : (EXTI->EMR & ~bit);
      EXTI->RTSR = (mode & 0x100000u) ? (EXTI->RTSR | bit) : (EXTI->RTSR & ~bit);
      EXTI->FTSR = (mode & 0x200000u) ? (EXTI->FTSR | bit) : (EXTI->FTSR & ~bit);
    }
  }
}

void HAL_GPIO_DeInit(GPIO_TypeDef *GPIOx, uint32_t GPIO_Pin)
{
  int p = port_index(GPIOx);
  if (p < 0) return;
  for (uint32_t pos = 0; pos < 16; pos++) {
    uint32_t bit = 1u << pos;
    if (!(GPIO_Pin & bit)) continue;
    uint32_t sh = (pos & 3u) * 4u;
    if (((SYSCFG->EXTICR[pos >> 2] >> sh) & 0xFu) == (uint32_t)p) {
      EXTI->IMR &= ~bit; EXTI->EMR &= ~bit; EXTI->RTSR &= ~bit; EXTI->FTSR &= ~bit;
      SYSCFG->EXTICR[pos >> 2] &= ~(0xFu << sh);
    }
    GPIOx->MODER &= ~(3u << (pos * 2));
    GPIOx->AFR[pos >> 3] &= ~(0xFu << ((pos & 7u) * 4u));
    GPIOx->OSPEEDR &= ~(3u << (pos * 2));
    GPIOx->OTYPER &= ~bit;
    GPIOx->PUPDR &= ~(3u << (pos * 2));
  }
}

GPIO_PinState HAL_GPIO_ReadPin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin)
{
  charge(GPIO_CYC);
  return (GPIOx->IDR & GPIO_Pin) ? GPIO_PIN_SET : GPIO_PIN_RESET;
}
/* analizzatore logico: ogni scrittura con HAL_GPIO_WritePin/TogglePin esce subito con il
 * tempo simulato in µs ("G us porta ODR"), non solo a fine millisecondo come "C".
 * Al massimo G_MAX_MS righe per ms: un ciclo che commuta a raffica non intasa la pagina
 * (i cambi in più si vedono comunque dalla "C" del millisecondo). */
#define G_MAX_MS 24
static void gpio_fine_emit(GPIO_TypeDef *g)
{
  static uint64_t g_ms = (uint64_t)-1;
  static int g_n;
  int p = -1;
  for (int i = 0; i < 8; i++) if (gp[i] == g) p = i;
  if (p < 0) return;
  uint64_t now = atomic_load(&sim_ms);
  if (now != g_ms) { g_ms = now; g_n = 0; }
  if (++g_n > G_MAX_MS) return;
  emit("G %.0f %d %x", dev_now() * 1000.0, p, (unsigned)(g->ODR & 0xFFFFu));
}
void HAL_GPIO_WritePin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin, GPIO_PinState PinState)
{
  charge(GPIO_CYC);                     /* prima di leggere ODR: un interrupt può scattare qui, come sulla scheda */
  uint32_t o = GPIOx->ODR, n = PinState != GPIO_PIN_RESET ? (o | GPIO_Pin) : (o & ~(uint32_t)GPIO_Pin);
  if (n == o) return;                   /* percorso veloce: niente cambia (il caso di gran lunga più comune) */
  GPIOx->ODR = n;
  gpio_fine_emit(GPIOx); dev_gpio_changed(GPIOx, n ^ o);
}
void HAL_GPIO_TogglePin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin) { charge(GPIO_CYC); GPIOx->ODR ^= GPIO_Pin; gpio_fine_emit(GPIOx); dev_gpio_changed(GPIOx, GPIO_Pin); }
HAL_StatusTypeDef HAL_GPIO_LockPin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin) { (void)GPIOx; (void)GPIO_Pin; return HAL_OK; }

__weak void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin) { (void)GPIO_Pin; }
void HAL_GPIO_EXTI_IRQHandler(uint16_t GPIO_Pin)
{
  if (EXTI->PR & GPIO_Pin) {
    EXTI->PR &= ~(uint32_t)GPIO_Pin;
    HAL_GPIO_EXTI_Callback(GPIO_Pin);
  }
}

static int exti_irq(int line)
{
  if (line <= 4) return EXTI0_IRQn + line;
  if (line <= 9) return EXTI9_5_IRQn;
  return EXTI15_10_IRQn;
}

/* ------------------------------------------------------------------ */
/* TIM                                                                 */
typedef struct {
  TIM_TypeDef *t;
  const char *name;
  int apb2, bits32, en_bit, af;
  int irq_up, irq_cc;
  double acc;
  uint32_t sr_sh;
  uint8_t ocref[4];
  uint8_t enc_ti[2], enc_ok;   /* modalità encoder: ultimo livello di TI1FP1 / TI2FP2, già letto */
} simtim_t;
static simtim_t tims[8];
#define NTIM 8

static simtim_t *tim_of(TIM_TypeDef *t)
{
  for (int i = 0; i < NTIM; i++) if (tims[i].t == t) return &tims[i];
  return NULL;
}
static int tim_clock_on(simtim_t *s)
{
  volatile uint32_t *enr = s->apb2 ? &RCC->APB2ENR : &RCC->APB1ENR;
  return (*enr >> s->en_bit) & 1u;
}
static double tim_clk(simtim_t *s) { return s->apb2 ? clk_tim2() : clk_tim1(); }
static uint32_t tim_arr(simtim_t *s) { return s->bits32 ? s->t->ARR : (s->t->ARR & 0xFFFFu); }

static void tim_sanitize(simtim_t *s)
{
  uint32_t v = s->t->SR & s->sr_sh & 0x1FFFu;
  s->t->SR = v;
  s->sr_sh = v;
}
static void tim_setflag(simtim_t *s, uint32_t f) { tim_sanitize(s); s->sr_sh |= f; s->t->SR = s->sr_sh; }

static void tim_sanitize_irq(int irqn)
{
  for (int i = 0; i < NTIM; i++)
    if (tims[i].t && (tims[i].irq_up == irqn || tims[i].irq_cc == irqn)) tim_sanitize(&tims[i]);
}

static void tim_pend_if_asserted(simtim_t *s)
{
  TIM_TypeDef *t = s->t;
  uint32_t a = t->SR & t->DIER;
  if (a & TIM_SR_UIF) pend_irq(s->irq_up);
  if (a & (TIM_SR_CC1IF | TIM_SR_CC2IF | TIM_SR_CC3IF | TIM_SR_CC4IF)) pend_irq(s->irq_cc);
}

static void tim_process_egr(simtim_t *s)
{
  TIM_TypeDef *t = s->t;
  uint32_t e = t->EGR;
  if (!e) return;
  t->EGR = 0;
  if (e & TIM_EGR_UG) {
    int down = (t->CR1 & TIM_CR1_DIR) && !(t->CR1 & TIM_CR1_CMS);
    t->CNT = down ? tim_arr(s) : 0;
    s->acc = 0;
    if (!(t->CR1 & TIM_CR1_URS) && !(t->CR1 & TIM_CR1_UDIS)) tim_setflag(s, TIM_SR_UIF);
  }
  for (int ch = 0; ch < 4; ch++)
    if (e & (TIM_EGR_CC1G << ch)) tim_setflag(s, TIM_SR_CC1IF << ch);
}

static int64_t floordiv(int64_t a, int64_t b) { int64_t q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; return q; }

static uint32_t tim_ocm(simtim_t *s, int ch)
{
  uint32_t ccmr = ch < 2 ? s->t->CCMR1 : s->t->CCMR2;
  int sh = (ch & 1) * 8;
  if ((ccmr >> sh) & 3u) return 99;         /* canale in input capture */
  return (ccmr >> (sh + 4)) & 7u;
}

static void tim_step(simtim_t *s)
{
  TIM_TypeDef *t = s->t;
  tim_process_egr(s);
  if (t->SMCR & TIM_SMCR_SMS) { unsigned sms = t->SMCR & TIM_SMCR_SMS; if (sms >= 1u && sms <= 3u) return; }   /* encoder: conta i fronti di TI1/TI2 (update_pins), non il clock */
  if (!(t->CR1 & TIM_CR1_CEN)) return;
  if (!tim_clock_on(s)) { WARN_ONCE(30 + (int)(s - tims), "%s avviato ma il suo clock non è abilitato (__HAL_RCC_%s_CLK_ENABLE): sulla scheda vera non conta.", s->name, s->name); return; }
  tim_sanitize(s);
  tim_pend_if_asserted(s);
  deliver();
  if (!(t->CR1 & TIM_CR1_CEN)) return;

  uint32_t arr = tim_arr(s);
  if (arr == 0) return;
  uint64_t period = (uint64_t)arr + 1u;
  s->acc += tim_clk(s) / (double)((t->PSC & 0xFFFFu) + 1u) / 1000.0;
  uint64_t n = (uint64_t)s->acc;
  s->acc -= (double)n;
  if (n == 0) return;

  int down = (t->CR1 & TIM_CR1_DIR) && !(t->CR1 & TIM_CR1_CMS);
  uint64_t cnt = t->CNT % period, updates, newcnt;
  if (!down) { uint64_t tot = cnt + n; updates = tot / period; newcnt = tot % period; }
  else if (n <= cnt) { updates = 0; newcnt = cnt - n; }
  else { uint64_t rem = n - cnt - 1u; updates = 1u + rem / period; newcnt = arr - rem % period; }

  uint64_t ccm[4] = {0, 0, 0, 0}, maxev = updates;
  for (int ch = 0; ch < 4; ch++) {
    uint32_t ccr = (&t->CCR1)[ch];
    if (ccr > arr) continue;
    int64_t a = down ? (int64_t)(arr - cnt) : (int64_t)cnt;
    int64_t c = down ? (int64_t)(arr - ccr) : (int64_t)ccr;
    ccm[ch] = (uint64_t)(floordiv(a + (int64_t)n - c, (int64_t)period) - floordiv(a - c, (int64_t)period));
    if (ccm[ch] > maxev) maxev = ccm[ch];
  }
  t->CNT = (uint32_t)newcnt;
  if (maxev > 2000) maxev = 2000;

  for (uint64_t k = 0; k < maxev; k++) {
    for (int ch = 0; ch < 4; ch++) {
      if (k >= ccm[ch]) continue;
      uint32_t ocm = tim_ocm(s, ch);
      if (ocm == 1) s->ocref[ch] = 1;
      else if (ocm == 2) s->ocref[ch] = 0;
      else if (ocm == 3) s->ocref[ch] ^= 1;
      if (ocm != 99) {
        tim_setflag(s, TIM_SR_CC1IF << ch);
        if (t->DIER & (TIM_DIER_CC1IE << ch)) { pend_irq(s->irq_cc); deliver(); }
      }
    }
    if (k < updates) {
      if (!(t->CR1 & TIM_CR1_UDIS)) {
        tim_setflag(s, TIM_SR_UIF);
        if (t->DIER & TIM_DIER_UIE) { pend_irq(s->irq_up); deliver(); }
      }
      if (t->CR1 & TIM_CR1_OPM) { t->CR1 &= ~TIM_CR1_CEN; t->CNT = down ? arr : 0; break; }
    }
    if (!(t->CR1 & TIM_CR1_CEN)) break;
  }
}

/* uscita PWM/OC di un canale: livello, duty (‰, -1 = non periodico), frequenza */
static void tim_output(simtim_t *s, int ch, int neg, int *level, int *duty, double *freq)
{
  TIM_TypeDef *t = s->t;
  *level = 0; *duty = -1; *freq = 0;
  int en = (t->CCER >> (4 * ch + (neg ? 2 : 0))) & 1u;
  int pol = (t->CCER >> (4 * ch + (neg ? 3 : 1))) & 1u;
  if (!en) return;
  if (s == &tims[0] && !(t->BDTR & TIM_BDTR_MOE)) return;
  uint32_t ocm = tim_ocm(s, ch);
  if (ocm == 99) return;
  uint32_t arr = tim_arr(s), ccr = (&t->CCR1)[ch];
  double f = (t->CR1 & TIM_CR1_CEN) && tim_clock_on(s) ? tim_clk(s) / ((t->PSC & 0xFFFFu) + 1.0) / (arr + 1.0) : 0;
  int ref; double d = -1;
  switch (ocm) {
    case 6: ref = t->CNT < ccr; d = ccr >= arr + 1u ? 1.0 : (double)ccr / (arr + 1.0); break;
    case 7: ref = t->CNT >= ccr; d = ccr >= arr + 1u ? 0.0 : 1.0 - (double)ccr / (arr + 1.0); break;
    case 4: ref = 0; break;
    case 5: ref = 1; break;
    case 3: ref = s->ocref[ch]; if (f > 0) { d = 0.5; f /= 2; } break;
    default: ref = s->ocref[ch]; break;
  }
  if (neg) { ref = !ref; if (d >= 0) d = 1.0 - d; }
  if (pol) { ref = !ref; if (d >= 0) d = 1.0 - d; }
  *freq = f;
  if (d >= 0 && f > 40.0) { *duty = (int)lround(d * 1000.0); *level = d >= 0.5; }
  else *level = ref;
}

/* pin dei canali timer della F401: tim (indice in tims), canale, N, porta, pin */
static const uint8_t tmap[][5] = {
  {0,0,0,0,8},{0,1,0,0,9},{0,2,0,0,10},{0,3,0,0,11},{0,0,1,0,7},{0,0,1,1,13},{0,1,1,1,0},{0,1,1,1,14},{0,2,1,1,1},{0,2,1,1,15},
  {1,0,0,0,0},{1,0,0,0,5},{1,0,0,0,15},{1,1,0,0,1},{1,1,0,1,3},{1,2,0,0,2},{1,2,0,1,10},{1,3,0,0,3},
  {2,0,0,0,6},{2,0,0,1,4},{2,0,0,2,6},{2,1,0,0,7},{2,1,0,1,5},{2,1,0,2,7},{2,2,0,1,0},{2,2,0,2,8},{2,3,0,1,1},{2,3,0,2,9},
  {3,0,0,1,6},{3,1,0,1,7},{3,2,0,1,8},{3,3,0,1,9},
  {4,0,0,0,0},{4,1,0,0,1},{4,2,0,0,2},{4,3,0,0,3},
  {5,0,0,0,2},{5,1,0,0,3},{6,0,0,1,8},{7,0,0,1,9},
};

static int pin_timer_output(int p, int pin, uint32_t af, int *level, int *duty, double *freq)
{
  for (size_t i = 0; i < sizeof tmap / sizeof tmap[0]; i++) {
    if (tmap[i][3] != p || tmap[i][4] != pin) continue;
    simtim_t *s = &tims[tmap[i][0]];
    if ((uint32_t)s->af != af) continue;
    tim_output(s, tmap[i][1], tmap[i][2], level, duty, freq);
    return 1;
  }
  return 0;
}

#ifdef HAL_TIM_MODULE_ENABLED
__weak void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_OC_DelayElapsedCallback(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_PWM_PulseFinishedCallback(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_TriggerCallback(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_ErrorCallback(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_Base_MspInit(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_Base_MspDeInit(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_PWM_MspDeInit(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_OC_MspInit(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_OC_MspDeInit(TIM_HandleTypeDef *htim) { (void)htim; }

static void tim_base_config(TIM_HandleTypeDef *h)
{
  TIM_TypeDef *t = h->Instance;
  simtim_t *s = tim_of(t);
  uint32_t cr1 = t->CR1;
  cr1 &= ~(TIM_CR1_DIR | TIM_CR1_CMS | TIM_CR1_CKD | TIM_CR1_ARPE);
  cr1 |= h->Init.CounterMode | h->Init.ClockDivision | h->Init.AutoReloadPreload;
  t->CR1 = cr1;
  t->ARR = h->Init.Period;
  t->PSC = h->Init.Prescaler;
  if (s == &tims[0]) t->RCR = h->Init.RepetitionCounter;
#ifdef SIM_UG_NO_UIF
  t->CR1 |= TIM_CR1_URS;
#endif
  t->EGR = TIM_EGR_UG;
  if (s) tim_process_egr(s);
  t->CR1 = cr1;
}

static void tim_set_ready(TIM_HandleTypeDef *h)
{
#ifdef TIM_CHANNEL_STATE_SET_ALL
  h->DMABurstState = HAL_DMA_BURST_STATE_READY;
  TIM_CHANNEL_STATE_SET_ALL(h, HAL_TIM_CHANNEL_STATE_READY);
  TIM_CHANNEL_N_STATE_SET_ALL(h, HAL_TIM_CHANNEL_STATE_READY);
#endif
  h->State = HAL_TIM_STATE_READY;
}

typedef void (*tim_msp_t)(TIM_HandleTypeDef *);
static HAL_StatusTypeDef tim_init(TIM_HandleTypeDef *h, tim_msp_t msp)
{
  if (!h || !tim_of(h->Instance)) return HAL_ERROR;
  if (h->State == HAL_TIM_STATE_RESET) { h->Lock = HAL_UNLOCKED; msp(h); }
  h->State = HAL_TIM_STATE_BUSY;
  tim_base_config(h);
  tim_set_ready(h);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_Base_Init(TIM_HandleTypeDef *h) { return tim_init(h, HAL_TIM_Base_MspInit); }
HAL_StatusTypeDef HAL_TIM_PWM_Init(TIM_HandleTypeDef *h)  { return tim_init(h, HAL_TIM_PWM_MspInit); }
HAL_StatusTypeDef HAL_TIM_OC_Init(TIM_HandleTypeDef *h)   { return tim_init(h, HAL_TIM_OC_MspInit); }

static void tim_disable(TIM_TypeDef *t)
{
  if ((t->CCER & 0x1111u) == 0 && (t->CCER & 0x0444u) == 0) t->CR1 &= ~TIM_CR1_CEN;
}
HAL_StatusTypeDef HAL_TIM_Base_DeInit(TIM_HandleTypeDef *h) { h->State = HAL_TIM_STATE_BUSY; tim_disable(h->Instance); HAL_TIM_Base_MspDeInit(h); h->State = HAL_TIM_STATE_RESET; return HAL_OK; }
HAL_StatusTypeDef HAL_TIM_PWM_DeInit(TIM_HandleTypeDef *h)  { h->State = HAL_TIM_STATE_BUSY; tim_disable(h->Instance); HAL_TIM_PWM_MspDeInit(h); h->State = HAL_TIM_STATE_RESET; return HAL_OK; }

HAL_StatusTypeDef HAL_TIM_Base_Start(TIM_HandleTypeDef *h)
{
  if (h->State != HAL_TIM_STATE_READY) return HAL_ERROR;
  h->State = HAL_TIM_STATE_BUSY;
  h->Instance->CR1 |= TIM_CR1_CEN;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_Base_Stop(TIM_HandleTypeDef *h) { tim_disable(h->Instance); h->State = HAL_TIM_STATE_READY; return HAL_OK; }
HAL_StatusTypeDef HAL_TIM_Base_Start_IT(TIM_HandleTypeDef *h)
{
  if (h->State != HAL_TIM_STATE_READY) return HAL_ERROR;
  h->State = HAL_TIM_STATE_BUSY;
  h->Instance->DIER |= TIM_DIER_UIE;
  h->Instance->CR1 |= TIM_CR1_CEN;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_Base_Stop_IT(TIM_HandleTypeDef *h)
{
  h->Instance->DIER &= ~TIM_DIER_UIE;
  tim_disable(h->Instance);
  h->State = HAL_TIM_STATE_READY;
  return HAL_OK;
}

static HAL_StatusTypeDef tim_oc_config(TIM_HandleTypeDef *h, TIM_OC_InitTypeDef *c, uint32_t Channel, int preload)
{
  TIM_TypeDef *t = h->Instance;
  int ch = (int)(Channel / 4u);
  if (ch > 3) return HAL_ERROR;
  volatile uint32_t *ccmr = ch < 2 ? &t->CCMR1 : &t->CCMR2;
  int sh = (ch & 1) * 8;
  uint32_t v = c->OCMode | (preload ? TIM_CCMR1_OC1PE : 0u) | (preload ? c->OCFastMode : 0u);
  *ccmr = (*ccmr & ~(0xFFu << sh)) | ((v & 0xFFu) << sh);
  t->CCER = (t->CCER & ~(0xAu << (4 * ch))) | ((c->OCPolarity & 0x2u) << (4 * ch)) | ((c->OCNPolarity & 0x8u) << (4 * ch));
  (&t->CCR1)[ch] = c->Pulse;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_PWM_ConfigChannel(TIM_HandleTypeDef *h, const TIM_OC_InitTypeDef *c, uint32_t Channel)
{ return tim_oc_config(h, (TIM_OC_InitTypeDef *)c, Channel, 1); }
HAL_StatusTypeDef HAL_TIM_OC_ConfigChannel(TIM_HandleTypeDef *h, const TIM_OC_InitTypeDef *c, uint32_t Channel)
{ return tim_oc_config(h, (TIM_OC_InitTypeDef *)c, Channel, 0); }

static HAL_StatusTypeDef tim_ch_start(TIM_HandleTypeDef *h, uint32_t Channel, int it, int neg)
{
  TIM_TypeDef *t = h->Instance;
  int ch = (int)(Channel / 4u);
  if (ch > 3) return HAL_ERROR;
  if (it) t->DIER |= TIM_DIER_CC1IE << ch;
  t->CCER |= 1u << (4 * ch + (neg ? 2 : 0));
  if (t == TIM1) t->BDTR |= TIM_BDTR_MOE;
  t->CR1 |= TIM_CR1_CEN;
  return HAL_OK;
}
static HAL_StatusTypeDef tim_ch_stop(TIM_HandleTypeDef *h, uint32_t Channel, int it, int neg)
{
  TIM_TypeDef *t = h->Instance;
  int ch = (int)(Channel / 4u);
  if (ch > 3) return HAL_ERROR;
  if (it) t->DIER &= ~(TIM_DIER_CC1IE << ch);
  t->CCER &= ~(1u << (4 * ch + (neg ? 2 : 0)));
  if (t == TIM1 && (t->CCER & 0x5555u) == 0) t->BDTR &= ~TIM_BDTR_MOE;
  tim_disable(t);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_PWM_Start(TIM_HandleTypeDef *h, uint32_t c)    { return tim_ch_start(h, c, 0, 0); }
HAL_StatusTypeDef HAL_TIM_PWM_Stop(TIM_HandleTypeDef *h, uint32_t c)     { return tim_ch_stop(h, c, 0, 0); }
HAL_StatusTypeDef HAL_TIM_PWM_Start_IT(TIM_HandleTypeDef *h, uint32_t c) { return tim_ch_start(h, c, 1, 0); }
HAL_StatusTypeDef HAL_TIM_PWM_Stop_IT(TIM_HandleTypeDef *h, uint32_t c)  { return tim_ch_stop(h, c, 1, 0); }
HAL_StatusTypeDef HAL_TIM_OC_Start(TIM_HandleTypeDef *h, uint32_t c)     { return tim_ch_start(h, c, 0, 0); }
HAL_StatusTypeDef HAL_TIM_OC_Stop(TIM_HandleTypeDef *h, uint32_t c)      { return tim_ch_stop(h, c, 0, 0); }
HAL_StatusTypeDef HAL_TIM_OC_Start_IT(TIM_HandleTypeDef *h, uint32_t c)  { return tim_ch_start(h, c, 1, 0); }
HAL_StatusTypeDef HAL_TIM_OC_Stop_IT(TIM_HandleTypeDef *h, uint32_t c)   { return tim_ch_stop(h, c, 1, 0); }
HAL_StatusTypeDef HAL_TIMEx_PWMN_Start(TIM_HandleTypeDef *h, uint32_t c) { return tim_ch_start(h, c, 0, 1); }
HAL_StatusTypeDef HAL_TIMEx_PWMN_Stop(TIM_HandleTypeDef *h, uint32_t c)  { return tim_ch_stop(h, c, 0, 1); }
HAL_StatusTypeDef HAL_TIMEx_OCN_Start(TIM_HandleTypeDef *h, uint32_t c)  { return tim_ch_start(h, c, 0, 1); }
HAL_StatusTypeDef HAL_TIMEx_OCN_Stop(TIM_HandleTypeDef *h, uint32_t c)   { return tim_ch_stop(h, c, 0, 1); }

/* Modalità encoder (RM0368 §13.3.16): SMCR.SMS = 1 (TI1), 2 (TI2), 3 (TI12); CC1S = CC2S = 01,
 * polarità con CC1P/CC2P, filtro IC1F/IC2F. Come nella HAL vera; i fronti li conta update_pins. */
__weak void HAL_TIM_Encoder_MspInit(TIM_HandleTypeDef *htim) { (void)htim; }
__weak void HAL_TIM_Encoder_MspDeInit(TIM_HandleTypeDef *htim) { (void)htim; }
HAL_StatusTypeDef HAL_TIM_Encoder_Init(TIM_HandleTypeDef *h, const TIM_Encoder_InitTypeDef *c)
{
  if (!h || !c || !tim_of(h->Instance)) return HAL_ERROR;
  if (h->State == HAL_TIM_STATE_RESET) { h->Lock = HAL_UNLOCKED; HAL_TIM_Encoder_MspInit(h); }
  h->State = HAL_TIM_STATE_BUSY;
  TIM_TypeDef *t = h->Instance;
  t->SMCR &= ~TIM_SMCR_SMS;
  tim_base_config(h);
  t->SMCR = (t->SMCR & ~TIM_SMCR_SMS) | (c->EncoderMode & TIM_SMCR_SMS);
  t->CCMR1 = (c->IC1Selection | (c->IC2Selection << 8)) | (c->IC1Prescaler | (c->IC2Prescaler << 8)) | ((c->IC1Filter << 4) | (c->IC2Filter << 12));
  t->CCER = (t->CCER & ~(TIM_CCER_CC1P | TIM_CCER_CC2P | TIM_CCER_CC1NP | TIM_CCER_CC2NP)) | (c->IC1Polarity | (c->IC2Polarity << 4));
  if ((c->IC1Polarity & TIM_CCER_CC1NP) || (c->IC2Polarity & TIM_CCER_CC1NP))
    WARN_ONCE(41, "Encoder con polarità «entrambi i fronti» (BOTHEDGE): nel manuale non è ammessa in modalità encoder.");
  tim_set_ready(h);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_Encoder_DeInit(TIM_HandleTypeDef *h)
{
  h->State = HAL_TIM_STATE_BUSY; tim_disable(h->Instance); HAL_TIM_Encoder_MspDeInit(h); h->State = HAL_TIM_STATE_RESET; return HAL_OK;
}
/* CCxE abilita solo la cattura in CCRx: il contatore dell'encoder conta lo stesso (anche con TIM_CHANNEL_1) */
static uint32_t enc_cce(uint32_t Channel) { return Channel == TIM_CHANNEL_1 ? TIM_CCER_CC1E : Channel == TIM_CHANNEL_2 ? TIM_CCER_CC2E : (TIM_CCER_CC1E | TIM_CCER_CC2E); }
static HAL_StatusTypeDef tim_enc_start(TIM_HandleTypeDef *h, uint32_t Channel, int it)
{
  simtim_t *s = tim_of(h->Instance);
  if (!s) return HAL_ERROR;
  TIM_TypeDef *t = h->Instance;
  uint32_t e = enc_cce(Channel);
  t->CCER |= e;
  if (it) t->DIER |= ((e & TIM_CCER_CC1E) ? TIM_DIER_CC1IE : 0u) | ((e & TIM_CCER_CC2E) ? TIM_DIER_CC2IE : 0u);
  s->enc_ok = 0;
  t->CR1 |= TIM_CR1_CEN;
  return HAL_OK;
}
static HAL_StatusTypeDef tim_enc_stop(TIM_HandleTypeDef *h, uint32_t Channel, int it)
{
  TIM_TypeDef *t = h->Instance;
  uint32_t e = enc_cce(Channel);
  t->CCER &= ~e;
  if (it) t->DIER &= ~(((e & TIM_CCER_CC1E) ? TIM_DIER_CC1IE : 0u) | ((e & TIM_CCER_CC2E) ? TIM_DIER_CC2IE : 0u));
  tim_disable(t);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_Encoder_Start(TIM_HandleTypeDef *h, uint32_t c)    { return tim_enc_start(h, c, 0); }
HAL_StatusTypeDef HAL_TIM_Encoder_Stop(TIM_HandleTypeDef *h, uint32_t c)     { return tim_enc_stop(h, c, 0); }
HAL_StatusTypeDef HAL_TIM_Encoder_Start_IT(TIM_HandleTypeDef *h, uint32_t c) { return tim_enc_start(h, c, 1); }
HAL_StatusTypeDef HAL_TIM_Encoder_Stop_IT(TIM_HandleTypeDef *h, uint32_t c)  { return tim_enc_stop(h, c, 1); }

HAL_StatusTypeDef HAL_TIM_ConfigClockSource(TIM_HandleTypeDef *h, const TIM_ClockConfigTypeDef *c)
{
  if (c->ClockSource != TIM_CLOCKSOURCE_INTERNAL)
    WARN_ONCE(40, "Sorgente di clock esterna del timer non simulata: il timer usa il clock interno.");
  h->Instance->SMCR &= ~(TIM_SMCR_SMS | TIM_SMCR_TS | TIM_SMCR_ECE);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIMEx_MasterConfigSynchronization(TIM_HandleTypeDef *h, const TIM_MasterConfigTypeDef *c)
{
  h->Instance->CR2 = (h->Instance->CR2 & ~TIM_CR2_MMS) | c->MasterOutputTrigger;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIMEx_ConfigBreakDeadTime(TIM_HandleTypeDef *h, const TIM_BreakDeadTimeConfigTypeDef *c)
{
  h->Instance->BDTR = (h->Instance->BDTR & TIM_BDTR_MOE) | c->AutomaticOutput | c->DeadTime;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_TIM_GenerateEvent(TIM_HandleTypeDef *h, uint32_t src)
{
  h->Instance->EGR = src;
  simtim_t *s = tim_of(h->Instance);
  if (s) tim_process_egr(s);
  return HAL_OK;
}
uint32_t HAL_TIM_ReadCapturedValue(const TIM_HandleTypeDef *h, uint32_t Channel)
{
  int ch = (int)(Channel / 4u);
  return ch <= 3 ? (&h->Instance->CCR1)[ch] : 0;
}
HAL_TIM_StateTypeDef HAL_TIM_Base_GetState(const TIM_HandleTypeDef *h) { return h->State; }
HAL_TIM_StateTypeDef HAL_TIM_PWM_GetState(const TIM_HandleTypeDef *h)  { return h->State; }

void HAL_TIM_IRQHandler(TIM_HandleTypeDef *h)
{
  TIM_TypeDef *t = h->Instance;
  simtim_t *s = tim_of(t);
  if (!s) return;
  for (int ch = 0; ch < 4; ch++) {
    tim_sanitize(s);
    uint32_t f = TIM_SR_CC1IF << ch;
    if ((t->SR & f) && (t->DIER & (TIM_DIER_CC1IE << ch))) {
      t->SR &= ~f; s->sr_sh &= ~f;
      h->Channel = (HAL_TIM_ActiveChannel)(1u << ch);
      if (tim_ocm(s, ch) == 99) HAL_TIM_IC_CaptureCallback(h);
      else { HAL_TIM_OC_DelayElapsedCallback(h); HAL_TIM_PWM_PulseFinishedCallback(h); }
      h->Channel = HAL_TIM_ACTIVE_CHANNEL_CLEARED;
    }
  }
  tim_sanitize(s);
  if ((t->SR & TIM_SR_UIF) && (t->DIER & TIM_DIER_UIE)) {
    t->SR &= ~TIM_SR_UIF; s->sr_sh &= ~TIM_SR_UIF;
    HAL_TIM_PeriodElapsedCallback(h);
  }
  tim_sanitize(s);
  if ((t->SR & TIM_SR_TIF) && (t->DIER & TIM_DIER_TIE)) {
    t->SR &= ~TIM_SR_TIF; s->sr_sh &= ~TIM_SR_TIF;
    HAL_TIM_TriggerCallback(h);
  }
}

#endif /* HAL_TIM_MODULE_ENABLED */

/* ------------------------------------------------------------------ */
/* DMA (solo per completare i trasferimenti di UART e ADC)              */
#ifdef HAL_DMA_MODULE_ENABLED
typedef void (*dma_cb_t)(void *);
typedef struct { DMA_HandleTypeDef *hd; dma_cb_t cb; void *arg; int pending; } dmajob_t;
static dmajob_t djobs[8];

static int dma_irq(DMA_Stream_TypeDef *st)
{
  DMA_Stream_TypeDef *d1[8] = {DMA1_Stream0, DMA1_Stream1, DMA1_Stream2, DMA1_Stream3, DMA1_Stream4, DMA1_Stream5, DMA1_Stream6, DMA1_Stream7};
  DMA_Stream_TypeDef *d2[8] = {DMA2_Stream0, DMA2_Stream1, DMA2_Stream2, DMA2_Stream3, DMA2_Stream4, DMA2_Stream5, DMA2_Stream6, DMA2_Stream7};
  const int i1[8] = {DMA1_Stream0_IRQn, DMA1_Stream1_IRQn, DMA1_Stream2_IRQn, DMA1_Stream3_IRQn, DMA1_Stream4_IRQn, DMA1_Stream5_IRQn, DMA1_Stream6_IRQn, DMA1_Stream7_IRQn};
  const int i2[8] = {DMA2_Stream0_IRQn, DMA2_Stream1_IRQn, DMA2_Stream2_IRQn, DMA2_Stream3_IRQn, DMA2_Stream4_IRQn, DMA2_Stream5_IRQn, DMA2_Stream6_IRQn, DMA2_Stream7_IRQn};
  for (int i = 0; i < 8; i++) { if (st == d1[i]) return i1[i]; if (st == d2[i]) return i2[i]; }
  return -100;
}

/* completa un trasferimento DMA: passa dall'interrupt dello stream se c'è,
 * altrimenti chiama direttamente la callback (contesto interrupt) */
static void dma_complete(DMA_HandleTypeDef *hd, dma_cb_t cb, void *arg)
{
  int irq = hd ? dma_irq(hd->Instance) : -100;
  if (irq != -100 && irq_handler(irq)) {
    for (int i = 0; i < 8; i++) {
      if (!djobs[i].pending || (djobs[i].hd == hd && djobs[i].cb == cb)) {
        djobs[i] = (dmajob_t){hd, cb, arg, 1};
        pend_irq(irq);
        return;
      }
    }
  }
  cb(arg);
}

HAL_StatusTypeDef HAL_DMA_Init(DMA_HandleTypeDef *hd) { if (!hd) return HAL_ERROR; hd->State = HAL_DMA_STATE_READY; hd->Lock = HAL_UNLOCKED; return HAL_OK; }
HAL_StatusTypeDef HAL_DMA_DeInit(DMA_HandleTypeDef *hd) { if (!hd) return HAL_ERROR; hd->State = HAL_DMA_STATE_RESET; return HAL_OK; }
void HAL_DMA_IRQHandler(DMA_HandleTypeDef *hd)
{
  for (int i = 0; i < 8; i++)
    if (djobs[i].pending && djobs[i].hd == hd) { djobs[i].pending = 0; djobs[i].cb(djobs[i].arg); }
}

#else
typedef void (*dma_cb_t)(void *);
#define dma_complete(hd, cb, arg) (cb)(arg)
#endif /* HAL_DMA_MODULE_ENABLED */

/* ------------------------------------------------------------------ */
/* UART                                                                */
#ifdef HAL_UART_MODULE_ENABLED
typedef struct {
  USART_TypeDef *u;
  int num, irq, en_bit, apb2;
  UART_HandleTypeDef *h;
  int tx_mode;                 /* 0 libero, 1 IT, 2 DMA */
  uint64_t tx_done_ms;
  int tx_cplt;
  int rx_mode;                 /* 0 no, 1 IT, 2 DMA, 3 idle IT, 4 idle DMA */
  int rx_cplt, rx_event;
  uint8_t fifo[4096];
  uint32_t fh, ft;
} simuart_t;
static simuart_t uarts[3];

static simuart_t *uart_of(USART_TypeDef *u)
{
  for (int i = 0; i < 3; i++) if (uarts[i].u == u) return &uarts[i];
  return NULL;
}
static double uart_byte_us(UART_HandleTypeDef *h) { uint32_t b = h->Init.BaudRate ? h->Init.BaudRate : 115200u; return 10e6 / b; }

__weak void HAL_UART_MspInit(UART_HandleTypeDef *h) { (void)h; }
__weak void HAL_UART_MspDeInit(UART_HandleTypeDef *h) { (void)h; }
__weak void HAL_UART_TxCpltCallback(UART_HandleTypeDef *h) { (void)h; }
__weak void HAL_UART_TxHalfCpltCallback(UART_HandleTypeDef *h) { (void)h; }
__weak void HAL_UART_RxCpltCallback(UART_HandleTypeDef *h) { (void)h; }
__weak void HAL_UART_RxHalfCpltCallback(UART_HandleTypeDef *h) { (void)h; }
__weak void HAL_UART_ErrorCallback(UART_HandleTypeDef *h) { (void)h; }
#ifdef HAL_UART_RECEPTION_TOIDLE
__weak void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *h, uint16_t Size) { (void)h; (void)Size; }
#endif

HAL_StatusTypeDef HAL_UART_Init(UART_HandleTypeDef *h)
{
  if (!h) return HAL_ERROR;
  simuart_t *s = uart_of(h->Instance);
  if (!s) return HAL_ERROR;
  if (h->gState == HAL_UART_STATE_RESET) { h->Lock = HAL_UNLOCKED; HAL_UART_MspInit(h); }
  h->gState = HAL_UART_STATE_BUSY;
  uint32_t pclk = s->apb2 ? clk_pclk2() : clk_pclk1();
  if (h->Init.BaudRate) h->Instance->BRR = pclk / h->Init.BaudRate;
  emit("N %d %lu", s->num, (unsigned long)h->Init.BaudRate);   /* baud per il monitor seriale */
  h->Instance->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;
  h->ErrorCode = HAL_UART_ERROR_NONE;
  h->gState = HAL_UART_STATE_READY;
  h->RxState = HAL_UART_STATE_READY;
  s->h = h;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_UART_DeInit(UART_HandleTypeDef *h)
{
  h->gState = HAL_UART_STATE_BUSY;
  h->Instance->CR1 = 0;
  HAL_UART_MspDeInit(h);
  h->gState = HAL_UART_STATE_RESET;
  h->RxState = HAL_UART_STATE_RESET;
  return HAL_OK;
}

static int uart_can_send(simuart_t *s)
{
  volatile uint32_t *enr = s->apb2 ? &RCC->APB2ENR : &RCC->APB1ENR;
  if (!((*enr >> s->en_bit) & 1u)) { WARN_ONCE(50 + s->num, "USART%d usata senza clock abilitato: sulla scheda vera non trasmette.", s->num); return 0; }
  return 1;
}
static void uart_out(simuart_t *s, const uint8_t *p, uint16_t n)
{
  char pre[8];
  snprintf(pre, sizeof pre, "U %d", s->num);
  tx_add(pre, p, n);
}

HAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef *h, const uint8_t *pData, uint16_t Size, uint32_t Timeout)
{
  (void)Timeout;
  simuart_t *s = uart_of(h->Instance);
  if (!s || !pData || !Size) return HAL_ERROR;
  if (h->gState != HAL_UART_STATE_READY) return HAL_BUSY;
  if (!uart_can_send(s)) return HAL_TIMEOUT;
  h->gState = HAL_UART_STATE_BUSY_TX;
  uart_out(s, pData, Size);
  consume_us(Size * uart_byte_us(h));
  h->gState = HAL_UART_STATE_READY;
  return HAL_OK;
}
static HAL_StatusTypeDef uart_tx_async(UART_HandleTypeDef *h, const uint8_t *pData, uint16_t Size, int mode)
{
  simuart_t *s = uart_of(h->Instance);
  if (!s || !pData || !Size) return HAL_ERROR;
  if (h->gState != HAL_UART_STATE_READY) return HAL_BUSY;
  if (!uart_can_send(s)) return HAL_ERROR;
  h->gState = HAL_UART_STATE_BUSY_TX;
  h->pTxBuffPtr = (uint8_t *)pData; h->TxXferSize = Size; h->TxXferCount = 0;
  uart_out(s, pData, Size);
  s->tx_mode = mode;
  s->tx_done_ms = atomic_load(&sim_ms) + 1u + (uint64_t)(Size * uart_byte_us(h) / 1000.0);
  return HAL_OK;
}
HAL_StatusTypeDef HAL_UART_Transmit_IT(UART_HandleTypeDef *h, const uint8_t *p, uint16_t n)  { return uart_tx_async(h, p, n, 1); }
HAL_StatusTypeDef HAL_UART_Transmit_DMA(UART_HandleTypeDef *h, const uint8_t *p, uint16_t n) { return uart_tx_async(h, p, n, 2); }

static int fifo_count(simuart_t *s) { return (int)(s->fh - s->ft); }
static int fifo_pop(simuart_t *s) { if (s->fh == s->ft) return -1; return s->fifo[s->ft++ & 4095u]; }

HAL_StatusTypeDef HAL_UART_Receive(UART_HandleTypeDef *h, uint8_t *pData, uint16_t Size, uint32_t Timeout)
{
  simuart_t *s = uart_of(h->Instance);
  if (!s || !pData || !Size) return HAL_ERROR;
  if (h->RxState != HAL_UART_STATE_READY) return HAL_BUSY;
  h->RxState = HAL_UART_STATE_BUSY_RX;
  uint32_t start = HAL_GetTick();
  uint16_t got = 0;
  for (;;) {
    int c;
    while (got < Size && (c = fifo_pop(s)) >= 0) pData[got++] = (uint8_t)c;
    if (got == Size) break;
    if (Timeout != HAL_MAX_DELAY && (HAL_GetTick() - start) > Timeout) { h->RxState = HAL_UART_STATE_READY; return HAL_TIMEOUT; }
    wait_one_ms();
  }
  h->RxState = HAL_UART_STATE_READY;
  return HAL_OK;
}
static HAL_StatusTypeDef uart_rx_async(UART_HandleTypeDef *h, uint8_t *pData, uint16_t Size, int mode)
{
  simuart_t *s = uart_of(h->Instance);
  if (!s || !pData || !Size) return HAL_ERROR;
  if (h->RxState != HAL_UART_STATE_READY) return HAL_BUSY;
  h->RxState = HAL_UART_STATE_BUSY_RX;
  h->pRxBuffPtr = pData; h->RxXferSize = Size; h->RxXferCount = Size;
#ifdef HAL_UART_RECEPTION_TOIDLE
  h->ReceptionType = mode >= 3 ? HAL_UART_RECEPTION_TOIDLE : HAL_UART_RECEPTION_STANDARD;
#endif
  s->rx_mode = mode;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_UART_Receive_IT(UART_HandleTypeDef *h, uint8_t *p, uint16_t n)  { return uart_rx_async(h, p, n, 1); }
HAL_StatusTypeDef HAL_UART_Receive_DMA(UART_HandleTypeDef *h, uint8_t *p, uint16_t n) { return uart_rx_async(h, p, n, 2); }
#ifdef HAL_UART_RECEPTION_TOIDLE
HAL_StatusTypeDef HAL_UARTEx_ReceiveToIdle_IT(UART_HandleTypeDef *h, uint8_t *p, uint16_t n)  { return uart_rx_async(h, p, n, 3); }
HAL_StatusTypeDef HAL_UARTEx_ReceiveToIdle_DMA(UART_HandleTypeDef *h, uint8_t *p, uint16_t n) { return uart_rx_async(h, p, n, 4); }
#endif
HAL_StatusTypeDef HAL_UART_AbortReceive(UART_HandleTypeDef *h) { simuart_t *s = uart_of(h->Instance); if (s) s->rx_mode = 0; h->RxState = HAL_UART_STATE_READY; return HAL_OK; }
HAL_StatusTypeDef HAL_UART_AbortTransmit(UART_HandleTypeDef *h) { simuart_t *s = uart_of(h->Instance); if (s) s->tx_mode = 0; h->gState = HAL_UART_STATE_READY; return HAL_OK; }
HAL_StatusTypeDef HAL_UART_Abort(UART_HandleTypeDef *h) { HAL_UART_AbortReceive(h); return HAL_UART_AbortTransmit(h); }
HAL_StatusTypeDef HAL_UART_DMAStop(UART_HandleTypeDef *h) { return HAL_UART_Abort(h); }
HAL_UART_StateTypeDef HAL_UART_GetState(const UART_HandleTypeDef *h) { return (HAL_UART_StateTypeDef)(h->gState | h->RxState); }
uint32_t HAL_UART_GetError(const UART_HandleTypeDef *h) { return h->ErrorCode; }

static void uart_rx_done(void *arg)
{
  simuart_t *s = arg;
  UART_HandleTypeDef *h = s->h;
  if (!h) return;
  int ev = s->rx_event;
  s->rx_event = 0;
  h->RxState = HAL_UART_STATE_READY;
#ifdef HAL_UART_RECEPTION_TOIDLE
  if (ev) { HAL_UARTEx_RxEventCallback(h, (uint16_t)(h->RxXferSize - h->RxXferCount)); return; }
#endif
  (void)ev;
  HAL_UART_RxCpltCallback(h);
}
static void uart_tx_done(void *arg)
{
  simuart_t *s = arg;
  if (!s->h) return;
  s->h->gState = HAL_UART_STATE_READY;
  HAL_UART_TxCpltCallback(s->h);
}

void HAL_UART_IRQHandler(UART_HandleTypeDef *h)
{
  simuart_t *s = uart_of(h->Instance);
  if (!s) return;
  if (s->rx_cplt) { s->rx_cplt = 0; uart_rx_done(s); }
  if (s->tx_cplt) { s->tx_cplt = 0; uart_tx_done(s); }
}

static void uart_step(simuart_t *s)
{
  UART_HandleTypeDef *h = s->h;
  if (!h) return;
  if (s->tx_mode && atomic_load(&sim_ms) >= s->tx_done_ms) {
    int m = s->tx_mode;
    s->tx_mode = 0;
    if (m == 1) {
      s->tx_cplt = 1;
      pend_irq(s->irq);
      if (!irq_enabled(s->irq))
        WARN_ONCE(55 + s->num, "HAL_UART_Transmit_IT su USART%d ma l'interrupt USART%d non è abilitato nell'NVIC: la callback non arriverà mai.", s->num, s->num);
    } else dma_complete(h->hdmatx, uart_tx_done, s);
    deliver();
  }
  for (int guard = 0; guard < 64 && s->rx_mode && fifo_count(s) > 0; guard++) {
    int m = s->rx_mode;
    if ((m == 1 || m == 3) && !irq_enabled(s->irq)) {
      WARN_ONCE(60 + s->num, "Ricezione UART a interrupt su USART%d ma l'interrupt USART%d non è abilitato nell'NVIC: i caratteri non vengono letti.", s->num, s->num);
      break;
    }
    int c;
    while (h->RxXferCount > 0 && (c = fifo_pop(s)) >= 0) {
      h->pRxBuffPtr[h->RxXferSize - h->RxXferCount] = (uint8_t)c;
      h->RxXferCount--;
    }
    int done = h->RxXferCount == 0;
    int idle = (m >= 3) && fifo_count(s) == 0 && h->RxXferCount < h->RxXferSize;
    if (!done && !idle) break;
    s->rx_mode = 0;
    s->rx_event = m >= 3;
    if (m == 1 || m == 3) { s->rx_cplt = 1; pend_irq(s->irq); }
    else dma_complete(h->hdmarx, uart_rx_done, s);
    deliver();
  }
}

static void uart_step_all(void) { for (int i = 0; i < 3; i++) uart_step(&uarts[i]); }
static void uart_rx_push(int num, const uint8_t *d, int n)
{
  for (int k = 0; k < 3; k++) {
    simuart_t *s = &uarts[k];
    if (s->num != num) continue;
    for (int i = 0; i < n; i++) if (s->fh - s->ft < 4096u) s->fifo[s->fh++ & 4095u] = d[i];
  }
}
static void uart_init_all(void)
{
  uarts[0] = (simuart_t){.u = USART1, .num = 1, .irq = USART1_IRQn, .en_bit = 4, .apb2 = 1};
  uarts[1] = (simuart_t){.u = USART2, .num = 2, .irq = USART2_IRQn, .en_bit = 17, .apb2 = 0};
  uarts[2] = (simuart_t){.u = USART6, .num = 6, .irq = USART6_IRQn, .en_bit = 5, .apb2 = 1};
}
#else
static void uart_step_all(void) {}
static void uart_rx_push(int num, const uint8_t *d, int n) { (void)num; (void)d; (void)n; }
static void uart_init_all(void) {}
#endif /* HAL_UART_MODULE_ENABLED */

/* ------------------------------------------------------------------ */
/* ADC                                                                 */
static volatile uint16_t adc_in[20];
static const int8_t adc_pin[16][2] = {
  {0,0},{0,1},{0,2},{0,3},{0,4},{0,5},{0,6},{0,7},{1,0},{1,1},{2,0},{2,1},{2,2},{2,3},{2,4},{2,5}};

#ifdef HAL_ADC_MODULE_ENABLED
typedef struct {
  ADC_HandleTypeDef *h;
  uint8_t ranks[16];
  int idx, mode, eoc;          /* mode: 0 fermo, 1 polling, 2 IT, 3 DMA */
  uint32_t *dmabuf, dmalen;
} simadc_t;
static simadc_t adc1;

static uint32_t adc_value(int ch)
{
  uint32_t v;
  if (ch < 16) v = adc_in[ch];
  else if (ch == 16 || ch == 18) v = 943 + (ch == 18 ? 0 : 0);   /* sensore di temperatura ~25 °C */
  else if (ch == 17) v = 1502;                                   /* Vrefint 1,21 V */
  else v = 0;
  uint32_t res = (ADC1->CR1 >> 24) & 3u;
  return v >> (2u * res);
}
static int adc_nranks(ADC_HandleTypeDef *h)
{
  int n = h->Init.ScanConvMode ? (int)h->Init.NbrOfConversion : 1;
  return n < 1 ? 1 : n > 16 ? 16 : n;
}

__weak void HAL_ADC_MspInit(ADC_HandleTypeDef *h) { (void)h; }
__weak void HAL_ADC_MspDeInit(ADC_HandleTypeDef *h) { (void)h; }
__weak void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *h) { (void)h; }
__weak void HAL_ADC_ConvHalfCpltCallback(ADC_HandleTypeDef *h) { (void)h; }
__weak void HAL_ADC_ErrorCallback(ADC_HandleTypeDef *h) { (void)h; }

HAL_StatusTypeDef HAL_ADC_Init(ADC_HandleTypeDef *h)
{
  if (!h || h->Instance != ADC1) return HAL_ERROR;
  if (h->State == HAL_ADC_STATE_RESET) { h->Lock = HAL_UNLOCKED; h->ErrorCode = HAL_ADC_ERROR_NONE; HAL_ADC_MspInit(h); }
  ADC1->CR1 = (ADC1->CR1 & ~(ADC_CR1_RES | ADC_CR1_SCAN)) | h->Init.Resolution | (h->Init.ScanConvMode ? ADC_CR1_SCAN : 0u);
  ADC1->CR2 = (ADC1->CR2 & ~ADC_CR2_CONT) | (h->Init.ContinuousConvMode ? ADC_CR2_CONT : 0u);
  h->State = HAL_ADC_STATE_READY;
  adc1.h = h;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_ADC_DeInit(ADC_HandleTypeDef *h) { HAL_ADC_MspDeInit(h); h->State = HAL_ADC_STATE_RESET; return HAL_OK; }
HAL_StatusTypeDef HAL_ADC_ConfigChannel(ADC_HandleTypeDef *h, ADC_ChannelConfTypeDef *c)
{
  (void)h;
  if (c->Rank < 1 || c->Rank > 16) return HAL_ERROR;
  adc1.ranks[c->Rank - 1] = (uint8_t)c->Channel;
  if (c->Channel < 16) emit("A %u %d %d", (unsigned)c->Channel, adc_pin[c->Channel][0], adc_pin[c->Channel][1]);
  else emit("A %u -1 -1", (unsigned)c->Channel);
  return HAL_OK;
}
static void adc_convert(ADC_HandleTypeDef *h)
{
  int n = adc_nranks(h);
  if (adc1.idx >= n) adc1.idx = 0;
  ADC1->DR = adc_value(adc1.ranks[adc1.idx]);
  adc1.idx = (adc1.idx + 1) % n;
  ADC1->SR |= ADC_SR_EOC;
}
HAL_StatusTypeDef HAL_ADC_Start(ADC_HandleTypeDef *h)
{
  adc1.h = h; adc1.mode = 1; adc1.idx = 0;
  ADC1->CR2 |= ADC_CR2_ADON;
  h->State = HAL_ADC_STATE_REG_BUSY;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_ADC_Stop(ADC_HandleTypeDef *h) { adc1.mode = 0; h->State = HAL_ADC_STATE_READY; return HAL_OK; }
HAL_StatusTypeDef HAL_ADC_PollForConversion(ADC_HandleTypeDef *h, uint32_t Timeout)
{
  (void)Timeout;
  if (adc1.mode == 0) return HAL_ERROR;
  consume_us(1.0);
  adc_convert(h);
  h->State |= HAL_ADC_STATE_REG_EOC;
  return HAL_OK;
}
uint32_t HAL_ADC_GetValue(ADC_HandleTypeDef *h) { (void)h; ADC1->SR &= ~ADC_SR_EOC; return ADC1->DR; }
HAL_StatusTypeDef HAL_ADC_Start_IT(ADC_HandleTypeDef *h)
{
  adc1.h = h; adc1.mode = 2; adc1.idx = 0;
  ADC1->CR2 |= ADC_CR2_ADON;
  ADC1->CR1 |= ADC_CR1_EOCIE;
  h->State = HAL_ADC_STATE_REG_BUSY;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_ADC_Stop_IT(ADC_HandleTypeDef *h) { adc1.mode = 0; ADC1->CR1 &= ~ADC_CR1_EOCIE; h->State = HAL_ADC_STATE_READY; return HAL_OK; }
HAL_StatusTypeDef HAL_ADC_Start_DMA(ADC_HandleTypeDef *h, uint32_t *pData, uint32_t Length)
{
  adc1.h = h; adc1.mode = 3; adc1.idx = 0; adc1.dmabuf = pData; adc1.dmalen = Length;
  ADC1->CR2 |= ADC_CR2_ADON | ADC_CR2_DMA;
  h->State = HAL_ADC_STATE_REG_BUSY;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_ADC_Stop_DMA(ADC_HandleTypeDef *h) { adc1.mode = 0; ADC1->CR2 &= ~ADC_CR2_DMA; h->State = HAL_ADC_STATE_READY; return HAL_OK; }
void HAL_ADC_IRQHandler(ADC_HandleTypeDef *h)
{
  if (adc1.eoc) {
    adc1.eoc = 0;
    if (!(ADC1->CR2 & ADC_CR2_CONT)) h->State = HAL_ADC_STATE_READY;
    HAL_ADC_ConvCpltCallback(h);
  }
}
static void adc_dma_done(void *arg) { HAL_ADC_ConvCpltCallback((ADC_HandleTypeDef *)arg); }
static void adc_step(void)
{
  ADC_HandleTypeDef *h = adc1.h;
  if (!h || adc1.mode < 2) return;
  int cont = (ADC1->CR2 & ADC_CR2_CONT) != 0;
  if (adc1.mode == 2) {
    adc_convert(h);
    adc1.eoc = 1;
    pend_irq(ADC_IRQn);
    if (!irq_enabled(ADC_IRQn)) WARN_ONCE(70, "HAL_ADC_Start_IT ma l'interrupt ADC non è abilitato nell'NVIC: la callback non arriverà.");
    if (!cont) adc1.mode = 0;
  } else {
    int n = adc_nranks(h);
    int half = h->DMA_Handle && h->DMA_Handle->Init.MemDataAlignment == DMA_MDATAALIGN_HALFWORD;
    for (uint32_t i = 0; i < adc1.dmalen; i++) {
      uint32_t v = adc_value(adc1.ranks[i % (uint32_t)n]);
      if (half) ((uint16_t *)adc1.dmabuf)[i] = (uint16_t)v; else adc1.dmabuf[i] = v;
    }
    int circ = h->DMA_Handle && h->DMA_Handle->Init.Mode == DMA_CIRCULAR;
    if (!(cont && circ)) adc1.mode = 0;
    dma_complete(h->DMA_Handle, adc_dma_done, h);
  }
  deliver();
}
#else
static void adc_step(void) {}
#endif

/* ------------------------------------------------------------------ */
/* Core HAL, NVIC, SysTick, RCC                                        */
__weak void HAL_MspInit(void) {}
__weak void HAL_MspDeInit(void) {}

void HAL_NVIC_SetPriorityGrouping(uint32_t PriorityGroup) { NVIC_SetPriorityGrouping(PriorityGroup); }
void HAL_NVIC_SetPriority(IRQn_Type IRQn, uint32_t PreemptPriority, uint32_t SubPriority)
{
  NVIC_SetPriority(IRQn, NVIC_EncodePriority(NVIC_GetPriorityGrouping(), PreemptPriority, SubPriority));
}
void HAL_NVIC_EnableIRQ(IRQn_Type IRQn)  { sim_NVIC_EnableIRQ(IRQn); }
void HAL_NVIC_DisableIRQ(IRQn_Type IRQn) { sim_NVIC_DisableIRQ(IRQn); }
void HAL_NVIC_SystemReset(void) { sim_NVIC_SystemReset(); }
uint32_t HAL_SYSTICK_Config(uint32_t TicksNumb) { return SysTick_Config(TicksNumb); }
uint32_t HAL_NVIC_GetPriorityGrouping(void) { return NVIC_GetPriorityGrouping(); }
void HAL_NVIC_GetPriority(IRQn_Type IRQn, uint32_t PriorityGroup, uint32_t *pPreemptPriority, uint32_t *pSubPriority)
{ NVIC_DecodePriority(NVIC_GetPriority(IRQn), PriorityGroup, pPreemptPriority, pSubPriority); }
void HAL_NVIC_SetPendingIRQ(IRQn_Type IRQn) { pend_irq(IRQn); }
uint32_t HAL_NVIC_GetPendingIRQ(IRQn_Type IRQn) { return pend[IRQn + 16]; }
void HAL_NVIC_ClearPendingIRQ(IRQn_Type IRQn) { pend[IRQn + 16] = 0; }
uint32_t HAL_NVIC_GetActive(IRQn_Type IRQn) { (void)IRQn; return 0; }
void HAL_SYSTICK_CLKSourceConfig(uint32_t CLKSource)
{
  if (CLKSource == SYSTICK_CLKSOURCE_HCLK) SysTick->CTRL |= SysTick_CTRL_CLKSOURCE_Msk;
  else SysTick->CTRL &= ~SysTick_CTRL_CLKSOURCE_Msk;
}
__weak void HAL_SYSTICK_Callback(void) {}
void HAL_SYSTICK_IRQHandler(void) { HAL_SYSTICK_Callback(); }

__weak HAL_StatusTypeDef HAL_InitTick(uint32_t TickPriority)
{
  if (HAL_SYSTICK_Config(SystemCoreClock / (1000U / uwTickFreq)) > 0U) return HAL_ERROR;
  if (TickPriority < (1UL << __NVIC_PRIO_BITS)) {
    HAL_NVIC_SetPriority(SysTick_IRQn, TickPriority, 0U);
    uwTickPrio = TickPriority;
  } else return HAL_ERROR;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_Init(void)
{
  FLASH->ACR |= FLASH_ACR_ICEN | FLASH_ACR_DCEN | FLASH_ACR_PRFTEN;
  HAL_NVIC_SetPriorityGrouping(NVIC_PRIORITYGROUP_4);
  HAL_InitTick(TICK_INT_PRIORITY);
  HAL_MspInit();
  return HAL_OK;
}
HAL_StatusTypeDef HAL_DeInit(void) { HAL_MspDeInit(); return HAL_OK; }
__weak void HAL_IncTick(void) { uwTick += uwTickFreq; }
__weak uint32_t HAL_GetTick(void) { return uwTick; }
uint32_t HAL_GetTickPrio(void) { return uwTickPrio; }
HAL_StatusTypeDef HAL_SetTickFreq(HAL_TickFreqTypeDef Freq) { uwTickFreq = Freq; return HAL_InitTick(uwTickPrio); }
HAL_TickFreqTypeDef HAL_GetTickFreq(void) { return uwTickFreq; }
__weak void HAL_SuspendTick(void) { SysTick->CTRL &= ~SysTick_CTRL_TICKINT_Msk; }
__weak void HAL_ResumeTick(void)  { SysTick->CTRL |= SysTick_CTRL_TICKINT_Msk; }
uint32_t HAL_GetHalVersion(void) { return 0x01080300U; }
uint32_t HAL_GetREVID(void) { return 0x1000U; }
uint32_t HAL_GetDEVID(void) { return 0x433U; }
uint32_t HAL_GetUIDw0(void) { return 0x00360041U; }
uint32_t HAL_GetUIDw1(void) { return 0x3130510BU; }
uint32_t HAL_GetUIDw2(void) { return 0x33383838U; }

static int systick_can_preempt(void)
{
  return irq_enabled(SysTick_IRQn) && !primask && irq_preempt(SysTick_IRQn) < cur_preempt;
}

__weak void HAL_Delay(uint32_t Delay)
{
  uint32_t tickstart = HAL_GetTick();
  uint32_t wait = Delay;
  if (wait < HAL_MAX_DELAY) wait += (uint32_t)uwTickFreq;
  if (t_is_tick && !systick_can_preempt())
    WARN_ONCE(2, "HAL_Delay() chiamata dentro un interrupt che ha priorità uguale o più alta del SysTick: il contatore dei ms non avanza e sulla scheda vera il programma resta bloccato qui per sempre.");
  if (!t_is_tick && primask)
    WARN_ONCE(3, "HAL_Delay() con gli interrupt disabilitati (__disable_irq): il SysTick non conta e il programma resta bloccato.");
  while ((HAL_GetTick() - tickstart) < wait) wait_one_ms();
}

HAL_StatusTypeDef HAL_RCC_OscConfig(RCC_OscInitTypeDef *o)
{
  if (!o) return HAL_ERROR;
  if (o->OscillatorType & RCC_OSCILLATORTYPE_HSE) {
    if (o->HSEState == RCC_HSE_ON) RCC->CR |= RCC_CR_HSEON | RCC_CR_HSERDY;
    else if (o->HSEState == RCC_HSE_BYPASS) RCC->CR |= RCC_CR_HSEBYP | RCC_CR_HSEON | RCC_CR_HSERDY;
    else RCC->CR &= ~(RCC_CR_HSEON | RCC_CR_HSEBYP | RCC_CR_HSERDY);
  }
  if (o->OscillatorType & RCC_OSCILLATORTYPE_HSI) {
    if (o->HSIState == RCC_HSI_ON) RCC->CR |= RCC_CR_HSION | RCC_CR_HSIRDY;
    else RCC->CR &= ~(RCC_CR_HSION | RCC_CR_HSIRDY);
  }
  if (o->OscillatorType & RCC_OSCILLATORTYPE_LSI) {
    if (o->LSIState == RCC_LSI_ON) RCC->CSR |= RCC_CSR_LSION | RCC_CSR_LSIRDY; else RCC->CSR &= ~(RCC_CSR_LSION | RCC_CSR_LSIRDY);
  }
  if (o->OscillatorType & RCC_OSCILLATORTYPE_LSE) {
    if (o->LSEState != RCC_LSE_OFF) RCC->BDCR |= RCC_BDCR_LSEON | RCC_BDCR_LSERDY; else RCC->BDCR &= ~(RCC_BDCR_LSEON | RCC_BDCR_LSERDY);
  }
  if (o->PLL.PLLState == RCC_PLL_ON) {
    uint32_t src = o->PLL.PLLSource == RCC_PLLSOURCE_HSE ? HSE_VALUE : HSI_VALUE;
    if (o->PLL.PLLSource == RCC_PLLSOURCE_HSE && !(RCC->CR & RCC_CR_HSERDY)) return HAL_TIMEOUT;
    RCC->PLLCFGR = o->PLL.PLLSource | o->PLL.PLLM | (o->PLL.PLLN << 6) | (((o->PLL.PLLP >> 1) - 1u) << 16) | (o->PLL.PLLQ << 24);
    RCC->CR |= RCC_CR_PLLON | RCC_CR_PLLRDY;
    double vin = o->PLL.PLLM ? (double)src / o->PLL.PLLM : 0, vco = vin * o->PLL.PLLN;
    if (vin < 0.95e6 || vin > 2.1e6) WARN_ONCE(80, "PLL: l'ingresso del VCO (%.2f MHz) dovrebbe stare tra 1 e 2 MHz (controlla PLLM).", vin / 1e6);
    if (vco < 192e6 || vco > 432e6) WARN_ONCE(81, "PLL: il VCO (%.0f MHz) dovrebbe stare tra 192 e 432 MHz (controlla PLLN).", vco / 1e6);
  } else if (o->PLL.PLLState == RCC_PLL_OFF) {
    RCC->CR &= ~(RCC_CR_PLLON | RCC_CR_PLLRDY);
  }
  return HAL_OK;
}

HAL_StatusTypeDef HAL_RCC_ClockConfig(RCC_ClkInitTypeDef *c, uint32_t FLatency)
{
  if (!c) return HAL_ERROR;
  FLASH->ACR = (FLASH->ACR & ~FLASH_ACR_LATENCY) | FLatency;
  if (c->ClockType & RCC_CLOCKTYPE_HCLK) RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_HPRE) | c->AHBCLKDivider;
  if (c->ClockType & RCC_CLOCKTYPE_SYSCLK) {
    uint32_t sw = c->SYSCLKSource & 3u;
    if (sw == RCC_SYSCLKSOURCE_PLLCLK && !(RCC->CR & RCC_CR_PLLRDY)) return HAL_ERROR;
    if (sw == RCC_SYSCLKSOURCE_HSE && !(RCC->CR & RCC_CR_HSERDY)) return HAL_ERROR;
    RCC->CFGR = (RCC->CFGR & ~(RCC_CFGR_SW | RCC_CFGR_SWS)) | sw | (sw << 2);
  }
  if (c->ClockType & RCC_CLOCKTYPE_PCLK1) RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_PPRE1) | c->APB1CLKDivider;
  if (c->ClockType & RCC_CLOCKTYPE_PCLK2) RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_PPRE2) | (c->APB2CLKDivider << 3);
  SystemCoreClock = clk_hclk();
  uint32_t need = SystemCoreClock > 60000000u ? 2u : SystemCoreClock > 30000000u ? 1u : 0u;
  if (FLatency < need) WARN_ONCE(82, "Latenza della flash troppo bassa (%u WS) per %u MHz: servono almeno %u WS.", (unsigned)FLatency, (unsigned)(SystemCoreClock / 1000000u), (unsigned)need);
  if (clk_sysclk() > 84000000u) WARN_ONCE(83, "SYSCLK a %u MHz: supera il massimo dell'STM32F401 (84 MHz).", (unsigned)(clk_sysclk() / 1000000u));
  if (clk_pclk1() > 42000000u) WARN_ONCE(84, "PCLK1 a %u MHz: supera il massimo di APB1 (42 MHz).", (unsigned)(clk_pclk1() / 1000000u));
  HAL_InitTick(uwTickPrio);
  return HAL_OK;
}
uint32_t HAL_RCC_GetSysClockFreq(void) { return clk_sysclk(); }
uint32_t HAL_RCC_GetHCLKFreq(void) { SystemCoreClock = clk_hclk(); return SystemCoreClock; }
uint32_t HAL_RCC_GetPCLK1Freq(void) { return clk_pclk1(); }
uint32_t HAL_RCC_GetPCLK2Freq(void) { return clk_pclk2(); }

/* ------------------------------------------------------------------ */
/* Ingressi dal sito                                                   */
typedef struct { char type; int a, b, c; uint8_t data[256]; int n; } input_t;
static input_t inq[256];
static int inq_n;
static pthread_mutex_t inq_mx = PTHREAD_MUTEX_INITIALIZER;
/* ingressi a orario ("T d porta pin valore"): ognuno parte d ms dopo il precedente
 * (o al prossimo ms se la coda è vuota). Servono all'encoder: 4 fronti per scatto. */
typedef struct { uint64_t due; int p, pin, v; } sched_t;
static sched_t schq[1024];
static int schq_n;
static uint64_t sch_last;
static void sched_push(int d, int p, int pin, int v)
{
  pthread_mutex_lock(&inq_mx);
  uint64_t now = atomic_load(&sim_ms) + 1, due = sch_last + (uint64_t)(d < 1 ? 1 : d);
  if (due < now) due = now;
  if (schq_n < 1024) { schq[schq_n++] = (sched_t){due, p, pin, v}; sch_last = due; }
  pthread_mutex_unlock(&inq_mx);
}

static void process_inputs(void)
{
  input_t loc[256];
  int n;
  pthread_mutex_lock(&inq_mx);
  n = inq_n;
  memcpy(loc, inq, sizeof(input_t) * (size_t)n);
  inq_n = 0;
  uint64_t now = atomic_load(&sim_ms);
  int k = 0;
  for (int i = 0; i < schq_n; i++) {
    sched_t *q = &schq[i];
    if (q->due <= now) { if (q->p >= 0 && q->p < 8 && q->pin >= 0 && q->pin < 16) ext_in[q->p][q->pin] = (int8_t)q->v; }
    else schq[k++] = *q;
  }
  schq_n = k;
  pthread_mutex_unlock(&inq_mx);
  for (int i = 0; i < n; i++) {
    input_t *e = &loc[i];
    if (e->type == 'I' && e->a >= 0 && e->a < 8 && e->b >= 0 && e->b < 16) ext_in[e->a][e->b] = (int8_t)e->c;
    if (e->type == 'R') uart_rx_push(e->a, e->data, e->n);
  }
}

/* ------------------------------------------------------------------ */
/* Livelli dei pin, EXTI, eventi verso il sito                          */
/* Ingressi dei timer (canale in input capture o encoder, CCxS != 0): il pin in funzione
 * alternativa vale quello che c'è fuori (o il pull-up/pull-down), come in modo ingresso. */
static int tim_input_pin(int p, int pin, uint32_t af)
{
  for (size_t i = 0; i < sizeof tmap / sizeof tmap[0]; i++) {
    if (tmap[i][3] != p || tmap[i][4] != pin || tmap[i][2]) continue;
    simtim_t *s = &tims[tmap[i][0]];
    if (!s->t || (uint32_t)s->af != af) continue;
    int ch = tmap[i][1];
    uint32_t ccmr = ch < 2 ? s->t->CCMR1 : s->t->CCMR2;
    if ((ccmr >> ((ch & 1) * 8)) & 3u) return 1;
  }
  return 0;
}
/* livello del pin TIx del timer (canale ch = 0 → TI1, 1 → TI2), -1 se nessun pin è collegato */
static int tim_ti_level(simtim_t *s, int ch, const uint16_t *nl)
{
  int ti = (int)(s - tims);
  for (size_t i = 0; i < sizeof tmap / sizeof tmap[0]; i++) {
    if (tmap[i][0] != ti || tmap[i][1] != ch || tmap[i][2]) continue;
    int p = tmap[i][3], pin = tmap[i][4];
    GPIO_TypeDef *g = gp[p];
    if (!g || !port_clock_on(p) || ((g->MODER >> (2 * pin)) & 3u) != 2u) continue;
    if (((g->AFR[pin >> 3] >> ((pin & 7) * 4)) & 0xFu) != (uint32_t)s->af) continue;
    return (nl[p] >> pin) & 1;
  }
  return -1;
}
/* un passo dell'encoder: su o giù, con ritorno a capo su ARR e bit DIR in CR1 (RM0368 tab. 54) */
static void enc_count(simtim_t *s, int up)
{
  TIM_TypeDef *t = s->t;
  uint32_t arr = tim_arr(s), cnt = t->CNT, mask = s->bits32 ? 0xFFFFFFFFu : 0xFFFFu, upd = 0;
  if (up) { if (cnt == arr) { cnt = 0; upd = 1; } else cnt = (cnt + 1u) & mask; t->CR1 &= ~TIM_CR1_DIR; }
  else    { if (cnt == 0) { cnt = arr; upd = 1; } else cnt = (cnt - 1u) & mask; t->CR1 |= TIM_CR1_DIR; }
  t->CNT = cnt;
  if (upd && !(t->CR1 & TIM_CR1_UDIS)) { tim_setflag(s, TIM_SR_UIF); if (t->DIER & TIM_DIER_UIE) pend_irq(s->irq_up); }
}
static void enc_capture(simtim_t *s, int ch)
{
  TIM_TypeDef *t = s->t;
  if (!(t->CCER & (TIM_CCER_CC1E << (4 * ch)))) return;
  (&t->CCR1)[ch] = t->CNT;
  tim_setflag(s, TIM_SR_CC1IF << ch);
  if (t->DIER & (TIM_DIER_CC1IE << ch)) pend_irq(s->irq_cc);
}
/* Contatori in modalità encoder: fronti di TI1FP1 / TI2FP2 (dopo la polarità CCxP).
 * TI1: conta sui fronti di TI1, su se TI1FP1 != TI2FP2 dopo il fronte; TI2: su se uguali; TI12: tutti e due.
 * Il filtro IC (IC1F/IC2F, al massimo 8 campioni a fDTS/32 ≈ 3 µs a 84 MHz) qui non toglie niente:
 * il tempo simulato dei pin va a passi di 1 ms, quindi ogni cambio dura più del filtro. */
static void tim_encoder_edges(const uint16_t *nl)
{
  for (int i = 0; i < NTIM; i++) {
    simtim_t *s = &tims[i];
    TIM_TypeDef *t = s->t;
    if (!t) continue;
    unsigned sms = t->SMCR & TIM_SMCR_SMS;
    if (sms < 1u || sms > 3u || !tim_clock_on(s)) { s->enc_ok = 0; continue; }
    int r1 = tim_ti_level(s, 0, nl), r2 = tim_ti_level(s, 1, nl);
    int a = r1 < 0 ? s->enc_ti[0] : r1 ^ (int)((t->CCER >> 1) & 1u);
    int b = r2 < 0 ? s->enc_ti[1] : r2 ^ (int)((t->CCER >> 5) & 1u);
    if (!s->enc_ok) { s->enc_ti[0] = (uint8_t)a; s->enc_ti[1] = (uint8_t)b; s->enc_ok = 1; continue; }
    int on = (t->CR1 & TIM_CR1_CEN) != 0;
    if (a != s->enc_ti[0]) {
      s->enc_ti[0] = (uint8_t)a;
      if (on && (sms & 1u)) enc_count(s, a != s->enc_ti[1]);
      if (on && a) enc_capture(s, 0);
    }
    if (b != s->enc_ti[1]) {
      s->enc_ti[1] = (uint8_t)b;
      if (on && (sms & 2u)) enc_count(s, s->enc_ti[0] == b);
      if (on && b) enc_capture(s, 1);
    }
  }
}

static void update_pins(int detect_edges)
{
  uint16_t nl[8] = {0};
  for (int p = 0; p < 8; p++) {
    GPIO_TypeDef *g = gp[p];
    if (!g) continue;
    int clk = port_clock_on(p);
    uint32_t moder = clk ? g->MODER : gp_rst_moder[p];
    uint32_t pupdr = clk ? g->PUPDR : gp_rst_pupdr[p];
    uint32_t odr = clk ? g->ODR : 0, ot = clk ? g->OTYPER : 0;
    if (clk && g->BSRR) { uint32_t b = g->BSRR; g->BSRR = 0; g->ODR = (g->ODR & ~(b >> 16)) | (b & 0xFFFFu); odr = g->ODR; }
    uint16_t L = 0, analog = 0;
    for (int pin = 0; pin < 16; pin++) {
      int m = (moder >> (2 * pin)) & 3, pu = (pupdr >> (2 * pin)) & 3, e = ext_in[p][pin], v = 0;
      int duty = -1; double freq = 0;
      if (m == 1) {
        v = (odr >> pin) & 1;
        if (((ot >> pin) & 1) && v) v = e >= 0 ? e : 1;
      } else if (m == 0) {
        v = e >= 0 ? e : pu == 1 ? 1 : pu == 2 ? 0 : (board_pullup[p] >> pin) & 1;
      } else if (m == 2) {
        uint32_t af = (g->AFR[pin >> 3] >> ((pin & 7) * 4)) & 0xFu;
        if (tim_input_pin(p, pin, af)) v = e >= 0 ? e : pu == 1 ? 1 : pu == 2 ? 0 : (board_pullup[p] >> pin) & 1;
        else if (!pin_timer_output(p, pin, af, &v, &duty, &freq)) v = (af == 7 || af == 8) ? 1 : 0;
      } else analog |= (uint16_t)(1u << pin);
      if (v) L |= (uint16_t)(1u << pin);
      int f = (int)lround(freq);
      if (duty != pwm_emit_duty[p][pin] || (duty >= 0 && abs(f - pwm_emit_freq[p][pin]) > (pwm_emit_freq[p][pin] / 100 + 1))) {
        if (abs(duty - pwm_emit_duty[p][pin]) >= 3 || duty < 0 || pwm_emit_duty[p][pin] < 0 || f != pwm_emit_freq[p][pin]) {
          pwm_emit_duty[p][pin] = (int16_t)duty;
          pwm_emit_freq[p][pin] = f;
          emit("W %d %d %d %d %.4f", p, pin, duty, f, freq);   /* freq esatta: onda PWM nell'analizzatore */
        }
      }
    }
    nl[p] = L;
    g->IDR = clk ? (uint32_t)(L & ~analog) : 0;
  }
  static int first = 1;
  if (first) { first = 0; detect_edges = 0; }
  if (detect_edges) {
    for (int line = 0; line < 16; line++) {
      uint32_t bit = 1u << line;
      int p = (SYSCFG->EXTICR[line >> 2] >> ((line & 3) * 4)) & 0xF;
      if (p > 7 || !gp[p]) continue;
      int ov = (lvl[p] >> line) & 1, nv = (nl[p] >> line) & 1;
      if (ov != nv && (EXTI->IMR & bit)) {
        if ((nv && (EXTI->RTSR & bit)) || (!nv && (EXTI->FTSR & bit))) { EXTI->PR |= bit; pend_irq(exti_irq(line)); }
      }
    }
    if (EXTI->SWIER & EXTI->IMR) {
      for (int line = 0; line < 16; line++) if (EXTI->SWIER & EXTI->IMR & (1u << line)) { EXTI->PR |= 1u << line; pend_irq(exti_irq(line)); }
      EXTI->SWIER = 0;
    }
  }
  tim_encoder_edges(nl);
  memcpy(lvl, nl, sizeof lvl);
}

static void emit_changes(void)
{
  uint64_t ms = atomic_load(&sim_ms);
  for (int p = 0; p < 8; p++) {
    GPIO_TypeDef *g = gp[p];
    if (!g) continue;
    int clk = port_clock_on(p);
    uint32_t exti = 0, rt = 0, ft = 0;
    for (int line = 0; line < 16; line++) {
      if ((int)((SYSCFG->EXTICR[line >> 2] >> ((line & 3) * 4)) & 0xF) != p) continue;
      if (EXTI->IMR & (1u << line)) { exti |= 1u << line; if (EXTI->RTSR & (1u << line)) rt |= 1u << line; if (EXTI->FTSR & (1u << line)) ft |= 1u << line; }
    }
    uint32_t c[8] = {clk ? g->MODER : gp_rst_moder[p], clk ? g->PUPDR : gp_rst_pupdr[p], g->OTYPER, g->AFR[0], g->AFR[1], exti, rt, ft};
    if (memcmp(c, cfg_emitted[p], sizeof c) != 0 || !lvl_emitted_valid) {
      memcpy(cfg_emitted[p], c, sizeof c);
      emit("M %d %x %x %x %x %x %x %x %x", p, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
    }
    if (lvl[p] != lvl_emitted[p] || !lvl_emitted_valid) {
      lvl_emitted[p] = lvl[p];
      emit("C %llu %d %x", (unsigned long long)ms, p, lvl[p]);
    }
  }
  lvl_emitted_valid = 1;
  static uint32_t k_last[4];
  uint32_t k[4] = {clk_sysclk(), clk_hclk(), clk_pclk1(), clk_pclk2()};
  if (memcmp(k, k_last, sizeof k)) { memcpy(k_last, k, sizeof k); emit("K %u %u %u %u", k[0], k[1], k[2], k[3]); }
}

/* ------------------------------------------------------------------ */
/* Passo di simulazione: 1 ms                                          */
static double next_deadline;            /* ms (orologio della pagina) */
static void read_commands(void);
#ifdef SIM_DBG
static void dbg_comando(char *line);
#endif

/* tempo reale: se la simulazione è avanti, aspetta (Atomics.wait nel worker;
 * si sveglia subito se arriva un comando dalla pagina) */
static void pace(void)
{
  while (paused) { sv_sleep(20); read_commands(); next_deadline = sv_now(); }
  double sp = speed < 0.01 ? 0.01 : speed;
  next_deadline += 1.0 / sp;
  double n = sv_now();
  if (next_deadline > n + 2.0) sv_sleep(next_deadline - n);     /* attese di almeno 2 ms: meno risvegli */
  else if (n - next_deadline > 100.0) next_deadline = n;        /* troppo indietro (scheda in background): non recuperare */
}

static double systick_acc;
static void systick_step(void)
{
  uint32_t ctrl = SysTick->CTRL;
  if (!(ctrl & SysTick_CTRL_ENABLE_Msk)) return;
  uint32_t load = SysTick->LOAD & 0xFFFFFFu;
  if (!load) return;
  double clk = (ctrl & SysTick_CTRL_CLKSOURCE_Msk) ? clk_hclk() : clk_hclk() / 8.0;
  systick_acc += clk / 1000.0;
  uint64_t n = (uint64_t)(systick_acc / (load + 1.0));
  systick_acc -= (double)n * (load + 1.0);
  if (n) SysTick->CTRL |= SysTick_CTRL_COUNTFLAG_Msk;
  if (!(ctrl & SysTick_CTRL_TICKINT_Msk)) return;
  for (uint64_t k = 0; k < n && k < 200; k++) { pend_irq(SysTick_IRQn); deliver(); }
}

static void comm_tick(void);
static void sim_step(void)
{
  pace();
  int top = step_depth == 0;
  if (top) read_commands();
  step_depth++;
  atomic_fetch_add(&sim_ms, 1);

  if (RCC->CR & RCC_CR_HSEON) RCC->CR |= RCC_CR_HSERDY;
  if (RCC->CR & RCC_CR_HSION) RCC->CR |= RCC_CR_HSIRDY;
  if (RCC->CR & RCC_CR_PLLON) RCC->CR |= RCC_CR_PLLRDY;
  RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SWS) | ((RCC->CFGR & RCC_CFGR_SW) << 2);

  process_inputs();
  update_pins(1);
  deliver();
  systick_step();
  for (int i = 0; i < NTIM; i++) tim_step(&tims[i]);
  uart_step_all();
  adc_step();
  deliver();
  update_pins(1);
  deliver();
  devs_step();
  emit_changes();
  tx_flush();

  step_depth--;
  if (top) { comm_tick(); out_flush(); }
}

/* ------------------------------------------------------------------ */
/* Comunicazione con la pagina                                         */
/* Variabili osservate dal sito: rilette ~10 volte al secondo, si mandano
 * solo quelle cambiate ("Y id hex"). Nel WebAssembly gli indirizzi sono
 * della memoria lineare: si leggono direttamente. */
#define NWATCH 512
#define MEM_TOP 0x08000000u                /* oltre la memoria lineare: non leggere */
typedef struct { uint32_t addr; uint32_t size; int used; uint8_t last[512]; int have; } watch_t;
static watch_t watches[NWATCH];

static void watch_poll(void)
{
  static const char hx[] = "0123456789abcdef";
  uint32_t top = (uint32_t)__builtin_wasm_memory_size(0) * 65536u;
  for (int i = 0; i < NWATCH; i++) {
    watch_t *w = &watches[i];
    if (!w->used || w->addr < 4096 || w->addr + w->size > top) continue;
    const uint8_t *buf = (const uint8_t *)(uintptr_t)w->addr;
    if (w->have && memcmp(buf, w->last, w->size) == 0) continue;
    memcpy(w->last, buf, w->size);
    w->have = 1;
    char line[16 + 2 * 512 + 2];
    int o = snprintf(line, 16, "Y %d ", i);
    for (uint32_t k = 0; k < w->size; k++) { line[o++] = hx[buf[k] >> 4]; line[o++] = hx[buf[k] & 15]; }
    line[o++] = '\n';
    out_put(line, (uint32_t)o);
  }
}

/* stato per il sito (tempo, interrupt contati, variabili) a intervalli di tempo reale */
static void comm_tick(void)
{
  static double last_t, last_q, last_w;
  static uint64_t qprev[NIRQ];
  double n = sv_now();
  if (n - last_t > 50.0) {
    last_t = n;
    char b[96];
    int k = snprintf(b, sizeof b, "T %llu %u %d\n", (unsigned long long)atomic_load(&sim_ms), (unsigned)uwTick, primask);
    out_put(b, (uint32_t)k);
  }
  if (n - last_q > 250.0) {
    last_q = n;
    char b[2048];
    int k = 0, changed = 0;
    k += snprintf(b + k, sizeof b - (size_t)k, "Q");
    for (int i = 0; i < NIRQ; i++) {
      uint64_t c = irq_count[i];
      if (c != qprev[i]) changed = 1;
      qprev[i] = c;
      const char *nm = irq_name(i - 16);
      if (c && nm && k < (int)sizeof b - 64) k += snprintf(b + k, sizeof b - (size_t)k, " %s:%llu", nm, (unsigned long long)c);
    }
    b[k++] = '\n';
    if (changed) out_put(b, (uint32_t)k);
  }
  if (n - last_w > 100.0) { last_w = n; watch_poll(); }
}

static void init_tim(int i, TIM_TypeDef *t, const char *name, int apb2, int bits32, int en_bit, int af, int irq_up, int irq_cc)
{
  tims[i] = (simtim_t){.t = t, .name = name, .apb2 = apb2, .bits32 = bits32, .en_bit = en_bit, .af = af, .irq_up = irq_up, .irq_cc = irq_cc};
  t->ARR = bits32 ? 0xFFFFFFFFu : 0xFFFFu;
}

static void sim_init(void)
{
  /* i registri stanno nella zona fissa 0x700000–0x800000 della memoria lineare
   * (indirizzi riscritti negli header da build.js), già a zero all'avvio */

  gp[0] = GPIOA; gp[1] = GPIOB; gp[2] = GPIOC; gp[3] = GPIOD; gp[4] = GPIOE; gp[7] = GPIOH;
  for (int p = 0; p < 8; p++) {
    if (!gp[p]) continue;
    gp[p]->MODER = gp_rst_moder[p];
    gp[p]->PUPDR = gp_rst_pupdr[p];
    for (int i = 0; i < 16; i++) { ext_in[p][i] = -1; pwm_emit_duty[p][i] = -1; }
  }
  GPIOA->OSPEEDR = 0x0C000000u;
  GPIOB->OSPEEDR = 0x000000C0u;
  board_pullup[2] = 1u << 13;               /* B1: pull-up esterno su PC13 */

  RCC->CR = 0x00000083u;
  RCC->PLLCFGR = 0x24003010u;
  RCC->CSR = 0x0E000000u;
  *(volatile uint32_t *)&SCB->CPUID = 0x410FC241u;
  DBGMCU->IDCODE = 0x10006433u;
  *(volatile uint16_t *)FLASHSIZE_BASE = 512;
  ((volatile uint32_t *)UID_BASE)[0] = 0x00360041u;
  ((volatile uint32_t *)UID_BASE)[1] = 0x3130510Bu;
  ((volatile uint32_t *)UID_BASE)[2] = 0x33383838u;

  init_tim(0, TIM1, "TIM1", 1, 0, 0, 1, TIM1_UP_TIM10_IRQn, TIM1_CC_IRQn);
  init_tim(1, TIM2, "TIM2", 0, 1, 0, 1, TIM2_IRQn, TIM2_IRQn);
  init_tim(2, TIM3, "TIM3", 0, 0, 1, 2, TIM3_IRQn, TIM3_IRQn);
  init_tim(3, TIM4, "TIM4", 0, 0, 2, 2, TIM4_IRQn, TIM4_IRQn);
  init_tim(4, TIM5, "TIM5", 0, 1, 3, 2, TIM5_IRQn, TIM5_IRQn);
  init_tim(5, TIM9, "TIM9", 1, 0, 16, 3, TIM1_BRK_TIM9_IRQn, TIM1_BRK_TIM9_IRQn);
  init_tim(6, TIM10, "TIM10", 1, 0, 17, 3, TIM1_UP_TIM10_IRQn, TIM1_UP_TIM10_IRQn);
  init_tim(7, TIM11, "TIM11", 1, 0, 18, 3, TIM1_TRG_COM_TIM11_IRQn, TIM1_TRG_COM_TIM11_IRQn);

  uart_init_all();
  USART1->SR = USART2->SR = USART6->SR = USART_SR_TXE | USART_SR_TC;
}

static int hexval(int c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }

static void push_input(input_t *e)
{
  pthread_mutex_lock(&inq_mx);
  if (inq_n < 256) inq[inq_n++] = *e;
  pthread_mutex_unlock(&inq_mx);
}

/* una riga di comando dalla pagina (stesso protocollo della versione per Mac) */
static void handle_line(char *line)
{
  input_t e;
  memset(&e, 0, sizeof e);
  if (line[0] == 'I') {
    e.type = 'I';
    if (sscanf(line + 1, "%d %d %d", &e.a, &e.b, &e.c) == 3) push_input(&e);
  } else if (line[0] == 'V') {
    int ch, v;
    if (sscanf(line + 1, "%d %d", &ch, &v) == 2 && ch >= 0 && ch < 20) adc_in[ch] = (uint16_t)(v < 0 ? 0 : v > 4095 ? 4095 : v);
  } else if (line[0] == 'R') {
    char *p = line + 1;
    e.type = 'R';
    e.a = (int)strtol(p, &p, 10);
    while (*p == ' ') p++;
    while (hexval(p[0]) >= 0 && hexval(p[1]) >= 0) {
      e.data[e.n++] = (uint8_t)(hexval(p[0]) * 16 + hexval(p[1]));
      p += 2;
      if (e.n == 256) { push_input(&e); e.n = 0; }
    }
    if (e.n) push_input(&e);
  } else if (line[0] == 'T') {
    int d, p, pin, v;
    if (sscanf(line + 1, "%d %d %d %d", &d, &p, &pin, &v) == 4) sched_push(d, p, pin, v);
  } else if (line[0] == 'D') {
    devs_parse(line);
  } else if (line[0] == 'K') {
    int i; unsigned m;
    if (sscanf(line + 1, "%d %x", &i, &m) == 2 && i >= 0 && i < NDEV) key_mask[i] = (uint16_t)m;
  } else if (line[0] == 'S') {
    double s = atof(line + 1);
    if (s > 0) speed = s;
  } else if (line[0] == 'P') {
    paused = atoi(line + 1) != 0;
#ifdef SIM_DBG
  } else if (line[0] == 'B' || line[0] == 'Z') {
    dbg_comando(line);
#endif
  } else if (line[0] == 'G') {
    /* G <id> <addr hex> <size>   oppure   G -   (cancella tutto) */
    int id; unsigned addr; unsigned size;
    if (line[1] == ' ' && line[2] == '-') { for (int i = 0; i < NWATCH; i++) watches[i].used = 0; }
    else if (sscanf(line + 1, "%d %x %u", &id, &addr, &size) == 3 && id >= 0 && id < NWATCH) {
      watches[id].addr = addr;
      watches[id].size = size > 512 ? 512 : size;
      watches[id].have = 0;
      watches[id].used = size > 0;
    }
  }
}

/* comandi arrivati dalla pagina (righe separate da \n) */
static void read_commands(void)
{
  static char buf[8192];
  static uint32_t have;
  for (;;) {
    uint32_t got = sv_in(buf + have, (uint32_t)sizeof buf - 1 - have);
    if (!got) return;
    have += got;
    char *s = buf, *nl;
    while ((nl = memchr(s, '\n', (size_t)(buf + have - s)))) { *nl = 0; handle_line(s); s = nl + 1; }
    have = (uint32_t)(buf + have - s);
    memmove(buf, s, have);
    if (have == sizeof buf - 1) have = 0;      /* riga troppo lunga: scartata */
  }
}

#ifdef SIM_DBG
/* ------------------------------------------------------------------ */
/* Debug passo passo (fase 2, punto E). Il codice dell'utente è preparato da public/strumenta.js:
 * __svr(id) all'inizio di ogni istruzione (id = (file+1)·100000 + riga), __svl(...) dopo le dichiarazioni
 * delle variabili locali, __svg per le globali; __sve/__svx (cleanup) contano entrate e uscite delle funzioni.
 * Quando ci si deve fermare: righe "Y …" alla pagina (stop, stack, variabili) e attesa dei comandi
 * ("Z c|s|n|o|p", "B id id …") senza far avanzare il tempo simulato. */
#define DBG_MAXF 48
#define DBG_MAXL 40
#define DBG_MAXG 256
typedef struct { const char *nome; void *ind; uint32_t dim; char tipo; uint32_t elem; const char *tn; } dbgvar_t;
typedef struct { void *fn; uint32_t riga; int nloc; dbgvar_t loc[DBG_MAXL]; } dbgframe_t;
static dbgframe_t dbg_st[DBG_MAXF];
static int dbg_prof;
static dbgvar_t dbg_glob[DBG_MAXG];
static int dbg_nglob;
static struct { void *fn; const char *nome; } dbg_fun[512];
static int dbg_nfun;
static uint32_t dbg_bp[256];
static int dbg_nbp;
static volatile int dbg_modo = 1;          /* 0 corre, 1 entra (passo), 2 passo sopra, 3 esci, 4 pausa; all'avvio si ferma sulla prima riga */
static int dbg_rif, dbg_fermo, dbg_dentro;

/* Punto H: tipi per la pagina. Campi delle struct ("Y t tipo campo offset dim tipo elem tipocampo") registrati dal
 * codice dell'utente (__svt, dal costruttore di strumenta.js) e qui sotto quelli delle periferiche e degli handle della
 * HAL; valori degli enum ("Y n tipo nome valore"); periferiche come variabili da osservare ("Y v r …": GPIOA->ODR).
 * Si mandano alla prima fermata. "Z w indirizzo esadecimale" scrive una variabile da fermi (solo dentro una variabile
 * registrata) e rimanda lo stato; "B id*n" = breakpoint che si ferma dalla n-esima volta. */
#define DBG_MAXT 768
#define DBG_MAXN 256
typedef struct { const char *tipo, *campo; uint32_t off, dim; char t; uint32_t elem; const char *tn; } dbgcampo_t;
static dbgcampo_t dbg_campi[DBG_MAXT];
static int dbg_ncampi;
static struct { const char *tipo, *nome; long long v; } dbg_enum[DBG_MAXN];
static int dbg_nenum, dbg_tipi_mandati;
void __svt(const char *tipo, const char *campo, unsigned off, unsigned dim, int t, unsigned elem, const char *tn)
{
  for (int i = 0; i < dbg_ncampi; i++) if (!strcmp(dbg_campi[i].tipo, tipo) && !strcmp(dbg_campi[i].campo, campo)) return;
  if (dbg_ncampi < DBG_MAXT) { dbgcampo_t *c = &dbg_campi[dbg_ncampi++]; c->tipo = tipo; c->campo = campo; c->off = off; c->dim = dim; c->t = (char)t; c->elem = elem; c->tn = tn; }
}
void __svn(const char *tipo, const char *nome, long long v)
{
  for (int i = 0; i < dbg_nenum; i++) if (!strcmp(dbg_enum[i].tipo, tipo) && !strcmp(dbg_enum[i].nome, nome)) return;
  if (dbg_nenum < DBG_MAXN) { dbg_enum[dbg_nenum].tipo = tipo; dbg_enum[dbg_nenum].nome = nome; dbg_enum[dbg_nenum].v = v; dbg_nenum++; }
}
#define DBG_C(T, f, t, tn) __svt(#T, #f, (unsigned)offsetof(T, f), (unsigned)sizeof(((T *)0)->f), t, 0, tn)
#define DBG_CA(T, f, t, tn) __svt(#T, #f, (unsigned)offsetof(T, f), (unsigned)sizeof(((T *)0)->f), t, (unsigned)sizeof(((T *)0)->f[0]), tn)
static void dbg_tipi_hal(void)
{
  DBG_C(GPIO_TypeDef, MODER, 'u', ""); DBG_C(GPIO_TypeDef, OTYPER, 'u', ""); DBG_C(GPIO_TypeDef, OSPEEDR, 'u', ""); DBG_C(GPIO_TypeDef, PUPDR, 'u', "");
  DBG_C(GPIO_TypeDef, IDR, 'u', ""); DBG_C(GPIO_TypeDef, ODR, 'u', ""); DBG_C(GPIO_TypeDef, BSRR, 'u', ""); DBG_C(GPIO_TypeDef, LCKR, 'u', ""); DBG_CA(GPIO_TypeDef, AFR, 'u', "");
  DBG_C(TIM_TypeDef, CR1, 'u', ""); DBG_C(TIM_TypeDef, CR2, 'u', ""); DBG_C(TIM_TypeDef, SMCR, 'u', ""); DBG_C(TIM_TypeDef, DIER, 'u', ""); DBG_C(TIM_TypeDef, SR, 'u', "");
  DBG_C(TIM_TypeDef, EGR, 'u', ""); DBG_C(TIM_TypeDef, CCMR1, 'u', ""); DBG_C(TIM_TypeDef, CCMR2, 'u', ""); DBG_C(TIM_TypeDef, CCER, 'u', ""); DBG_C(TIM_TypeDef, CNT, 'u', "");
  DBG_C(TIM_TypeDef, PSC, 'u', ""); DBG_C(TIM_TypeDef, ARR, 'u', ""); DBG_C(TIM_TypeDef, RCR, 'u', ""); DBG_C(TIM_TypeDef, CCR1, 'u', ""); DBG_C(TIM_TypeDef, CCR2, 'u', "");
  DBG_C(TIM_TypeDef, CCR3, 'u', ""); DBG_C(TIM_TypeDef, CCR4, 'u', ""); DBG_C(TIM_TypeDef, BDTR, 'u', "");
  DBG_C(USART_TypeDef, SR, 'u', ""); DBG_C(USART_TypeDef, DR, 'u', ""); DBG_C(USART_TypeDef, BRR, 'u', ""); DBG_C(USART_TypeDef, CR1, 'u', ""); DBG_C(USART_TypeDef, CR2, 'u', ""); DBG_C(USART_TypeDef, CR3, 'u', "");
  DBG_C(ADC_TypeDef, SR, 'u', ""); DBG_C(ADC_TypeDef, CR1, 'u', ""); DBG_C(ADC_TypeDef, CR2, 'u', ""); DBG_C(ADC_TypeDef, SQR1, 'u', ""); DBG_C(ADC_TypeDef, SQR3, 'u', ""); DBG_C(ADC_TypeDef, DR, 'u', "");
#ifdef HAL_TIM_MODULE_ENABLED
  DBG_C(TIM_HandleTypeDef, Instance, 'p', "TIM_TypeDef"); DBG_C(TIM_HandleTypeDef, Init, 's', "TIM_Base_InitTypeDef"); DBG_C(TIM_HandleTypeDef, Channel, 'u', ""); DBG_C(TIM_HandleTypeDef, State, 'u', "");
  DBG_C(TIM_Base_InitTypeDef, Prescaler, 'u', ""); DBG_C(TIM_Base_InitTypeDef, CounterMode, 'u', ""); DBG_C(TIM_Base_InitTypeDef, Period, 'u', ""); DBG_C(TIM_Base_InitTypeDef, ClockDivision, 'u', ""); DBG_C(TIM_Base_InitTypeDef, AutoReloadPreload, 'u', "");
#endif
#ifdef HAL_UART_MODULE_ENABLED
  DBG_C(UART_HandleTypeDef, Instance, 'p', "USART_TypeDef"); DBG_C(UART_HandleTypeDef, Init, 's', "UART_InitTypeDef"); DBG_C(UART_HandleTypeDef, TxXferCount, 'u', ""); DBG_C(UART_HandleTypeDef, RxXferCount, 'u', ""); DBG_C(UART_HandleTypeDef, gState, 'u', "");
  DBG_C(UART_InitTypeDef, BaudRate, 'u', ""); DBG_C(UART_InitTypeDef, WordLength, 'u', ""); DBG_C(UART_InitTypeDef, StopBits, 'u', ""); DBG_C(UART_InitTypeDef, Parity, 'u', ""); DBG_C(UART_InitTypeDef, Mode, 'u', "");
#endif
#ifdef HAL_ADC_MODULE_ENABLED
  DBG_C(ADC_HandleTypeDef, Instance, 'p', "ADC_TypeDef"); DBG_C(ADC_HandleTypeDef, State, 'u', "");
#endif
}
/* periferiche come variabili da osservare (non nell'elenco dei globali): "GPIOA", "TIM3", … */
static const struct { const char *nome; uintptr_t ind; uint32_t dim; const char *tn; } dbg_perif[] = {
  {"GPIOA", (uintptr_t)GPIOA, sizeof(GPIO_TypeDef), "GPIO_TypeDef"}, {"GPIOB", (uintptr_t)GPIOB, sizeof(GPIO_TypeDef), "GPIO_TypeDef"},
  {"GPIOC", (uintptr_t)GPIOC, sizeof(GPIO_TypeDef), "GPIO_TypeDef"}, {"GPIOD", (uintptr_t)GPIOD, sizeof(GPIO_TypeDef), "GPIO_TypeDef"},
  {"GPIOE", (uintptr_t)GPIOE, sizeof(GPIO_TypeDef), "GPIO_TypeDef"}, {"GPIOH", (uintptr_t)GPIOH, sizeof(GPIO_TypeDef), "GPIO_TypeDef"},
  {"TIM1", (uintptr_t)TIM1, sizeof(TIM_TypeDef), "TIM_TypeDef"}, {"TIM2", (uintptr_t)TIM2, sizeof(TIM_TypeDef), "TIM_TypeDef"},
  {"TIM3", (uintptr_t)TIM3, sizeof(TIM_TypeDef), "TIM_TypeDef"}, {"TIM4", (uintptr_t)TIM4, sizeof(TIM_TypeDef), "TIM_TypeDef"},
  {"TIM5", (uintptr_t)TIM5, sizeof(TIM_TypeDef), "TIM_TypeDef"}, {"TIM9", (uintptr_t)TIM9, sizeof(TIM_TypeDef), "TIM_TypeDef"},
  {"TIM10", (uintptr_t)TIM10, sizeof(TIM_TypeDef), "TIM_TypeDef"}, {"TIM11", (uintptr_t)TIM11, sizeof(TIM_TypeDef), "TIM_TypeDef"},
  {"USART1", (uintptr_t)USART1, sizeof(USART_TypeDef), "USART_TypeDef"}, {"USART2", (uintptr_t)USART2, sizeof(USART_TypeDef), "USART_TypeDef"},
  {"USART6", (uintptr_t)USART6, sizeof(USART_TypeDef), "USART_TypeDef"}, {"ADC1", (uintptr_t)ADC1, sizeof(ADC_TypeDef), "ADC_TypeDef"},
};
static uint32_t dbg_bpn[256], dbg_bpc[256];   /* "B id*n": si ferma dalla n-esima volta (contate da quando arriva B) */
static volatile int dbg_ridump;
void __svf(void *fn, const char *nome) { if (dbg_nfun < 512) { dbg_fun[dbg_nfun].fn = fn; dbg_fun[dbg_nfun].nome = nome; dbg_nfun++; } }
void __svg(const char *nome, void *ind, unsigned dim, int tipo, unsigned elem, const char *tn)
{ if (dbg_nglob < DBG_MAXG) { dbgvar_t *v = &dbg_glob[dbg_nglob++]; v->nome = nome; v->ind = ind; v->dim = dim; v->tipo = (char)tipo; v->elem = elem; v->tn = tn; } }
void __svl(const char *nome, void *ind, unsigned dim, int tipo, unsigned elem, const char *tn)
{
  if (dbg_prof < 1 || dbg_prof > DBG_MAXF) return;
  dbgframe_t *f = &dbg_st[dbg_prof - 1];
  int i;
  for (i = 0; i < f->nloc && strcmp(f->loc[i].nome, nome) != 0; i++) ;
  if (i == f->nloc) { if (f->nloc >= DBG_MAXL) return; f->nloc++; }
  dbgvar_t *v = &f->loc[i]; v->nome = nome; v->ind = ind; v->dim = dim; v->tipo = (char)tipo; v->elem = elem; v->tn = tn;
}
/* entrata in una funzione dell'utente (la registra per il nome) e uscita, con __attribute__((cleanup)) */
int __sve(void *fn, const char *nome)
{
  int k;
  for (k = 0; k < dbg_nfun && dbg_fun[k].fn != fn; k++) ;
  if (k == dbg_nfun) __svf(fn, nome);
  if (dbg_prof < DBG_MAXF) { dbg_st[dbg_prof].fn = fn; dbg_st[dbg_prof].riga = 0; dbg_st[dbg_prof].nloc = 0; }
  dbg_prof++;
  return 0;
}
void __svx(int *k) { (void)k; if (dbg_prof > 0) dbg_prof--; }

static const char *dbg_nome(void *fn)
{
  for (int i = 0; i < dbg_nfun; i++) if (dbg_fun[i].fn == fn) return dbg_fun[i].nome;
  return "?";
}
static void dbg_var(const char *dove, int f, const dbgvar_t *v)
{
  static const char hx[] = "0123456789abcdef";
  char b[700];
  uint32_t n = v->dim > 256 ? 256 : v->dim;
  int o = snprintf(b, 200, "Y v %s %d %s %c %u %u %lu %s ", dove, f, v->nome, v->tipo ? v->tipo : 's', (unsigned)v->elem, (unsigned)v->dim, (unsigned long)(uintptr_t)v->ind, v->tn && v->tn[0] ? v->tn : "-");
  const uint8_t *p = (const uint8_t *)v->ind;
  for (uint32_t i = 0; i < n; i++) { b[o++] = hx[p[i] >> 4]; b[o++] = hx[p[i] & 15]; }
  b[o] = 0;
  emit("%s", b);
}
static void dbg_stato(uint32_t id, const char *perche)
{
  int nf = dbg_prof > DBG_MAXF ? DBG_MAXF : dbg_prof;
  if (!dbg_tipi_mandati) {
    dbg_tipi_mandati = 1;
    dbg_tipi_hal();
    for (int i = 0; i < dbg_ncampi; i++) { const dbgcampo_t *c = &dbg_campi[i]; emit("Y t %s %s %u %u %c %u %s", c->tipo, c->campo, (unsigned)c->off, (unsigned)c->dim, c->t, (unsigned)c->elem, c->tn && c->tn[0] ? c->tn : "-"); }
    for (int i = 0; i < dbg_nenum; i++) emit("Y n %s %s %lld", dbg_enum[i].tipo, dbg_enum[i].nome, dbg_enum[i].v);
  }
  emit("Y stop %u %s %d", (unsigned)id, perche, dbg_prof);
  for (int i = nf - 1; i >= 0; i--) emit("Y f %d %s %u", i, dbg_nome(dbg_st[i].fn), (unsigned)dbg_st[i].riga);
  for (int i = nf - 1; i >= 0; i--) for (int j = 0; j < dbg_st[i].nloc; j++) dbg_var("l", i, &dbg_st[i].loc[j]);
  for (int j = 0; j < dbg_nglob; j++) dbg_var("g", 0, &dbg_glob[j]);
  for (unsigned j = 0; j < sizeof dbg_perif / sizeof dbg_perif[0]; j++) { dbgvar_t v = { dbg_perif[j].nome, (void *)dbg_perif[j].ind, dbg_perif[j].dim, 's', 0, dbg_perif[j].tn }; dbg_var("r", 0, &v); }
  emit("Y fine");
  out_flush();
}
static void dbg_ferma(uint32_t id, const char *perche)
{
  dbg_stato(id, perche);
  dbg_fermo = 1;
  while (dbg_fermo) { sv_sleep(25); read_commands(); if (dbg_ridump) { dbg_ridump = 0; dbg_stato(id, perche); } }
  next_deadline = sv_now();
  emit("Y via");
}
void __svr(unsigned id)
{
  if (dbg_prof > 0 && dbg_prof <= DBG_MAXF) dbg_st[dbg_prof - 1].riga = id;
  if (dbg_dentro) return;
  int stop = 0;
  switch (dbg_modo) {
    case 1: case 4: stop = 1; break;
    case 2: stop = dbg_prof <= dbg_rif; break;
    case 3: stop = dbg_prof < dbg_rif; break;
  }
  if (!stop) for (int i = 0; i < dbg_nbp; i++) if (dbg_bp[i] == id) { if (++dbg_bpc[i] >= dbg_bpn[i]) stop = 2; break; }
  if (!stop) return;
  dbg_dentro = 1;
  dbg_ferma(id, stop == 2 ? "bp" : dbg_modo == 4 ? "pausa" : "passo");
  dbg_dentro = 0;
}
/* comandi del debug dalla pagina */
static void dbg_comando(char *line)
{
  if (line[0] == 'B') {
    char *p = line + 1;
    dbg_nbp = 0;
    while (*p && dbg_nbp < 256) {
      while (*p == ' ') p++;
      if (!*p) break;
      dbg_bp[dbg_nbp] = (uint32_t)strtoul(p, &p, 10);
      dbg_bpn[dbg_nbp] = *p == '*' ? (uint32_t)strtoul(p + 1, &p, 10) : 1;
      dbg_bpc[dbg_nbp] = 0;
      dbg_nbp++;
      while (*p && *p != ' ') p++;
    }
  } else if (line[0] == 'Z' && line[2] == 'w') {
    /* scrive i byte solo se stanno tutti dentro una variabile registrata (globale, locale o periferica) */
    char *p = line + 3;
    uintptr_t a = (uintptr_t)strtoul(p, &p, 10);
    while (*p == ' ') p++;
    uint8_t buf[16]; uint32_t n = 0;
    while (n < 16 && isxdigit((unsigned char)p[0]) && isxdigit((unsigned char)p[1])) { char h[3] = { p[0], p[1], 0 }; buf[n++] = (uint8_t)strtoul(h, NULL, 16); p += 2; }
    int ok = 0;
    const dbgvar_t *vv[DBG_MAXG + DBG_MAXF * DBG_MAXL]; int nv = 0;
    for (int j = 0; j < dbg_nglob; j++) vv[nv++] = &dbg_glob[j];
    for (int i = 0; i < dbg_prof && i < DBG_MAXF; i++) for (int j = 0; j < dbg_st[i].nloc; j++) vv[nv++] = &dbg_st[i].loc[j];
    for (int j = 0; j < nv && !ok; j++) { uintptr_t b = (uintptr_t)vv[j]->ind; if (a >= b && a + n <= b + vv[j]->dim) ok = 1; }
    for (unsigned j = 0; j < sizeof dbg_perif / sizeof dbg_perif[0] && !ok; j++) if (a >= dbg_perif[j].ind && a + n <= dbg_perif[j].ind + dbg_perif[j].dim) ok = 1;
    if (ok && n) { memcpy((void *)a, buf, n); dbg_ridump = 1; }
    else emit("L Non scrivo: l'indirizzo non è dentro una variabile");
  } else if (line[0] == 'Z') {
    char c = line[2];
    if (c == 'c') { dbg_modo = 0; dbg_fermo = 0; }
    else if (c == 's') { dbg_modo = 1; dbg_fermo = 0; }
    else if (c == 'n') { dbg_modo = 2; dbg_rif = dbg_prof; dbg_fermo = 0; }
    else if (c == 'o') { dbg_modo = 3; dbg_rif = dbg_prof; dbg_fermo = 0; }
    else if (c == 'p') { if (!dbg_fermo) dbg_modo = 4; }
  }
}
#endif

int main(void)
{
  sim_init();
  emit("H 0");
  emit("L Scheda virtuale NUCLEO-F401RE pronta");
  next_deadline = sv_now();
  read_commands();                      /* dispositivi e velocità prima di partire */
  out_flush();
  cpu_alive = 1;
  user_main();
  emit("X main() è terminato: sulla scheda vera il micro resta fermo in un ciclo infinito.");
  for (;;) main_wait_tick();
}

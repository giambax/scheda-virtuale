/* Incluso automaticamente (-include) prima di ogni file del progetto.
 * - ogni giro di while/for "consuma" tempo di CPU simulato (così un while(1)
 *   vuoto non occupa tutta la CPU e i cicli di ritardo durano circa come sulla scheda)
 * - printf/puts/putchar passano dal simulatore (come la libc della scheda). */
#ifndef SIM_PRE_H
#define SIM_PRE_H
/* __weak della HAL (come in GCC) */
#undef __weak
#define __weak __attribute__((weak))
/* le intestazioni della libc vanno lette prima delle macro qui sotto,
 * altrimenti le loro dichiarazioni verrebbero riscritte */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int __sim_loop(const char *func);
int sim_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
int sim_puts(const char *s);
int sim_putchar(int c);

#define while(...) while (__sim_loop(__func__) && (__VA_ARGS__))
#define for(...)   for (__VA_ARGS__) if (!__sim_loop(__func__)) {} else
#define printf(...)  sim_printf(__VA_ARGS__)
#define puts(s)      sim_puts(s)
#define putchar(c)   sim_putchar(c)
#endif

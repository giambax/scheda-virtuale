/* cmsis_gcc.h per la Scheda Virtuale: sostituisce le istruzioni ARM (asm)
 * con funzioni del simulatore, così il codice CubeIDE compila sul Mac. */
#ifndef __CMSIS_GCC_H
#define __CMSIS_GCC_H
#include <stdint.h>

#ifndef   __ASM
  #define __ASM                                  __asm
#endif
#ifndef   __INLINE
  #define __INLINE                               inline
#endif
#ifndef   __STATIC_INLINE
  #define __STATIC_INLINE                        static inline
#endif
#ifndef   __STATIC_FORCEINLINE
  #define __STATIC_FORCEINLINE                   __attribute__((always_inline)) static inline
#endif
#ifndef   __NO_RETURN
  #define __NO_RETURN                            __attribute__((__noreturn__))
#endif
#ifndef   __USED
  #define __USED                                 __attribute__((used))
#endif
#ifndef   __WEAK
  #define __WEAK                                 __attribute__((weak))
#endif
#ifndef   __PACKED
  #define __PACKED                               __attribute__((packed, aligned(1)))
#endif
#ifndef   __PACKED_STRUCT
  #define __PACKED_STRUCT                        struct __attribute__((packed, aligned(1)))
#endif
#ifndef   __PACKED_UNION
  #define __PACKED_UNION                         union __attribute__((packed, aligned(1)))
#endif
#ifndef   __UNALIGNED_UINT32
  #define __UNALIGNED_UINT32(x)                  (*((uint32_t *)(x)))
#endif
#ifndef   __UNALIGNED_UINT16_WRITE
  #define __UNALIGNED_UINT16_WRITE(addr, val)    (void)((*((uint16_t *)(addr))) = (val))
#endif
#ifndef   __UNALIGNED_UINT16_READ
  #define __UNALIGNED_UINT16_READ(addr)          (*((const uint16_t *)(addr)))
#endif
#ifndef   __UNALIGNED_UINT32_WRITE
  #define __UNALIGNED_UINT32_WRITE(addr, val)    (void)((*((uint32_t *)(addr))) = (val))
#endif
#ifndef   __UNALIGNED_UINT32_READ
  #define __UNALIGNED_UINT32_READ(addr)          (*((const uint32_t *)(addr)))
#endif
#ifndef   __ALIGNED
  #define __ALIGNED(x)                           __attribute__((aligned(x)))
#endif
#ifndef   __RESTRICT
  #define __RESTRICT                             __restrict
#endif
#ifndef   __COMPILER_BARRIER
  #define __COMPILER_BARRIER()                   __asm volatile("":::"memory")
#endif
#ifndef __PROGRAM_START
#define __PROGRAM_START main
#endif

/* Funzioni fornite da sim_hal.c */
void     sim_enable_irq(void);
void     sim_disable_irq(void);
uint32_t sim_get_primask(void);
void     sim_set_primask(uint32_t v);
void     sim_wfi(void);
void     sim_nop(void);

__STATIC_FORCEINLINE void __enable_irq(void)  { sim_enable_irq(); }
__STATIC_FORCEINLINE void __disable_irq(void) { sim_disable_irq(); }
__STATIC_FORCEINLINE uint32_t __get_PRIMASK(void) { return sim_get_primask(); }
__STATIC_FORCEINLINE void __set_PRIMASK(uint32_t p) { sim_set_primask(p); }
__STATIC_FORCEINLINE void __enable_fault_irq(void) {}
__STATIC_FORCEINLINE void __disable_fault_irq(void) {}
__STATIC_FORCEINLINE uint32_t __get_CONTROL(void) { return 0; }
__STATIC_FORCEINLINE void __set_CONTROL(uint32_t c) { (void)c; }
__STATIC_FORCEINLINE uint32_t __get_IPSR(void) { return 0; }
__STATIC_FORCEINLINE uint32_t __get_APSR(void) { return 0; }
__STATIC_FORCEINLINE uint32_t __get_xPSR(void) { return 0x01000000; }
__STATIC_FORCEINLINE uint32_t __get_PSP(void) { return 0; }
__STATIC_FORCEINLINE void __set_PSP(uint32_t v) { (void)v; }
__STATIC_FORCEINLINE uint32_t __get_MSP(void) { return 0x20018000; }
__STATIC_FORCEINLINE void __set_MSP(uint32_t v) { (void)v; }
__STATIC_FORCEINLINE uint32_t __get_BASEPRI(void) { return 0; }
__STATIC_FORCEINLINE void __set_BASEPRI(uint32_t v) { (void)v; }
__STATIC_FORCEINLINE void __set_BASEPRI_MAX(uint32_t v) { (void)v; }
__STATIC_FORCEINLINE uint32_t __get_FAULTMASK(void) { return 0; }
__STATIC_FORCEINLINE void __set_FAULTMASK(uint32_t v) { (void)v; }
__STATIC_FORCEINLINE uint32_t __get_FPSCR(void) { return 0; }
__STATIC_FORCEINLINE void __set_FPSCR(uint32_t v) { (void)v; }

#define __NOP()   sim_nop()
#define __WFI()   sim_wfi()
#define __WFE()   sim_wfi()
#define __SEV()   ((void)0)
#define __ISB()   __COMPILER_BARRIER()
#define __DSB()   __COMPILER_BARRIER()
#define __DMB()   __COMPILER_BARRIER()
#define __BKPT(v) ((void)0)

__STATIC_FORCEINLINE uint32_t __REV(uint32_t v) { return __builtin_bswap32(v); }
__STATIC_FORCEINLINE uint32_t __REV16(uint32_t v) { return ((v & 0xFF00FF00u) >> 8) | ((v & 0x00FF00FFu) << 8); }
__STATIC_FORCEINLINE int16_t __REVSH(int16_t v) { return (int16_t)__builtin_bswap16((uint16_t)v); }
__STATIC_FORCEINLINE uint32_t __ROR(uint32_t op1, uint32_t op2) { op2 %= 32U; if (op2 == 0U) return op1; return (op1 >> op2) | (op1 << (32U - op2)); }
__STATIC_FORCEINLINE uint32_t __RBIT(uint32_t v) { uint32_t r = 0; for (int i = 0; i < 32; i++) { r = (r << 1) | (v & 1); v >>= 1; } return r; }
__STATIC_FORCEINLINE uint8_t __CLZ(uint32_t v) { return v ? (uint8_t)__builtin_clz(v) : 32; }
__STATIC_FORCEINLINE uint8_t  __LDREXB(volatile uint8_t *a)  { return *a; }
__STATIC_FORCEINLINE uint16_t __LDREXH(volatile uint16_t *a) { return *a; }
__STATIC_FORCEINLINE uint32_t __LDREXW(volatile uint32_t *a) { return *a; }
__STATIC_FORCEINLINE uint32_t __STREXB(uint8_t v, volatile uint8_t *a)   { *a = v; return 0; }
__STATIC_FORCEINLINE uint32_t __STREXH(uint16_t v, volatile uint16_t *a) { *a = v; return 0; }
__STATIC_FORCEINLINE uint32_t __STREXW(uint32_t v, volatile uint32_t *a) { *a = v; return 0; }
__STATIC_FORCEINLINE void __CLREX(void) {}
__STATIC_FORCEINLINE int32_t __SSAT(int32_t val, uint32_t sat) { if ((sat >= 1U) && (sat <= 32U)) { const int32_t max = (int32_t)((1U << (sat - 1U)) - 1U); const int32_t min = -1 - max; if (val > max) return max; if (val < min) return min; } return val; }
__STATIC_FORCEINLINE uint32_t __USAT(int32_t val, uint32_t sat) { if (sat <= 31U) { const uint32_t max = ((1U << sat) - 1U); if (val > (int32_t)max) return max; if (val < 0) return 0U; } return (uint32_t)val; }
__STATIC_FORCEINLINE uint32_t __RRX(uint32_t v) { return v >> 1; }

#endif

# Scheda Virtuale STM32

Simulatore di una scheda NUCLEO-F401RE che gira tutto nel browser: carichi il progetto CubeIDE (cartella o zip) o lo scrivi nell'editor, il sito lo compila in WebAssembly e lo simula con display, encoder, pulsanti, LED e altri dispositivi collegati ai pin.

Sito: https://giambax.github.io/scheda-virtuale/

Funziona su Chrome, Edge e Chromebook (Safari da verificare), anche offline dopo la prima apertura. Account (nome utente, email e password) e salvataggio online dei progetti con Supabase.

Componenti di terze parti in `vendor/`, ciascuno con la sua licenza: YoWASP Clang/LLVM (ISC, Apache-2.0 con LLVM Exceptions), CodeMirror (MIT), supabase-js (MIT), fflate (MIT), header STM32Cube F4 di STMicroelectronics (BSD-3-Clause / Apache-2.0, vedi i file LICENSE in `vendor/stm32f4`).

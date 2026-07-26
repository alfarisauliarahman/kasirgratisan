/**
 * Kapan sync dijalankan.
 *
 * Dipisah dari `engine.ts` supaya mesinnya tetap bisa dipanggil manual dan
 * diuji tanpa ada timer yang hidup di latar belakang.
 */

import { runSync, type SyncRunResult } from './engine';
import { isConfigured } from './config';

/** Jeda antar sync berkala saat aplikasi terbuka. */
const INTERVAL_MS = 30_000;

/**
 * Jeda setelah ada perubahan lokal.
 *
 * Cukup panjang untuk menggabungkan satu transaksi yang menulis banyak baris
 * sekaligus menjadi satu kiriman, cukup pendek supaya kasir lain melihatnya
 * hampir seketika.
 */
const DEBOUNCE_MS = 3_000;

type Listener = (result: SyncRunResult) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let debounceId: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

/** Dengarkan hasil tiap sync, mis. untuk indikator status di layar. */
export function onSyncResult(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function fire(): Promise<void> {
  const result = await runSync();
  if (result.skipped) return;
  for (const fn of listeners) {
    try {
      fn(result);
    } catch {
      // Pendengar yang rusak tidak boleh menjatuhkan sync.
    }
  }
}

/** Minta sync setelah ada perubahan lokal; panggilan beruntun digabung jadi satu. */
export function requestSync(): void {
  if (!isConfigured()) return;
  if (debounceId) clearTimeout(debounceId);
  debounceId = setTimeout(() => {
    debounceId = null;
    void fire();
  }, DEBOUNCE_MS);
}

/** Sync sekarang juga, tanpa menunggu jeda. Dipakai tombol "Sync sekarang". */
export function syncNow(): Promise<SyncRunResult> {
  if (debounceId) {
    clearTimeout(debounceId);
    debounceId = null;
  }
  return runSync();
}

/**
 * Nyalakan sync berkala.
 *
 * Selain timer, sync juga dipicu saat tab kembali terlihat dan saat jaringan
 * tersambung lagi — dua saat yang paling mungkin ada data tertinggal, dan
 * keduanya jauh lebih cepat terasa daripada menunggu putaran timer.
 */
export function startScheduler(): () => void {
  stopScheduler();

  intervalId = setInterval(() => void fire(), INTERVAL_MS);

  const onVisible = () => {
    if (document.visibilityState === 'visible') void fire();
  };
  const onOnline = () => void fire();

  document.addEventListener('visibilitychange', onVisible);
  globalThis.addEventListener?.('online', onOnline);

  // Sekali di awal, supaya perangkat yang baru dibuka langsung menyusul.
  void fire();

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    globalThis.removeEventListener?.('online', onOnline);
    stopScheduler();
  };
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (debounceId) {
    clearTimeout(debounceId);
    debounceId = null;
  }
}

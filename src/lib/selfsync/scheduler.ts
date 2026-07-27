/**
 * Kapan sync dijalankan.
 *
 * Dipisah dari `engine.ts` supaya mesinnya tetap bisa dipanggil manual dan
 * diuji tanpa ada timer yang hidup di latar belakang.
 */

import { runSync, type SyncRunResult } from './engine';
import { isConfigured } from './config';

/**
 * Jeda saat aplikasi sedang dilihat.
 *
 * Inilah yang menentukan berapa lama perubahan dari HP lain terasa muncul.
 * Kecil supaya terasa cepat; anggarannya masih longgar — 5 detik selama 12 jam
 * buka toko itu sekitar 8.600 permintaan per perangkat per hari, sementara
 * jatah gratis Cloudflare 100.000 per hari.
 */
const INTERVAL_ACTIVE_MS = 5_000;

/**
 * Jeda saat aplikasi di latar belakang.
 *
 * Tab yang tidak dilihat tidak perlu dikejar; menariknya sesering yang aktif
 * cuma menghabiskan kuota dan baterai tanpa ada yang melihat hasilnya.
 */
const INTERVAL_IDLE_MS = 60_000;

/**
 * Jeda setelah ada perubahan lokal.
 *
 * Cukup untuk menggabungkan satu transaksi yang menulis banyak baris menjadi
 * satu kiriman, tapi tidak sampai terasa menunggu.
 */
const DEBOUNCE_MS = 1_000;

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

  const isVisible = () =>
    typeof document === 'undefined' || document.visibilityState === 'visible';

  const arm = () => {
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(
      () => void fire(),
      isVisible() ? INTERVAL_ACTIVE_MS : INTERVAL_IDLE_MS,
    );
  };

  arm();

  const onVisible = () => {
    // Pasang ulang dengan jeda yang sesuai keadaan sekarang, lalu tarik
    // seketika supaya kembali ke tab tidak perlu menunggu satu putaran.
    arm();
    if (isVisible()) void fire();
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

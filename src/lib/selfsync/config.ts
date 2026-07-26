/**
 * Setelan sync mandiri, disimpan per perangkat.
 *
 * Sengaja di `localStorage`, bukan di tabel IndexedDB: setelan ini khas
 * perangkat (kunci, posisi bacaan, identitas perangkat) dan justru salah kalau
 * ikut tersinkronkan ke HP lain. Menaruhnya di tabel yang disinkronkan akan
 * membuat satu HP menimpa kunci milik HP lain.
 */

import { newUid } from './uid';

const KEY_URL = 'kg_selfsync_url';
const KEY_SECRET = 'kg_selfsync_secret';
const KEY_CURSOR = 'kg_selfsync_cursor';
const KEY_DEVICE = 'kg_selfsync_device';
const KEY_ENABLED = 'kg_selfsync_enabled';
const KEY_LAST_OK = 'kg_selfsync_last_ok';

export interface SyncConfig {
  /** Base URL Worker sync, tanpa garis miring di akhir. */
  url: string;
  secret: string;
  enabled: boolean;
}

function read(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    // localStorage bisa dilarang (mode privat / iframe). Sync mati, aplikasi
    // tetap jalan offline seperti biasa.
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* diabaikan: lihat alasan di read() */
  }
}

/** Buang garis miring di akhir supaya `url + '/api/sync'` tidak jadi `//`. */
export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function getConfig(): SyncConfig {
  return {
    url: read(KEY_URL),
    secret: read(KEY_SECRET),
    enabled: read(KEY_ENABLED) === '1',
  };
}

export function setConfig(next: Partial<SyncConfig>): void {
  if (next.url !== undefined) write(KEY_URL, normalizeUrl(next.url));
  if (next.secret !== undefined) write(KEY_SECRET, next.secret.trim());
  if (next.enabled !== undefined) write(KEY_ENABLED, next.enabled ? '1' : '0');
}

/** Sync hanya boleh jalan kalau dinyalakan DAN alamat serta kuncinya terisi. */
export function isConfigured(): boolean {
  const c = getConfig();
  return c.enabled && c.url.length > 0 && c.secret.length > 0;
}

/**
 * Identitas perangkat, dibuat sekali lalu dipakai seterusnya.
 * Hanya untuk penelusuran di sisi server; tidak dipakai logika merge.
 */
export function getDeviceId(): string {
  let id = read(KEY_DEVICE);
  if (!id) {
    id = newUid();
    write(KEY_DEVICE, id);
  }
  return id;
}

/** Posisi bacaan terakhir di server. */
export function getCursor(): number {
  const raw = read(KEY_CURSOR);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Cursor tidak pernah boleh mundur secara tidak sengaja: mundur berarti
 * menarik ulang data yang sudah diterapkan, dan itu boleh; tapi maju melewati
 * record yang gagal diterapkan berarti kehilangan data selamanya. Karena itu
 * pemanggil wajib memakai `safeCursor()` sebelum menyimpan ke sini.
 */
export function setCursor(value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  write(KEY_CURSOR, String(Math.floor(value)));
}

export function getLastSyncAt(): Date | null {
  const raw = read(KEY_LAST_OK);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function markSyncedNow(): void {
  write(KEY_LAST_OK, new Date().toISOString());
}

/**
 * Lupakan posisi bacaan supaya seluruh data ditarik ulang dari awal.
 * Dipakai saat memasang HP baru, atau kalau ada dugaan data tidak sinkron.
 */
export function resetCursor(): void {
  write(KEY_CURSOR, '0');
}

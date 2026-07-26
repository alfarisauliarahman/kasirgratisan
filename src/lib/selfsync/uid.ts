/**
 * Identitas record lintas perangkat untuk sync mandiri (self-hosted).
 *
 * Tabel-tabel di app ini memakai primary key auto-increment (`++id`), yang
 * hanya unik di dalam satu HP: HP A dan HP B sama-sama akan membuat produk
 * ber-`id=1` untuk barang yang berbeda. Karena itu setiap record juga diberi
 * `uid` — UUID yang dibuat sekali di perangkat asal dan tidak pernah berubah.
 *
 * `uid` TIDAK menggantikan `id`. Relasi antar tabel (`categoryId`,
 * `transactionId`, dst) tetap memakai id lokal, sehingga seluruh kode UI tidak
 * perlu disentuh. Lapisan sync-lah yang menerjemahkan uid <-> id lokal saat
 * mengirim dan menerima data.
 */

import type { Table } from 'dexie';

/**
 * Tabel yang ikut disinkronkan antar perangkat, jadi butuh `uid`.
 *
 * `storeSettings` sengaja tidak masuk: isinya setelan khas perangkat (printer
 * Bluetooth yang dipasangkan, dsb) yang justru salah kalau ikut disamakan.
 */
export const UID_TABLES = [
  'categories',
  'products',
  'suppliers',
  'customers',
  'units',
  'paymentMethods',
  'users',
  'expenseCategories',
  'expenses',
  'transactions',
  'transactionItems',
  'stockIns',
  'stockOuts',
  'hppHistory',
  'debts',
  'debtPayments',
  'stockOpnames',
  'stockOpnameItems',
] as const;

export type UidTableName = (typeof UID_TABLES)[number];

/**
 * Record apa pun yang sudah membawa identitas lintas perangkat.
 *
 * Dipakai lapisan sync supaya interface asli di `db.ts` tidak perlu diubah
 * satu per satu — makin sedikit yang disentuh, makin kecil bentrokan saat
 * menarik update dari repo asal.
 */
export type WithUid<T> = T & { uid?: string };

/**
 * `crypto.randomUUID` hanya tersedia di secure context (https / localhost).
 * Fallback dipakai supaya app tetap jalan saat diakses lewat http di LAN,
 * mis. ketika menguji dari HP ke `http://192.168.x.x:8080`.
 */
export function newUid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // versi 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // varian RFC 4122
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
    return (
      hex.slice(0, 4).join('') +
      '-' + hex.slice(4, 6).join('') +
      '-' + hex.slice(6, 8).join('') +
      '-' + hex.slice(8, 10).join('') +
      '-' + hex.slice(10, 16).join('')
    );
  }

  throw new Error('[selfsync] Tidak ada sumber acak yang aman untuk membuat uid.');
}

interface UidHostDatabase {
  table(name: string): Table<any, any>;
}

/**
 * Pasang hook agar setiap record baru otomatis dapat `uid`.
 *
 * Dexie mengizinkan lebih dari satu listener per hook, jadi ini menumpang di
 * samping hook bawaan app (yang mengisi `updatedAt`/`syncedAt`) tanpa
 * menggantikannya. Panggil sekali saja, setelah instance `db` dibuat.
 */
export function setupUidHooks(db: UidHostDatabase): void {
  for (const tableName of UID_TABLES) {
    const table = db.table(tableName);

    table.hook('creating', (_primKey: unknown, obj: any) => {
      if (!obj.uid) {
        obj.uid = newUid();
      }
    });

    // `uid` adalah identitas permanen. Kalau ada kode yang mencoba
    // mengubahnya, kembalikan ke nilai semula daripada membiarkan record
    // kehilangan jejaknya di perangkat lain.
    table.hook('updating', (mods: any, _primKey: unknown, obj: any) => {
      if ('uid' in mods && mods.uid !== obj.uid) {
        return { ...mods, uid: obj.uid ?? mods.uid };
      }
      return undefined;
    });
  }
}

/**
 * Isikan `uid` untuk record yang sudah ada sebelum migrasi.
 *
 * Dipakai di dalam `upgrade()` Dexie, dan aman dijalankan ulang: record yang
 * sudah punya uid dilewati.
 */
export async function backfillUids(tx: {
  table(name: string): { toCollection(): { modify(fn: (record: any) => void): Promise<any> } };
}): Promise<void> {
  for (const tableName of UID_TABLES) {
    await tx
      .table(tableName)
      .toCollection()
      .modify((record: any) => {
        if (!record.uid) {
          record.uid = newUid();
        }
      });
  }
}

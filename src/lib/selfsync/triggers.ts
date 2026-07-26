/**
 * Menjembatani perubahan database ke penjadwal sync.
 *
 * Dipisahkan dari `scheduler.ts` karena `db.ts` memuat berkas ini saat modul
 * pertama kali dijalankan, sementara penjadwal pada akhirnya mengimpor `db`
 * kembali. Impor dinamis di dalam hook memutus lingkaran itu — pola yang sama
 * dipakai kode sync bawaan aplikasi.
 */

import type { Table } from 'dexie';
import { UID_TABLES } from './uid';

interface TriggerHostDatabase {
  table(name: string): Table<any, any>;
}

/**
 * Panggil sekali setelah instance `db` dibuat.
 *
 * Hook di sini sengaja tidak menunggu sync selesai: penyimpanan transaksi
 * tidak boleh melambat hanya karena jaringan toko sedang lelet.
 */
export function setupSyncTriggers(db: TriggerHostDatabase): void {
  const nudge = () => {
    void import('./scheduler')
      .then(({ requestSync }) => requestSync())
      .catch(() => {
        /* penjadwal gagal dimuat: sync berkala tetap akan menyusul */
      });
  };

  for (const tableName of UID_TABLES) {
    const table = db.table(tableName);
    table.hook('creating', nudge);
    table.hook('updating', nudge);
    table.hook('deleting', nudge);
  }
}

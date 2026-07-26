/**
 * Putaran sync: kumpulkan perubahan lokal, kirim, terima, gabungkan.
 *
 * Aturan yang dipegang seluruh berkas ini: **data lokal tidak boleh rugi
 * karena sync**. Kalau ada yang gagal di tengah jalan, yang terjadi paling
 * buruk adalah sync diulang nanti — bukan record hilang atau tertimpa.
 */

import { db } from '../db';
import { UID_TABLES, type UidTableName } from './uid';
import { TABLE_META } from './schema';
import { toWireData, canonicalTimestamp, refKey, type WireRecord } from './wire';
import { applyIncoming, safeCursor, type MergeConflict } from './merge';
import { postSync, PUSH_BATCH_SIZE, SyncHttpError, type PulledRecord } from './client';
import {
  isConfigured,
  getCursor,
  setCursor,
  markSyncedNow,
} from './config';

/**
 * Batas putaran tarik data dalam satu kali sync.
 *
 * Bukan sekadar jaga-jaga: kalau ada record yang selalu tertunda, cursor
 * sengaja tidak maju (lihat `safeCursor`), sehingga tarikan berikutnya
 * mengembalikan isi yang sama. Tanpa batas ini putarannya tidak berhenti.
 */
const MAX_PULL_ROUNDS = 50;

export interface SyncRunResult {
  ok: boolean;
  skipped?: 'not-configured' | 'already-running';
  pushed: number;
  applied: number;
  deferred: number;
  conflicts: MergeConflict[];
  error?: string;
}

interface PendingPush {
  wire: WireRecord;
  table: UidTableName;
  localId: number;
  /** Nilai yang ditulis ke `syncedAt` kalau pengiriman berhasil. */
  stamp: Date;
}

interface PendingTombstone {
  wire: WireRecord;
  tombstoneId: number;
}

function isDirty(record: any): boolean {
  if (!record.syncedAt) return true;
  if (!record.updatedAt) return false;
  return new Date(record.updatedAt).getTime() > new Date(record.syncedAt).getTime();
}

/**
 * Peta id lokal -> uid untuk semua relasi yang dipakai record-record ini.
 *
 * Dikumpulkan sekali per tabel lalu diambil sekaligus, bukan satu query per
 * record: di HP kentang, ratusan query kecil terasa jelas.
 */
async function buildIdToUid(
  table: UidTableName,
  records: any[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wanted = new Map<UidTableName, Set<number>>();

  for (const fk of TABLE_META[table].foreignKeys) {
    for (const record of records) {
      const v = record[fk.field];
      if (typeof v !== 'number') continue;
      let set = wanted.get(fk.target);
      if (!set) {
        set = new Set();
        wanted.set(fk.target, set);
      }
      set.add(v);
    }
  }

  for (const [target, ids] of wanted) {
    const rows = await db.table(target).where('id').anyOf([...ids]).toArray();
    for (const row of rows as any[]) {
      if (row.uid) map.set(refKey(target, row.id), row.uid);
    }
  }

  return map;
}

/** Kumpulkan record lokal yang berubah sejak terakhir dikirim. */
export async function collectDirty(): Promise<{
  pushes: PendingPush[];
  tombstones: PendingTombstone[];
}> {
  const pushes: PendingPush[] = [];

  for (const table of UID_TABLES) {
    const rows = (await db.table(table).filter(isDirty).toArray()) as any[];
    if (rows.length === 0) continue;

    const idToUid = await buildIdToUid(table, rows);

    for (const row of rows) {
      // Tanpa uid record ini tidak punya identitas di perangkat lain. Hook
      // `creating` mestinya sudah mengisinya; kalau kosong, lewati daripada
      // mengirim sesuatu yang tak bisa dicocokkan.
      if (!row.uid) continue;

      const stamp = row.updatedAt instanceof Date ? row.updatedAt : new Date();
      pushes.push({
        wire: {
          table,
          uid: row.uid,
          updatedAt: canonicalTimestamp(row.updatedAt),
          deleted: false,
          data: toWireData(table, row, idToUid),
        },
        table,
        localId: row.id,
        stamp,
      });
    }
  }

  // Penghapusan keras tidak meninggalkan barisnya, jadi diambil dari tombstone.
  const tombs = (await db.deletedRecords
    .filter((r: any) => !r.syncedAt && !!r.recordUid)
    .toArray()) as any[];

  const tombstones: PendingTombstone[] = tombs
    .filter((t) => (TABLE_META as any)[t.tableName] !== undefined)
    .map((t) => ({
      wire: {
        table: t.tableName,
        uid: t.recordUid,
        updatedAt: canonicalTimestamp(t.deletedAt),
        deleted: true,
        data: null,
      },
      tombstoneId: t.id,
    }));

  return { pushes, tombstones };
}

/**
 * Tandai record yang berhasil dikirim.
 *
 * `syncedAt` diisi dengan `updatedAt` yang tadi dikirim, bukan waktu sekarang.
 * Kalau record diedit lagi setelah dikumpulkan tapi sebelum penandaan ini,
 * `updatedAt`-nya jadi lebih baru dari `syncedAt` sehingga otomatis terhitung
 * kotor lagi — suntingan itu tidak akan tertinggal.
 */
async function markPushed(pushes: PendingPush[], tombstones: PendingTombstone[]): Promise<void> {
  for (const p of pushes) {
    try {
      await db.table(p.table).update(p.localId, { syncedAt: p.stamp } as any);
    } catch {
      // Record sudah dihapus di sela-sela. Tombstone-nya akan menyusul.
    }
  }
  for (const t of tombstones) {
    try {
      await db.deletedRecords.update(t.tombstoneId, { syncedAt: new Date() });
    } catch {
      /* diabaikan */
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

let running = false;

/**
 * Jalankan satu siklus sync penuh.
 *
 * Aman dipanggil berkali-kali; pemanggilan saat siklus lain masih jalan akan
 * dilewati, bukan diantre, karena siklus berikutnya toh mengambil keadaan
 * terbaru.
 */
export async function runSync(): Promise<SyncRunResult> {
  const result: SyncRunResult = {
    ok: false,
    pushed: 0,
    applied: 0,
    deferred: 0,
    conflicts: [],
  };

  if (!isConfigured()) return { ...result, ok: true, skipped: 'not-configured' };
  if (running) return { ...result, ok: true, skipped: 'already-running' };
  running = true;

  try {
    const { pushes, tombstones } = await collectDirty();
    const outgoing: { wire: WireRecord; push?: PendingPush; tomb?: PendingTombstone }[] = [
      ...pushes.map((p) => ({ wire: p.wire, push: p })),
      ...tombstones.map((t) => ({ wire: t.wire, tomb: t })),
    ];

    // Selalu ada minimal satu perjalanan, supaya sync tetap menarik data
    // meski tidak ada perubahan lokal untuk dikirim.
    const batches = outgoing.length > 0 ? chunk(outgoing, PUSH_BATCH_SIZE) : [[]];

    let cursor = getCursor();

    for (const batch of batches) {
      const res = await postSync(cursor, batch.map((b) => b.wire));
      const merged = await applyIncoming(db as any, res.changes);

      cursor = safeCursor(cursor, res.changes as PulledRecord[], merged.deferred as PulledRecord[]);
      setCursor(cursor);

      await markPushed(
        batch.map((b) => b.push).filter((p): p is PendingPush => !!p),
        batch.map((b) => b.tomb).filter((t): t is PendingTombstone => !!t),
      );

      result.pushed += batch.length;
      result.applied += merged.applied;
      result.deferred += merged.deferred.length;
      result.conflicts.push(...merged.conflicts);

      // Tarik sisanya sampai habis.
      let rounds = 0;
      let hasMore = res.hasMore;
      while (hasMore && rounds < MAX_PULL_ROUNDS) {
        rounds++;
        const before = cursor;
        const more = await postSync(cursor, []);
        const mergedMore = await applyIncoming(db as any, more.changes);

        cursor = safeCursor(cursor, more.changes as PulledRecord[], mergedMore.deferred as PulledRecord[]);
        setCursor(cursor);

        result.applied += mergedMore.applied;
        result.deferred += mergedMore.deferred.length;
        result.conflicts.push(...mergedMore.conflicts);

        // Cursor mandek berarti ada record yang tertahan menunggu induknya.
        // Memaksa terus hanya mengulang isi yang sama.
        if (cursor === before) break;
        hasMore = more.hasMore;
      }
    }

    markSyncedNow();
    result.ok = true;
    return result;
  } catch (err) {
    result.error =
      err instanceof SyncHttpError ? err.message : 'Sync gagal karena kesalahan tak terduga.';
    // Sengaja tidak menyentuh cursor maupun syncedAt: keadaan tetap seperti
    // sebelum sync, jadi percobaan berikutnya mengulang dari titik yang sama.
    return result;
  } finally {
    running = false;
  }
}

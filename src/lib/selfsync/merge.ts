/**
 * Menerapkan perubahan dari server ke database lokal.
 *
 * Ini bagian "telinga" aplikasi: sebelumnya kode sync bawaan hanya bisa
 * mengirim. Tugas berkas ini menerima, menerjemahkan relasinya, lalu menulis
 * dengan aturan yang sama di semua perangkat sehingga hasilnya menyatu.
 */

import { MERGE_ORDER, TABLE_META } from './schema';
import type { UidTableName } from './uid';
import {
  fromWireData,
  refKey,
  collectOutgoingRefs,
  type WireRecord,
  type MissingRef,
} from './wire';

export interface MergeConflict {
  table: UidTableName;
  field: string;
  /** Nilai yang diperebutkan, mis. SKU `IND001`. */
  value: string;
  /** uid yang berhak mempertahankan nilai aslinya. */
  keptUid: string;
  /** uid yang nilainya diubah supaya tidak bentrok. */
  renamedUid: string;
  /** Nilai pengganti; `null` bila bentrokan tidak bisa diselesaikan otomatis. */
  newValue: string | null;
}

export interface MergeResult {
  applied: number;
  /** Record yang induknya belum ada; harus dicoba lagi, bukan dibuang. */
  deferred: WireRecord[];
  conflicts: MergeConflict[];
}

/** Minimal interface Dexie yang dipakai, supaya gampang dipalsukan saat tes. */
export interface MergeDb {
  table(name: string): {
    where(index: string): {
      equals(value: any): {
        first(): Promise<any>;
        toArray(): Promise<any[]>;
      };
      anyOf(values: any[]): { toArray(): Promise<any[]> };
    };
    add(item: any): Promise<any>;
    put(item: any): Promise<any>;
    update(key: any, changes: any): Promise<any>;
    delete(key: any): Promise<any>;
  };
}

function asTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const t = new Date(value).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/**
 * Akhiran penanda untuk nilai yang diubah karena bentrok.
 *
 * Sengaja memakai potongan uid, bukan angka urut: hasilnya sama di semua
 * perangkat tanpa perlu ada yang saling menunggu.
 */
function suffixed(value: string, uid: string): string {
  return value + '~' + uid.slice(0, 6);
}

/**
 * Selesaikan bentrokan nilai unik antara dua record yang berbeda.
 *
 * Dua kasir bisa sama-sama menambah produk ber-SKU `IND001` tanpa saling tahu.
 * Keduanya sah, tapi indeksnya unik, jadi salah satu nilainya harus mengalah.
 * Pemenangnya ditentukan dengan membandingkan uid — aturan yang tidak
 * bergantung pada urutan kedatangan, sehingga semua perangkat sampai pada
 * kesimpulan yang sama tanpa berunding.
 */
async function resolveUniqueCollisions(
  db: MergeDb,
  table: UidTableName,
  incomingUid: string,
  data: Record<string, unknown>,
  conflicts: MergeConflict[],
): Promise<void> {
  for (const field of TABLE_META[table].uniqueFields) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;

    const existing = await db.table(table).where(field).equals(value).first();
    if (!existing) continue;
    if (existing.uid === incomingUid) continue; // record yang sama, bukan bentrok

    if (typeof value !== 'string') {
      // Nilai bukan teks (mis. `debts.transactionId`) tidak bisa diberi
      // akhiran tanpa merusak maknanya. Yang uid-nya lebih kecil bertahan;
      // yang kalah dilaporkan supaya bisa ditengok manusia.
      const kept = existing.uid < incomingUid ? existing.uid : incomingUid;
      conflicts.push({
        table,
        field,
        value: String(value),
        keptUid: kept,
        renamedUid: kept === incomingUid ? existing.uid : incomingUid,
        newValue: null,
      });
      continue;
    }

    if (incomingUid < existing.uid) {
      // Yang datang berhak atas nilai aslinya; yang lokal diberi akhiran.
      const replacement = suffixed(value, existing.uid);
      await db.table(table).update(existing.id, { [field]: replacement });
      conflicts.push({
        table,
        field,
        value,
        keptUid: incomingUid,
        renamedUid: existing.uid,
        newValue: replacement,
      });
    } else {
      const replacement = suffixed(value, incomingUid);
      data[field] = replacement;
      conflicts.push({
        table,
        field,
        value,
        keptUid: existing.uid,
        renamedUid: incomingUid,
        newValue: replacement,
      });
    }
  }
}

/** Bangun peta uid -> id lokal untuk semua relasi yang dibutuhkan batch ini. */
async function buildUidToId(
  db: MergeDb,
  table: UidTableName,
  datas: Record<string, unknown>[],
): Promise<Map<string, number>> {
  const wanted = collectOutgoingRefs(table, datas);
  const map = new Map<string, number>();

  for (const [target, values] of wanted) {
    const uids = [...values].filter((v): v is string => typeof v === 'string');
    if (uids.length === 0) continue;
    const rows = await db.table(target).where('uid').anyOf(uids).toArray();
    for (const row of rows) {
      if (row.uid !== undefined && row.id !== undefined) {
        map.set(refKey(target, row.uid), row.id);
      }
    }
  }

  return map;
}

/**
 * Terapkan sekumpulan perubahan dari server.
 *
 * Tabel diproses menurut `MERGE_ORDER` supaya induk selalu ada lebih dulu.
 * Record yang relasinya tetap tidak ketemu dikembalikan lewat `deferred`;
 * pemanggil TIDAK boleh memajukan cursor melewatinya, karena record itu
 * belum benar-benar tersimpan.
 */
export async function applyIncoming(
  db: MergeDb,
  records: WireRecord[],
): Promise<MergeResult> {
  const byTable = new Map<UidTableName, WireRecord[]>();
  for (const r of records) {
    if (!(r.table in TABLE_META)) continue; // tabel tak dikenal: abaikan, jangan gagal
    const t = r.table as UidTableName;
    let list = byTable.get(t);
    if (!list) {
      list = [];
      byTable.set(t, list);
    }
    list.push(r);
  }

  const result: MergeResult = { applied: 0, deferred: [], conflicts: [] };

  for (const table of MERGE_ORDER) {
    const incoming = byTable.get(table);
    if (!incoming || incoming.length === 0) continue;

    const uidToId = await buildUidToId(
      db,
      table,
      incoming.map((r) => r.data ?? {}),
    );

    for (const wire of incoming) {
      const existing = await db.table(table).where('uid').equals(wire.uid).first();

      // Terbaru menang. Perubahan lokal yang lebih baru tidak boleh tertimpa
      // data lama yang baru sampai.
      if (existing && asTime(existing.updatedAt) > new Date(wire.updatedAt).getTime()) {
        continue;
      }

      if (wire.deleted) {
        if (existing) {
          if ('isDeleted' in existing) {
            await db.table(table).update(existing.id, {
              isDeleted: 1,
              deletedAt: new Date(wire.updatedAt),
              updatedAt: new Date(wire.updatedAt),
              syncedAt: new Date(),
            });
          } else {
            await db.table(table).delete(existing.id);
          }
          result.applied++;
        }
        continue;
      }

      const resolved = fromWireData(table, wire.data ?? {}, uidToId);
      if (resolved.status === 'missing') {
        result.deferred.push(wire);
        continue;
      }

      const data = resolved.value;
      await resolveUniqueCollisions(db, table, wire.uid, data, result.conflicts);

      // `syncedAt` ditandai supaya record ini tidak langsung dikirim balik
      // sebagai perubahan lokal — kalau tidak, dua perangkat akan saling
      // memantulkan record yang sama tanpa henti.
      const row = {
        ...data,
        uid: wire.uid,
        updatedAt: new Date(wire.updatedAt),
        syncedAt: new Date(),
      };

      if (existing) {
        await db.table(table).put({ ...existing, ...row, id: existing.id });
      } else {
        await db.table(table).add(row);
      }
      result.applied++;
    }
  }

  return result;
}

/**
 * Cursor teraman untuk disimpan setelah satu putaran merge.
 *
 * Kalau ada record yang ditunda, cursor berhenti tepat sebelum record tertunda
 * paling awal. Memajukannya lebih jauh berarti record itu tidak akan pernah
 * ditarik lagi dan hilang selamanya dari perangkat ini.
 */
export function safeCursor(
  fallback: number,
  pulled: { serverSeq?: number }[],
  deferred: { serverSeq?: number }[],
): number {
  const seqs = pulled
    .map((r) => r.serverSeq)
    .filter((s): s is number => typeof s === 'number');
  const highest = seqs.length > 0 ? Math.max(...seqs) : fallback;

  const deferredSeqs = deferred
    .map((r) => r.serverSeq)
    .filter((s): s is number => typeof s === 'number');
  if (deferredSeqs.length === 0) return highest;

  return Math.max(fallback, Math.min(...deferredSeqs) - 1);
}

export type { MissingRef };

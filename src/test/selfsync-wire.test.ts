import { describe, it, expect } from 'vitest';
import {
  toWireData,
  fromWireData,
  collectOutgoingRefs,
  canonicalTimestamp,
  refKey,
} from '@/lib/selfsync/wire';
import { TABLE_META, MERGE_ORDER } from '@/lib/selfsync/schema';
import { UID_TABLES } from '@/lib/selfsync/uid';

const ISO_CANON = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('canonicalTimestamp', () => {
  it('menghasilkan format yang diterima server', () => {
    expect(canonicalTimestamp(new Date('2026-07-27T10:00:00Z'))).toMatch(ISO_CANON);
    expect(canonicalTimestamp('2026-07-27T17:00:00+07:00')).toMatch(ISO_CANON);
  });

  it('menyamakan waktu yang sama meski ditulis beda zona', () => {
    expect(canonicalTimestamp('2026-07-27T17:00:00+07:00')).toBe(
      canonicalTimestamp('2026-07-27T10:00:00.000Z'),
    );
  });

  it('tidak melempar untuk nilai rusak', () => {
    expect(canonicalTimestamp('bukan tanggal')).toMatch(ISO_CANON);
    expect(canonicalTimestamp(new Date('x'))).toMatch(ISO_CANON);
    expect(canonicalTimestamp(undefined)).toMatch(ISO_CANON);
  });
});

describe('toWireData', () => {
  const idToUid = new Map([
    [refKey('categories', 3), 'uid-kategori'],
    [refKey('users', 7), 'uid-user'],
  ]);

  const product = {
    id: 12,
    name: 'Indomie Goreng',
    sku: 'IND001',
    categoryId: 3,
    createdBy: 7,
    price: 3500,
    stock: 20,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-27T10:00:00Z'),
    deletedAt: null,
    syncedAt: new Date('2026-07-27T09:00:00Z'),
  };

  it('membuang field khusus perangkat', () => {
    const wire = toWireData('products', product, idToUid);
    expect(wire).not.toHaveProperty('id');
    expect(wire).not.toHaveProperty('syncedAt');
  });

  it('menukar relasi menjadi uid', () => {
    const wire = toWireData('products', product, idToUid);
    expect(wire.categoryId).toBe('uid-kategori');
    expect(wire.createdBy).toBe('uid-user');
  });

  it('mengubah Date menjadi string ISO', () => {
    const wire = toWireData('products', product, idToUid);
    expect(wire.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(wire.deletedAt).toBeNull();
  });

  it('mengirim null untuk relasi menggantung, bukan id lokal mentah', () => {
    const wire = toWireData('products', { ...product, categoryId: 999 }, idToUid);
    // Angka 999 di HP lain menunjuk kategori yang sama sekali berbeda,
    // jadi mengirimnya apa adanya justru merusak data.
    expect(wire.categoryId).toBeNull();
  });

  it('membiarkan relasi opsional yang memang kosong', () => {
    const wire = toWireData('products', { ...product, createdBy: undefined }, idToUid);
    expect(wire.createdBy).toBeUndefined();
  });
});

describe('fromWireData', () => {
  const uidToId = new Map([
    [refKey('categories', 'uid-kategori'), 3],
    [refKey('transactions', 'uid-trx'), 88],
    [refKey('products', 'uid-produk'), 12],
  ]);

  it('menukar uid kembali menjadi id lokal', () => {
    const res = fromWireData(
      'transactionItems',
      { transactionId: 'uid-trx', productId: 'uid-produk', quantity: 2 },
      uidToId,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.transactionId).toBe(88);
    expect(res.value.productId).toBe(12);
  });

  it('mengembalikan string ISO menjadi Date', () => {
    const res = fromWireData(
      'products',
      { name: 'X', categoryId: 'uid-kategori', createdAt: '2026-07-01T00:00:00.000Z' },
      uidToId,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.createdAt).toBeInstanceOf(Date);
    expect((res.value.createdAt as Date).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('menolak record yang induknya belum sampai, dan menyebutkan yang kurang', () => {
    const res = fromWireData(
      'transactionItems',
      { transactionId: 'uid-belum-ada', productId: 'uid-produk', quantity: 1 },
      uidToId,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missing).toEqual([{ table: 'transactions', uid: 'uid-belum-ada' }]);
  });

  it('melaporkan semua relasi yang kurang sekaligus', () => {
    const res = fromWireData(
      'transactionItems',
      { transactionId: 'uid-hilang-a', productId: 'uid-hilang-b', quantity: 1 },
      uidToId,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missing).toHaveLength(2);
  });

  it('tidak membuang field yang tidak dikenal, supaya kolom baru tetap lewat', () => {
    const res = fromWireData('products', { name: 'X', kolomBaru: 'nilai' }, uidToId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kolomBaru).toBe('nilai');
  });
});

describe('bolak-balik', () => {
  it('record kembali utuh setelah dikirim dan diterima', () => {
    const idToUid = new Map([[refKey('categories', 3), 'uid-kategori']]);
    const uidToId = new Map([[refKey('categories', 'uid-kategori'), 9]]);

    const asli = {
      id: 12,
      name: 'Kopi',
      sku: 'KOP1',
      categoryId: 3,
      price: 5000,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      syncedAt: null,
    };

    const wire = toWireData('products', asli, idToUid);
    const res = fromWireData('products', wire, uidToId);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.name).toBe('Kopi');
    expect(res.value.price).toBe(5000);
    // id lokal berbeda di perangkat penerima — itu memang yang diharapkan.
    expect(res.value.categoryId).toBe(9);
    expect(res.value).not.toHaveProperty('id');
    expect((res.value.createdAt as Date).toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('collectOutgoingRefs', () => {
  it('mengelompokkan relasi per tabel tujuan tanpa duplikat', () => {
    const wanted = collectOutgoingRefs('transactionItems', [
      { transactionId: 5, productId: 1 },
      { transactionId: 5, productId: 2 },
    ]);

    expect([...(wanted.get('transactions') ?? [])]).toEqual([5]);
    expect([...(wanted.get('products') ?? [])]).toEqual([1, 2]);
  });
});

describe('konsistensi metadata', () => {
  it('setiap tabel ber-uid punya metadata', () => {
    for (const t of UID_TABLES) {
      expect(TABLE_META[t], `metadata ${t} hilang`).toBeDefined();
    }
  });

  it('urutan merge mencakup semua tabel tepat sekali', () => {
    expect([...MERGE_ORDER].sort()).toEqual([...UID_TABLES].sort());
    expect(new Set(MERGE_ORDER).size).toBe(MERGE_ORDER.length);
  });

  it('induk selalu diterapkan sebelum anaknya', () => {
    const posisi = new Map(MERGE_ORDER.map((t, i) => [t, i]));
    for (const table of MERGE_ORDER) {
      for (const fk of TABLE_META[table].foreignKeys) {
        // Relasi ke tabel sendiri tidak masuk hitungan urutan.
        if (fk.target === table) continue;
        expect(
          posisi.get(fk.target)!,
          `${table}.${fk.field} menunjuk ${fk.target}, yang harus lebih dulu`,
        ).toBeLessThan(posisi.get(table)!);
      }
    }
  });

  it('setiap tabel yang punya indeks unik terdaftar uniqueFields-nya', () => {
    // Dijaga agar tidak ada indeks unik baru yang lolos tanpa penanganan
    // bentrok saat merge.
    expect(TABLE_META.products.uniqueFields).toContain('sku');
    expect(TABLE_META.transactions.uniqueFields).toContain('receiptNumber');
    expect(TABLE_META.users.uniqueFields).toContain('username');
    expect(TABLE_META.units.uniqueFields).toContain('name');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import { applyIncoming, safeCursor } from '@/lib/selfsync/merge';
import { newUid } from '@/lib/selfsync/uid';
import type { WireRecord } from '@/lib/selfsync/wire';

const ts = (s: string) => new Date(s).toISOString();

function wire(partial: Partial<WireRecord> & { table: string }): WireRecord {
  return {
    uid: newUid(),
    updatedAt: ts('2026-07-27T10:00:00Z'),
    deleted: false,
    data: {},
    ...partial,
  };
}

async function clearAll() {
  await db.categories.clear();
  await db.products.clear();
  await db.transactions.clear();
  await db.transactionItems.clear();
  await db.paymentMethods.clear();
  await db.customers.clear();
  await db.units.clear();
}

describe('applyIncoming', () => {
  beforeEach(clearAll);

  it('menulis record baru dari perangkat lain', async () => {
    const res = await applyIncoming(db as any, [
      wire({ table: 'categories', data: { name: 'Minuman', isDeleted: 0 } }),
    ]);

    expect(res.applied).toBe(1);
    expect(res.deferred).toHaveLength(0);
    const rows = await db.categories.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Minuman');
  });

  it('menerjemahkan relasi ke id lokal, bukan menyalin id perangkat asal', async () => {
    const catUid = newUid();
    await applyIncoming(db as any, [
      wire({ table: 'categories', uid: catUid, data: { name: 'Makanan', isDeleted: 0 } }),
    ]);

    // Bikin kategori lain dulu supaya id lokalnya dijamin berbeda dari id
    // di perangkat asal.
    await db.categories.add({ name: 'Lain', isDeleted: 0, deletedAt: null, createdAt: new Date() } as any);

    await applyIncoming(db as any, [
      wire({
        table: 'products',
        data: { name: 'Nasi Goreng', sku: 'NG1', categoryId: catUid, price: 15000, stock: 5, unit: 'porsi', isDeleted: 0 },
      }),
    ]);

    const cat = await db.categories.where('uid').equals(catUid).first();
    const product = await db.products.where('sku').equals('NG1').first();
    expect(product?.categoryId).toBe(cat?.id);
  });

  it('memproses induk sebelum anak walau urutan datangnya terbalik', async () => {
    const trxUid = newUid();
    const prodUid = newUid();

    // Anak sengaja ditaruh paling depan.
    const res = await applyIncoming(db as any, [
      wire({ table: 'transactionItems', data: { transactionId: trxUid, productId: prodUid, productName: 'X', quantity: 2, price: 1000, subtotal: 2000 } }),
      wire({ table: 'products', uid: prodUid, data: { name: 'X', sku: 'X1', categoryId: null, price: 1000, stock: 1, unit: 'pcs', isDeleted: 0 } }),
      wire({ table: 'transactions', uid: trxUid, data: { receiptNumber: 'TX1', total: 2000, subtotal: 2000, status: 'completed', date: ts('2026-07-27T10:00:00Z') } }),
    ]);

    expect(res.deferred).toHaveLength(0);
    const item = await db.transactionItems.toArray();
    const trx = await db.transactions.where('uid').equals(trxUid).first();
    expect(item[0].transactionId).toBe(trx?.id);
  });

  it('menunda record yang induknya tidak ada, bukan menulis relasi yang salah', async () => {
    const res = await applyIncoming(db as any, [
      wire({ table: 'transactionItems', data: { transactionId: newUid(), productId: newUid(), productName: 'X', quantity: 1, price: 1, subtotal: 1 } }),
    ]);

    expect(res.applied).toBe(0);
    expect(res.deferred).toHaveLength(1);
    expect(await db.transactionItems.count()).toBe(0);
  });

  it('tidak menimpa perubahan lokal yang lebih baru', async () => {
    const uid = newUid();
    await applyIncoming(db as any, [
      wire({ table: 'categories', uid, updatedAt: ts('2026-07-27T10:00:00Z'), data: { name: 'Lama', isDeleted: 0 } }),
    ]);

    const local = await db.categories.where('uid').equals(uid).first();
    await db.categories.update(local!.id!, { name: 'Diedit lokal', updatedAt: new Date('2026-07-27T12:00:00Z') } as any);

    await applyIncoming(db as any, [
      wire({ table: 'categories', uid, updatedAt: ts('2026-07-27T11:00:00Z'), data: { name: 'Basi', isDeleted: 0 } }),
    ]);

    expect((await db.categories.where('uid').equals(uid).first())?.name).toBe('Diedit lokal');
  });

  it('menerapkan perubahan yang lebih baru dari perangkat lain', async () => {
    const uid = newUid();
    await applyIncoming(db as any, [
      wire({ table: 'categories', uid, updatedAt: ts('2026-07-27T10:00:00Z'), data: { name: 'Lama', isDeleted: 0 } }),
    ]);
    await applyIncoming(db as any, [
      wire({ table: 'categories', uid, updatedAt: ts('2026-07-27T13:00:00Z'), data: { name: 'Baru', isDeleted: 0 } }),
    ]);

    expect((await db.categories.where('uid').equals(uid).first())?.name).toBe('Baru');
  });

  it('menandai syncedAt supaya record tidak dipantulkan balik ke server', async () => {
    const uid = newUid();
    await applyIncoming(db as any, [
      wire({ table: 'categories', uid, data: { name: 'A', isDeleted: 0 } }),
    ]);

    const row = await db.categories.where('uid').equals(uid).first();
    expect(row?.syncedAt).toBeInstanceOf(Date);
  });

  it('menghapus lunak untuk tabel yang punya isDeleted', async () => {
    const uid = newUid();
    await applyIncoming(db as any, [
      wire({ table: 'categories', uid, data: { name: 'Hapus', isDeleted: 0 } }),
    ]);
    await applyIncoming(db as any, [
      wire({ table: 'categories', uid, updatedAt: ts('2026-07-27T14:00:00Z'), deleted: true }),
    ]);

    expect((await db.categories.where('uid').equals(uid).first())?.isDeleted).toBe(1);
  });

  it('menghapus keras untuk tabel tanpa isDeleted', async () => {
    const uid = newUid();
    await applyIncoming(db as any, [
      wire({ table: 'paymentMethods', uid, data: { name: 'QRIS', category: 'qris', isDefault: false } }),
    ]);
    await applyIncoming(db as any, [
      wire({ table: 'paymentMethods', uid, updatedAt: ts('2026-07-27T14:00:00Z'), deleted: true }),
    ]);

    expect(await db.paymentMethods.where('uid').equals(uid).first()).toBeUndefined();
  });

  it('mengabaikan tabel yang tidak dikenal tanpa menggagalkan batch', async () => {
    const res = await applyIncoming(db as any, [
      wire({ table: 'tabelMasaDepan', data: { x: 1 } }),
      wire({ table: 'categories', data: { name: 'Tetap masuk', isDeleted: 0 } }),
    ]);

    expect(res.applied).toBe(1);
  });
});

describe('bentrokan nilai unik', () => {
  beforeEach(clearAll);

  it('dua perangkat membuat SKU sama: keduanya tetap tersimpan', async () => {
    const uidA = '0000-aaaa';
    const uidB = 'ffff-bbbb';

    await applyIncoming(db as any, [
      wire({ table: 'products', uid: uidB, data: { name: 'Punya B', sku: 'IND001', categoryId: null, price: 3000, stock: 1, unit: 'pcs', isDeleted: 0 } }),
    ]);

    const res = await applyIncoming(db as any, [
      wire({ table: 'products', uid: uidA, data: { name: 'Punya A', sku: 'IND001', categoryId: null, price: 3500, stock: 2, unit: 'pcs', isDeleted: 0 } }),
    ]);

    // Tidak ada yang hilang.
    expect(await db.products.count()).toBe(2);
    expect(res.conflicts).toHaveLength(1);

    // uid lebih kecil memenangkan nilai aslinya.
    const a = await db.products.where('uid').equals(uidA).first();
    const b = await db.products.where('uid').equals(uidB).first();
    expect(a?.sku).toBe('IND001');
    expect(b?.sku).toMatch(/^IND001~/);
  });

  it('hasilnya sama tidak peduli urutan kedatangan', async () => {
    const uidA = '0000-aaaa';
    const uidB = 'ffff-bbbb';
    const recA = wire({ table: 'products', uid: uidA, data: { name: 'A', sku: 'DUP', categoryId: null, price: 1, stock: 1, unit: 'pcs', isDeleted: 0 } });
    const recB = wire({ table: 'products', uid: uidB, data: { name: 'B', sku: 'DUP', categoryId: null, price: 2, stock: 1, unit: 'pcs', isDeleted: 0 } });

    // Urutan A lalu B.
    await applyIncoming(db as any, [recA]);
    await applyIncoming(db as any, [recB]);
    const urutan1 = {
      a: (await db.products.where('uid').equals(uidA).first())?.sku,
      b: (await db.products.where('uid').equals(uidB).first())?.sku,
    };

    await clearAll();

    // Urutan B lalu A.
    await applyIncoming(db as any, [recB]);
    await applyIncoming(db as any, [recA]);
    const urutan2 = {
      a: (await db.products.where('uid').equals(uidA).first())?.sku,
      b: (await db.products.where('uid').equals(uidB).first())?.sku,
    };

    // Inilah yang membuat semua HP menyatu tanpa perlu saling menunggu.
    expect(urutan1).toEqual(urutan2);
  });

  it('nomor struk yang kembar tidak menggagalkan sync', async () => {
    await applyIncoming(db as any, [
      wire({ table: 'transactions', uid: 'aaa', data: { receiptNumber: 'TX999', total: 1000, subtotal: 1000, status: 'completed', date: ts('2026-07-27T10:00:00Z') } }),
    ]);
    const res = await applyIncoming(db as any, [
      wire({ table: 'transactions', uid: 'bbb', data: { receiptNumber: 'TX999', total: 2000, subtotal: 2000, status: 'completed', date: ts('2026-07-27T10:00:01Z') } }),
    ]);

    expect(await db.transactions.count()).toBe(2);
    expect(res.conflicts[0].field).toBe('receiptNumber');
  });

  it('memperbarui record yang sama tidak dianggap bentrok', async () => {
    const uid = newUid();
    await applyIncoming(db as any, [
      wire({ table: 'products', uid, data: { name: 'A', sku: 'SAMA', categoryId: null, price: 1, stock: 1, unit: 'pcs', isDeleted: 0 } }),
    ]);
    const res = await applyIncoming(db as any, [
      wire({ table: 'products', uid, updatedAt: ts('2026-07-27T15:00:00Z'), data: { name: 'A diubah', sku: 'SAMA', categoryId: null, price: 2, stock: 1, unit: 'pcs', isDeleted: 0 } }),
    ]);

    expect(res.conflicts).toHaveLength(0);
    expect(await db.products.count()).toBe(1);
    expect((await db.products.where('uid').equals(uid).first())?.name).toBe('A diubah');
  });
});

describe('safeCursor', () => {
  it('maju ke seq tertinggi kalau semua berhasil diterapkan', () => {
    expect(safeCursor(0, [{ serverSeq: 3 }, { serverSeq: 7 }], [])).toBe(7);
  });

  it('berhenti sebelum record tertunda paling awal', () => {
    // Kalau cursor melewati 5, record itu tidak akan pernah ditarik lagi.
    expect(safeCursor(0, [{ serverSeq: 5 }, { serverSeq: 9 }], [{ serverSeq: 5 }])).toBe(4);
  });

  it('tidak pernah mundur dari posisi sebelumnya', () => {
    expect(safeCursor(10, [{ serverSeq: 12 }], [{ serverSeq: 3 }])).toBe(10);
  });

  it('tetap di posisi semula kalau tidak ada data', () => {
    expect(safeCursor(42, [], [])).toBe(42);
  });
});

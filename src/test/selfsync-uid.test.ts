import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { newUid, UID_TABLES } from '@/lib/selfsync/uid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function clearAll() {
  await db.products.clear();
  await db.categories.clear();
  await db.transactions.clear();
  await db.transactionItems.clear();
  await db.deletedRecords.clear();
}

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Produk Uji',
    sku: `SKU-${newUid().slice(0, 8)}`,
    categoryId: 1,
    price: 10000,
    hpp: 5000,
    stock: 10,
    unit: 'pcs',
    isDeleted: 0,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as any;
}

describe('newUid', () => {
  it('menghasilkan UUID v4 yang valid', () => {
    expect(newUid()).toMatch(UUID_RE);
  });

  it('tidak pernah menghasilkan nilai kembar', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newUid());
    expect(seen.size).toBe(5000);
  });
});

describe('hook uid', () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it('memberi uid otomatis pada record baru', async () => {
    const id = await db.products.add(makeProduct());
    const product = await db.products.get(id);

    expect((product as any)?.uid).toMatch(UUID_RE);
  });

  it('memberi uid berbeda untuk tiap record', async () => {
    const idA = await db.products.add(makeProduct({ name: 'A' }));
    const idB = await db.products.add(makeProduct({ name: 'B' }));

    const a = (await db.products.get(idA)) as any;
    const b = (await db.products.get(idB)) as any;

    expect(a.uid).not.toBe(b.uid);
  });

  it('menghormati uid yang sudah ditentukan, supaya data dari perangkat lain tidak berubah identitas', async () => {
    const uid = newUid();
    const id = await db.products.add(makeProduct({ uid }));

    expect(((await db.products.get(id)) as any).uid).toBe(uid);
  });

  it('uid tidak berubah saat record diperbarui', async () => {
    const id = await db.products.add(makeProduct());
    const before = ((await db.products.get(id)) as any).uid;

    await db.products.update(id, { name: 'Nama Baru', price: 20000 } as any);

    expect(((await db.products.get(id)) as any).uid).toBe(before);
  });

  it('menolak percobaan mengubah uid secara langsung', async () => {
    const id = await db.products.add(makeProduct());
    const original = ((await db.products.get(id)) as any).uid;

    await db.products.update(id, { uid: newUid() } as any);

    expect(((await db.products.get(id)) as any).uid).toBe(original);
  });

  it('berlaku juga untuk tabel anak seperti transactionItems', async () => {
    const id = await db.transactionItems.add({
      transactionId: 1,
      productId: 1,
      productName: 'Produk Uji',
      quantity: 2,
      price: 10000,
      subtotal: 20000,
    } as any);

    expect(((await db.transactionItems.get(id)) as any).uid).toMatch(UUID_RE);
  });
});

describe('tombstone penghapusan', () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it('mencatat uid record yang dihapus, bukan hanya id lokalnya', async () => {
    const id = await db.transactions.add({
      date: new Date(),
      receiptNumber: `RCP-${newUid().slice(0, 8)}`,
      paymentMethodId: 1,
      subtotal: 10000,
      discount: 0,
      tax: 0,
      total: 10000,
      paid: 10000,
      change: 0,
      status: 'completed',
    } as any);

    const uid = ((await db.transactions.get(id)) as any).uid;
    await db.transactions.delete(id);

    // Hook tombstone menulis lewat setTimeout(0), jadi tunggu satu putaran.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tombstone = await db.deletedRecords
      .filter((r) => r.tableName === 'transactions' && r.recordId === id)
      .first();

    expect(tombstone).toBeDefined();
    expect(tombstone?.recordUid).toBe(uid);
  });
});

describe('skema', () => {
  it('mengindeks uid di seluruh tabel yang disinkronkan', () => {
    for (const tableName of UID_TABLES) {
      const indexes = db.table(tableName).schema.indexes.map((i) => i.name);
      expect(indexes, `tabel ${tableName} belum punya indeks uid`).toContain('uid');
    }
  });
});

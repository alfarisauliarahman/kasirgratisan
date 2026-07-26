import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import { ensureOpeningBalances, loadOpeningBalances } from '@/lib/selfsync/baseline';
import { recomputeStockForProducts } from '@/lib/selfsync/stock';
import type { StockDb } from '@/lib/selfsync/stock';

async function clearAll() {
  await db.products.clear();
  await db.stockIns.clear();
  await db.stockOuts.clear();
  await db.transactions.clear();
  await db.transactionItems.clear();
  await db.stockOpnames.clear();
  await db.stockOpnameItems.clear();
}

async function addProduct(name: string, stock: number, extra: Record<string, unknown> = {}) {
  return db.products.add({
    name,
    sku: `SKU-${name}`,
    categoryId: 1,
    price: 1000,
    hpp: 500,
    stock,
    unit: 'pcs',
    isDeleted: 0,
    deletedAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...extra,
  } as any);
}

async function sell(productId: number, qty: number, at: string) {
  const txId = await db.transactions.add({
    date: new Date(at),
    receiptNumber: `R-${productId}-${at}`,
    paymentMethodId: 1,
    subtotal: 1000,
    total: 1000,
    status: 'completed',
  } as any);
  await db.transactionItems.add({
    transactionId: txId,
    productId,
    productName: 'x',
    quantity: qty,
    price: 1000,
    subtotal: 1000 * qty,
  } as any);
}

beforeEach(clearAll);

describe('ensureOpeningBalances', () => {
  it('menyimpulkan stok awal yang tidak punya jejak pergerakan', async () => {
    // Produk dibuat dengan stok 50, lalu terjual 5. Stok sekarang 45,
    // dan yang 50 itu tidak pernah tercatat sebagai pergerakan.
    const id = await addProduct('Indomie', 45);
    await sell(id, 5, '2026-07-10T00:00:00Z');

    const written = await ensureOpeningBalances();

    expect(written).toBe(1);
    expect(((await db.products.get(id)) as any).openingStock).toBe(50);
  });

  it('membuat perhitungan ulang menghasilkan angka yang benar, bukan minus', async () => {
    const id = await addProduct('Kopi', 45);
    await sell(id, 5, '2026-07-10T00:00:00Z');
    await ensureOpeningBalances();

    const hasil = await recomputeStockForProducts(db as unknown as StockDb, [id], {
      openingBalances: await loadOpeningBalances([id]),
    });

    expect(hasil[0].unreliable).toBe(false);
    expect(hasil[0].stock).toBe(45);
  });

  it('tanpa saldo awal, perhitungan ulang menolak menebak', async () => {
    const id = await addProduct('Teh', 45);
    await sell(id, 5, '2026-07-10T00:00:00Z');

    const hasil = await recomputeStockForProducts(db as unknown as StockDb, [id]);

    // Inilah yang dicegah: tanpa titik nol, hasilnya akan -5.
    expect(hasil[0].unreliable).toBe(true);
    expect(hasil[0].stock).toBe(45);
  });

  it('tidak menghitung ulang produk yang saldo awalnya sudah ada', async () => {
    const id = await addProduct('Sudah ada', 10, { openingStock: 99, openingDerivedAt: new Date() });

    const written = await ensureOpeningBalances();

    expect(written).toBe(0);
    expect(((await db.products.get(id)) as any).openingStock).toBe(99);
  });

  it('aman dipanggil dua kali', async () => {
    const id = await addProduct('Dobel', 30);
    await sell(id, 4, '2026-07-11T00:00:00Z');

    await ensureOpeningBalances();
    const pertama = ((await db.products.get(id)) as any).openingStock;
    await ensureOpeningBalances();
    const kedua = ((await db.products.get(id)) as any).openingStock;

    expect(kedua).toBe(pertama);
  });

  it('memperhitungkan barang masuk saat menyimpulkan saldo awal', async () => {
    // Awal 20, masuk 30, terjual 10 -> stok sekarang 40.
    const id = await addProduct('Gula', 40);
    await db.stockIns.add({
      productId: id,
      supplierId: 1,
      quantity: 30,
      buyPrice: 500,
      totalPrice: 15000,
      date: new Date('2026-07-05T00:00:00Z'),
      notes: '',
    } as any);
    await sell(id, 10, '2026-07-06T00:00:00Z');

    await ensureOpeningBalances();

    expect(((await db.products.get(id)) as any).openingStock).toBe(20);
  });

  it('menandai produk tanpa kelola stok supaya tidak diperiksa terus', async () => {
    const id = await addProduct('Jasa', 0, { trackStock: false });

    await ensureOpeningBalances();

    expect(((await db.products.get(id)) as any).openingDerivedAt).toBeInstanceOf(Date);
    expect(await ensureOpeningBalances()).toBe(0);
  });
});

describe('loadOpeningBalances', () => {
  it('hanya mengembalikan produk yang sudah punya saldo awal', async () => {
    const a = await addProduct('A', 5);
    await addProduct('B', 5);
    await db.products.update(a, { openingStock: 5 } as any);

    const balances = await loadOpeningBalances();

    expect(balances).toHaveLength(1);
    expect(balances[0].productId).toBe(a);
    expect(balances[0].asOf).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import {
  computeStockFromMovements,
  pickOpnameBaseline,
  resolveBaseline,
  deriveOpeningQuantity,
  deriveOpeningBalances,
  gatherMovements,
  recomputeProductStock,
  recomputeStockForProducts,
  applyRecomputedStock,
  recomputeAndApply,
  type StockDb,
  type StockMovement,
  type StockBaseline,
} from '@/lib/selfsync/stock';

const sdb = db as unknown as StockDb;

const at = (iso: string) => new Date(iso);

async function clearAll() {
  await db.products.clear();
  await db.stockIns.clear();
  await db.stockOuts.clear();
  await db.transactions.clear();
  await db.transactionItems.clear();
  await db.stockOpnames.clear();
  await db.stockOpnameItems.clear();
}

let receiptSeq = 0;

async function addProduct(over: Record<string, any> = {}): Promise<number> {
  const now = new Date();
  return (await db.products.add({
    name: 'Produk',
    sku: `SKU${Math.random().toString(36).slice(2, 10)}`,
    categoryId: 1,
    price: 10000,
    hpp: 5000,
    stock: 0,
    unit: 'pcs',
    createdAt: now,
    updatedAt: now,
    isDeleted: 0,
    deletedAt: null,
    ...over,
  } as any)) as number;
}

/**
 * Satu penjualan seperti yang ditulis `Cashier.tsx`: baris transaksi plus
 * baris item. Sengaja TIDAK menyentuh `products.stock`, karena justru angka
 * itulah yang mau dihitung ulang.
 */
async function addSale(
  productId: number,
  quantity: number,
  date: Date,
  status: 'open' | 'completed' = 'completed',
): Promise<number> {
  const txId = (await db.transactions.add({
    subtotal: 0,
    discountType: null,
    discountValue: 0,
    discountAmount: 0,
    total: 0,
    paymentMethodId: 1,
    paymentAmount: 0,
    change: 0,
    profit: 0,
    date,
    receiptNumber: `TX${++receiptSeq}-${Math.random().toString(36).slice(2, 8)}`,
    status,
  } as any)) as number;

  await db.transactionItems.add({
    transactionId: txId,
    productId,
    productName: 'Produk',
    quantity,
    price: 10000,
    hpp: 5000,
    discountType: null,
    discountValue: 0,
    discountAmount: 0,
    subtotal: 0,
  } as any);

  return txId;
}

async function addStockIn(productId: number, quantity: number, date: Date) {
  return db.stockIns.add({
    productId,
    supplierId: 1,
    quantity,
    buyPrice: 5000,
    totalPrice: 5000 * quantity,
    date,
    notes: '',
  } as any);
}

async function addStockOut(productId: number, quantity: number, date: Date) {
  return db.stockOuts.add({
    productId,
    quantity,
    reason: 'rusak',
    date,
    notes: '',
  } as any);
}

/** Stock opname seperti `handleSubmitOpname()`: checkpoint absolut. */
async function addOpname(
  productId: number,
  realStock: number,
  systemStock: number,
  date: Date,
  status: 'draft' | 'completed' = 'completed',
): Promise<number> {
  const opnameId = (await db.stockOpnames.add({ date, status, notes: '' } as any)) as number;
  await db.stockOpnameItems.add({
    opnameId,
    productId,
    systemStock,
    realStock,
    difference: realStock - systemStock,
  } as any);
  return opnameId;
}

beforeEach(clearAll);

// ---------------------------------------------------------------------------

describe('computeStockFromMovements (murni)', () => {
  const zero: StockBaseline = { quantity: 0, asOf: null, source: 'none' };

  it('menjumlahkan pergerakan bertanda di atas acuan', () => {
    const movements: StockMovement[] = [
      { kind: 'stockIn', quantity: 10, date: at('2026-07-01T00:00:00Z') },
      { kind: 'sale', quantity: -2, date: at('2026-07-02T00:00:00Z') },
      { kind: 'stockOut', quantity: -1, date: at('2026-07-03T00:00:00Z') },
    ];
    expect(computeStockFromMovements(zero, movements)).toBe(7);
  });

  it('hasilnya tidak bergantung pada urutan array', () => {
    const movements: StockMovement[] = [
      { kind: 'sale', quantity: -3, date: at('2026-07-05T00:00:00Z') },
      { kind: 'stockIn', quantity: 8, date: at('2026-07-01T00:00:00Z') },
      { kind: 'sale', quantity: -2, date: at('2026-07-03T00:00:00Z') },
    ];
    const a = computeStockFromMovements(zero, movements);
    const b = computeStockFromMovements(zero, [...movements].reverse());
    expect(a).toBe(b);
    expect(a).toBe(3);
  });

  it('membulatkan supaya satuan pecahan tidak melayang', () => {
    const movements: StockMovement[] = [
      { kind: 'stockIn', quantity: 0.1, date: at('2026-07-01T00:00:00Z') },
      { kind: 'stockIn', quantity: 0.2, date: at('2026-07-01T00:00:00Z') },
    ];
    expect(computeStockFromMovements(zero, movements)).toBe(0.3);
  });

  it('mengabaikan pergerakan pada atau sebelum acuan', () => {
    const baseline: StockBaseline = {
      quantity: 100,
      asOf: at('2026-07-10T00:00:00Z'),
      source: 'opname',
    };
    const movements: StockMovement[] = [
      { kind: 'sale', quantity: -50, date: at('2026-07-01T00:00:00Z') }, // sebelum
      { kind: 'stockIn', quantity: 7, date: at('2026-07-10T00:00:00Z') }, // tepat sama
      { kind: 'sale', quantity: -4, date: at('2026-07-11T00:00:00Z') }, // sesudah
    ];
    expect(computeStockFromMovements(baseline, movements)).toBe(96);
  });
});

describe('pemilihan acuan', () => {
  it('memilih opname paling akhir', () => {
    const b = pickOpnameBaseline([
      { realStock: 5, date: at('2026-07-01T00:00:00Z') },
      { realStock: 12, date: at('2026-07-20T00:00:00Z') },
      { realStock: 9, date: at('2026-07-10T00:00:00Z') },
    ]);
    expect(b?.quantity).toBe(12);
    expect(b?.source).toBe('opname');
  });

  it('memecah seri tanggal dengan uid supaya sama di semua perangkat', () => {
    const same = at('2026-07-20T00:00:00Z');
    const forward = pickOpnameBaseline([
      { realStock: 1, date: same, uid: 'aaa', id: 99 },
      { realStock: 2, date: same, uid: 'bbb', id: 1 },
    ]);
    const backward = pickOpnameBaseline([
      { realStock: 2, date: same, uid: 'bbb', id: 1 },
      { realStock: 1, date: same, uid: 'aaa', id: 99 },
    ]);
    expect(forward?.quantity).toBe(2);
    expect(backward?.quantity).toBe(2);
  });

  it('jatuh ke saldo awal eksplisit bila tidak ada opname, lalu ke none', () => {
    expect(resolveBaseline([], { productId: 1, quantity: 40, asOf: null })).toEqual({
      quantity: 40,
      asOf: null,
      source: 'opening',
    });
    expect(resolveBaseline([]).source).toBe('none');
  });

  it('membalik ledger untuk menyimpulkan saldo awal', () => {
    const movements: StockMovement[] = [
      { kind: 'stockIn', quantity: 10, date: at('2026-07-01T00:00:00Z') },
      { kind: 'sale', quantity: -3, date: at('2026-07-02T00:00:00Z') },
    ];
    // stok sekarang 57 = saldo awal 50 + 10 − 3
    expect(deriveOpeningQuantity(57, movements)).toBe(50);
  });
});

// ---------------------------------------------------------------------------

describe('recompute lewat Dexie', () => {
  it('menghitung DUA penjualan bersamaan dari perangkat berbeda — inti masalahnya', async () => {
    // Stok 10. HP A menjual 2 dan menulis 8; HP B menjual 3 dan menulis 7.
    // Last-write-wins menyisakan salah satunya saja pada `products.stock`.
    const id = await addProduct({ stock: 7 }); // "yang menang" — satu penjualan hilang
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));

    await addSale(id, 2, at('2026-07-05T09:00:00Z')); // HP A
    await addSale(id, 3, at('2026-07-05T09:00:01Z')); // HP B

    const res = await recomputeProductStock(sdb, id);
    expect(res).not.toBeNull();
    expect(res!.previousStock).toBe(7);
    expect(res!.stock).toBe(5); // 10 − 2 − 3, keduanya terhitung
    expect(res!.changed).toBe(true);
    expect(res!.unreliable).toBe(false);
    expect(res!.baseline.source).toBe('opname');
  });

  it('memakai opname sebagai acuan: pergerakan sebelumnya diabaikan, sesudahnya dihitung', async () => {
    const id = await addProduct({ stock: 999 });

    await addStockIn(id, 500, at('2026-06-01T00:00:00Z')); // sebelum opname
    await addSale(id, 400, at('2026-06-02T00:00:00Z')); // sebelum opname

    await addOpname(id, 20, 100, at('2026-07-01T00:00:00Z'));

    await addStockIn(id, 5, at('2026-07-02T00:00:00Z')); // sesudah
    await addSale(id, 3, at('2026-07-03T00:00:00Z')); // sesudah
    await addStockOut(id, 2, at('2026-07-04T00:00:00Z')); // sesudah

    const res = await recomputeProductStock(sdb, id);
    expect(res!.stock).toBe(20); // 20 + 5 − 3 − 2
  });

  it('tidak menghitung dua kali penyesuaian yang ditulis opname pada detik yang sama', async () => {
    // `handleSubmitOpname()` menulis checkpoint DAN record stockIn/stockOut
    // penyesuaian dengan `now` yang sama persis.
    const id = await addProduct({ stock: 30 });
    const when = at('2026-07-01T00:00:00Z');
    await addOpname(id, 30, 25, when);
    await addStockIn(id, 5, when); // penyesuaian selisih +5 dari opname

    const res = await recomputeProductStock(sdb, id);
    expect(res!.stock).toBe(30); // bukan 35
  });

  it('mengabaikan opname yang masih draft', async () => {
    const id = await addProduct({ stock: 8 });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z')); // completed
    await addOpname(id, 999, 10, at('2026-07-09T00:00:00Z'), 'draft');
    await addSale(id, 2, at('2026-07-10T00:00:00Z'));

    const res = await recomputeProductStock(sdb, id);
    expect(res!.stock).toBe(8); // 10 − 2, draft tidak dipakai sebagai acuan
  });

  it('menghitung bill yang masih open — stok memang sudah dipotong saat bill disimpan', async () => {
    const id = await addProduct({ stock: 4 });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));
    await addSale(id, 4, at('2026-07-05T00:00:00Z'), 'completed');
    await addSale(id, 2, at('2026-07-06T00:00:00Z'), 'open');

    const res = await recomputeProductStock(sdb, id);
    expect(res!.stock).toBe(4); // 10 − 4 − 2
  });

  it('dengan countOpenBills: false hanya bill completed yang dihitung', async () => {
    const id = await addProduct({ stock: 4 });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));
    await addSale(id, 4, at('2026-07-05T00:00:00Z'), 'completed');
    await addSale(id, 2, at('2026-07-06T00:00:00Z'), 'open');

    const res = await recomputeProductStock(sdb, id, { countOpenBills: false });
    expect(res!.stock).toBe(6); // 10 − 4; bill open dikembalikan
  });

  it('mengabaikan item yatim yang transaksinya sudah dihapus', async () => {
    const id = await addProduct({ stock: 10 });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));
    const txId = await addSale(id, 3, at('2026-07-05T00:00:00Z'));

    // Persis seperti yang terjadi saat tombstone `transactions` sampai ke
    // perangkat lain: transaksinya hilang, item-itemnya tertinggal.
    await db.transactions.delete(txId);

    const res = await recomputeProductStock(sdb, id);
    expect(res!.stock).toBe(10);
    expect(res!.movementCount).toBe(0);
  });

  it('mengabaikan record yang di-soft-delete', async () => {
    const id = await addProduct({ stock: 0 });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));

    const liveIn = await addStockIn(id, 5, at('2026-07-02T00:00:00Z'));
    const deadIn = await addStockIn(id, 100, at('2026-07-03T00:00:00Z'));
    await db.stockIns.update(deadIn, { isDeleted: 1 } as any);

    const deadOut = await addStockOut(id, 50, at('2026-07-04T00:00:00Z'));
    await db.stockOuts.update(deadOut, { isDeleted: 1 } as any);

    const deadTx = await addSale(id, 40, at('2026-07-05T00:00:00Z'));
    await db.transactions.update(deadTx, { isDeleted: 1 } as any);

    expect(liveIn).toBeTruthy();

    const res = await recomputeProductStock(sdb, id);
    expect(res!.stock).toBe(15); // 10 + 5, sisanya terhapus
  });

  it('mengabaikan produk yang di-soft-delete kecuali diminta', async () => {
    const id = await addProduct({ stock: 3, isDeleted: 1, deletedAt: new Date() });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));

    expect(await recomputeStockForProducts(sdb, [id])).toHaveLength(0);

    const [res] = await recomputeStockForProducts(sdb, [id], {
      includeDeletedProducts: true,
    });
    expect(res.stock).toBe(10);
  });

  it('produk tanpa pergerakan sama sekali: acuan opname tetap dipakai', async () => {
    const id = await addProduct({ stock: 42 });
    await addOpname(id, 12, 42, at('2026-07-01T00:00:00Z'));

    const res = await recomputeProductStock(sdb, id);
    expect(res!.movementCount).toBe(0);
    expect(res!.stock).toBe(12);
    expect(res!.changed).toBe(true);
  });

  it('produk tanpa pergerakan DAN tanpa acuan dibiarkan apa adanya', async () => {
    // Ini kasus stok awal yang diketik di form produk: tidak ada jejak apa pun.
    const id = await addProduct({ stock: 42 });

    const res = await recomputeProductStock(sdb, id);
    expect(res!.baseline.source).toBe('none');
    expect(res!.unreliable).toBe(true);
    expect(res!.stock).toBe(42); // TIDAK dikosongkan
    expect(res!.changed).toBe(false);
  });

  it('trackStock === false: stok diabaikan seutuhnya', async () => {
    const id = await addProduct({ stock: 0, trackStock: false });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));
    await addSale(id, 5, at('2026-07-05T00:00:00Z'));

    const res = await recomputeProductStock(sdb, id);
    expect(res!.tracked).toBe(false);
    expect(res!.stock).toBe(0);
    expect(res!.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('saldo awal tanpa jejak pergerakan', () => {
  it('policy zero menghapus kuantitas tanpa jejak — sengaja tidak jadi bawaan', async () => {
    const id = await addProduct({ stock: 50 });
    await addSale(id, 5, at('2026-07-05T00:00:00Z'));

    const skipped = await recomputeProductStock(sdb, id);
    expect(skipped!.stock).toBe(50);
    expect(skipped!.unreliable).toBe(true);

    const zeroed = await recomputeProductStock(sdb, id, { onMissingBaseline: 'zero' });
    expect(zeroed!.stock).toBe(-5); // bukti kenapa bawaannya `skip`
  });

  it('saldo awal eksplisit memulihkan kuantitas yang tidak punya jejak', async () => {
    const id = await addProduct({ stock: 41 }); // sudah rusak akibat LWW
    await addSale(id, 5, at('2026-07-05T09:00:00Z'));
    await addSale(id, 4, at('2026-07-05T09:00:01Z'));

    const res = await recomputeProductStock(sdb, id, {
      openingBalances: [{ productId: id, quantity: 50, asOf: null }],
    });
    expect(res!.baseline.source).toBe('opening');
    expect(res!.stock).toBe(41); // 50 − 5 − 4; kedua penjualan terhitung
  });

  it('deriveOpeningBalances membalik ledger dan membuat recompute jadi no-op', async () => {
    const id = await addProduct({ stock: 45 });
    await addStockIn(id, 10, at('2026-07-02T00:00:00Z'));
    await addSale(id, 5, at('2026-07-03T00:00:00Z'));

    const openings = await deriveOpeningBalances(sdb, [id]);
    expect(openings).toEqual([{ productId: id, quantity: 40, asOf: null }]);

    const res = await recomputeProductStock(sdb, id, { openingBalances: openings });
    expect(res!.stock).toBe(45);
    expect(res!.changed).toBe(false);
  });

  it('policy derive setara dengan menyemai saldo awal dari stok sekarang', async () => {
    const id = await addProduct({ stock: 45 });
    await addStockIn(id, 10, at('2026-07-02T00:00:00Z'));
    await addSale(id, 5, at('2026-07-03T00:00:00Z'));

    const res = await recomputeProductStock(sdb, id, { onMissingBaseline: 'derive' });
    expect(res!.baseline.source).toBe('derived');
    expect(res!.baseline.quantity).toBe(40);
    expect(res!.stock).toBe(45);
  });
});

// ---------------------------------------------------------------------------

describe('batch', () => {
  it('menghitung banyak produk sekaligus dan memisahkan pergerakannya', async () => {
    const a = await addProduct({ stock: 0 });
    const b = await addProduct({ stock: 0 });
    const c = await addProduct({ stock: 7 }); // tanpa acuan

    await addOpname(a, 10, 10, at('2026-07-01T00:00:00Z'));
    await addOpname(b, 100, 100, at('2026-07-01T00:00:00Z'));

    await addSale(a, 2, at('2026-07-05T00:00:00Z'));
    await addSale(b, 30, at('2026-07-05T00:00:00Z'));
    await addStockIn(b, 5, at('2026-07-06T00:00:00Z'));

    const results = await recomputeStockForProducts(sdb, null);
    const byId = new Map(results.map((r) => [r.productId, r]));

    expect(byId.get(a)!.stock).toBe(8);
    expect(byId.get(b)!.stock).toBe(75);
    expect(byId.get(c)!.stock).toBe(7);
    expect(byId.get(c)!.unreliable).toBe(true);
  });

  it('gatherMovements hanya mengembalikan pergerakan produk yang diminta', async () => {
    const a = await addProduct();
    const b = await addProduct();
    await addStockIn(a, 1, at('2026-07-01T00:00:00Z'));
    await addStockIn(b, 2, at('2026-07-01T00:00:00Z'));

    const { movements } = await gatherMovements(sdb, [a]);
    expect(movements.get(a)).toHaveLength(1);
    expect(movements.has(b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('penulisan kembali', () => {
  it('menulis stok hasil hitung ulang tanpa menjadikannya peristiwa sync baru', async () => {
    const id = await addProduct({ stock: 7 });
    await db.products.update(id, {
      updatedAt: at('2026-07-01T00:00:00Z'),
      syncedAt: at('2026-07-01T00:00:05Z'),
    } as any);

    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));
    await addSale(id, 2, at('2026-07-05T09:00:00Z'));
    await addSale(id, 3, at('2026-07-05T09:00:01Z'));

    const before = await db.products.get(id);
    const results = await recomputeStockForProducts(sdb, [id]);
    const written = await applyRecomputedStock(sdb, results);

    expect(written).toBe(1);
    const after = await db.products.get(id);
    expect(after!.stock).toBe(5);
    // Kalau kedua field ini bergeser, tiap perangkat akan saling memantulkan
    // record yang sama tanpa henti.
    expect(after!.updatedAt?.getTime()).toBe(before!.updatedAt?.getTime());
    expect(after!.syncedAt?.getTime()).toBe(before!.syncedAt?.getTime());
  });

  it('menolak menulis hasil yang tidak bisa dipercaya', async () => {
    const id = await addProduct({ stock: 50 });
    await addSale(id, 5, at('2026-07-05T00:00:00Z'));

    const results = await recomputeStockForProducts(sdb, [id], {
      onMissingBaseline: 'zero',
    });
    expect(results[0].stock).toBe(-5);

    // `unreliable` hanya ditandai saat acuannya memang tidak ada; policy `zero`
    // adalah pilihan sadar pemanggil, jadi hasilnya ditulis.
    expect(results[0].baseline.source).toBe('none');

    const skipped = await recomputeStockForProducts(sdb, [id]);
    expect(await applyRecomputedStock(sdb, skipped)).toBe(0);
    expect((await db.products.get(id))!.stock).toBe(50);
  });

  it('tidak menulis produk yang stoknya tidak dikelola', async () => {
    const id = await addProduct({ stock: 0, trackStock: false });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));

    await recomputeAndApply(sdb, [id]);
    expect((await db.products.get(id))!.stock).toBe(0);
  });

  it('recomputeAndApply memperbaiki stok yang rusak akibat last-write-wins', async () => {
    const id = await addProduct({ stock: 7 });
    await addOpname(id, 10, 10, at('2026-07-01T00:00:00Z'));
    await addSale(id, 2, at('2026-07-05T09:00:00Z'));
    await addSale(id, 3, at('2026-07-05T09:00:01Z'));

    const results = await recomputeAndApply(sdb, [id]);
    expect(results[0].stock).toBe(5);
    expect((await db.products.get(id))!.stock).toBe(5);
  });
});

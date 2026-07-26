/**
 * Saldo awal produk — titik nol untuk perhitungan ulang stok.
 *
 * Stok awal saat produk dibuat, dan angka stok yang diketik langsung di form
 * produk, TIDAK meninggalkan record pergerakan apa pun. Jumlah itu karenanya
 * tidak bisa direkonstruksi dari riwayat. Tanpa saldo awal, `recomputeStock*`
 * akan melewati hampir semua produk dan fitur perhitungan ulang jadi percuma.
 *
 * Berkas ini menghitungnya sekali — `stok sekarang dikurangi seluruh pergerakan
 * yang tercatat` — lalu menyimpannya di record produk. Karena disimpan di
 * produk, nilainya ikut tersinkron, sehingga semua HP memakai titik nol yang
 * sama. Kalau tiap HP menghitungnya sendiri-sendiri setelah data bercampur,
 * hasilnya akan berbeda-beda dan justru itu yang mau dihindari.
 */

import { db } from '../db';
import { deriveOpeningBalances, type OpeningBalance, type StockDb } from './stock';

/** Bentuk tambahan pada record produk. Tidak diindeks, jadi tanpa versi skema baru. */
export interface ProductOpeningFields {
  /** Jumlah barang sebelum pergerakan mana pun tercatat. */
  openingStock?: number;
  /** Kapan saldo awal ini ditetapkan. Penanda bahwa produk sudah diproses. */
  openingDerivedAt?: Date;
}

function needsBaseline(product: any): boolean {
  return product && typeof product.openingStock !== 'number';
}

/**
 * Tetapkan saldo awal untuk produk yang belum punya.
 *
 * WAKTU PEMANGGILAN PENTING: jalankan sebelum sync pertama kali menggabungkan
 * data dari perangkat lain. Perhitungannya bertumpu pada `products.stock` yang
 * masih dipercaya; sesudah bercampur, angka itu bisa saja sudah kehilangan
 * penjualan akibat tabrakan yang justru jadi alasan fitur ini ada.
 *
 * Aman dipanggil berulang: produk yang sudah punya saldo awal dilewati, jadi
 * data yang datang dari HP lain (yang saldo awalnya ikut terbawa) tidak
 * dihitung ulang.
 */
export async function ensureOpeningBalances(): Promise<number> {
  const all = (await db.products.toArray()) as any[];
  const pending = all.filter(needsBaseline);
  if (pending.length === 0) return 0;

  const ids = pending
    .map((p) => p.id)
    .filter((id): id is number => typeof id === 'number');
  if (ids.length === 0) return 0;

  const balances = await deriveOpeningBalances(db as unknown as StockDb, ids);
  const byProduct = new Map(balances.map((b) => [b.productId, b]));
  const stampedAt = new Date();
  let written = 0;

  for (const id of ids) {
    const balance = byProduct.get(id);
    // Produk yang tidak dikelola stoknya tidak dikembalikan `deriveOpeningBalances`.
    // Tetap ditandai supaya tidak diperiksa ulang tiap kali aplikasi dibuka.
    const quantity = balance ? balance.quantity : 0;

    await db.products.update(id, {
      openingStock: quantity,
      openingDerivedAt: stampedAt,
    } as any);
    written++;
  }

  return written;
}

/** Baca saldo awal tersimpan, dalam bentuk yang diterima `recomputeStockForProducts`. */
export async function loadOpeningBalances(
  productIds: number[] | null = null,
): Promise<OpeningBalance[]> {
  const products = (
    productIds === null
      ? await db.products.toArray()
      : await db.products.where('id').anyOf(productIds).toArray()
  ) as any[];

  const out: OpeningBalance[] = [];
  for (const p of products) {
    if (typeof p?.id !== 'number' || typeof p.openingStock !== 'number') continue;
    // `asOf: null` berarti saldo ini berlaku sejak sebelum pergerakan mana pun,
    // sehingga seluruh riwayat ikut dihitung di atasnya.
    out.push({ productId: p.id, quantity: p.openingStock, asOf: null });
  }
  return out;
}

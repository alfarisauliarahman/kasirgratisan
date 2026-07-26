/**
 * Menghitung ulang stok produk dari catatan pergerakan, bukan dari angka
 * `products.stock` yang disinkronkan.
 *
 * Kenapa perlu: `products.stock` adalah satu angka yang ditimpa (last-write-wins
 * berdasarkan `updatedAt`) saat merge. Untuk pencacah berjalan itu salah. Stok
 * 10, HP A menjual 2 lalu menulis 8, HP B menjual 3 lalu menulis 7 — yang datang
 * belakangan menang dan satu penjualan hilang dari hitungan.
 *
 * Catatan pergerakan (`stockIns`, `stockOuts`, `transactionItems`,
 * `stockOpnameItems`) sifatnya append-only: masing-masing record berdiri
 * sendiri, punya uid sendiri, dan tidak pernah saling menimpa. Menjumlahkannya
 * selalu memberi hasil yang sama di semua perangkat.
 *
 * === Masalah saldo awal (WAJIB dibaca sebelum memakai modul ini) ===
 *
 * Tidak semua kuantitas punya jejak pergerakan. Saat produk dibuat dengan stok
 * awal (`Products.tsx` → `db.products.add`), diimpor dari Excel, disemai lewat
 * Onboarding, atau ketika pengguna mengetik ulang angka stok di form produk
 * (`db.products.update({ stock })`), TIDAK ada satu pun record `stockIns` yang
 * ditulis. Kuantitas itu tidak bisa direkonstruksi dari pergerakan.
 *
 * Karena itu menghitung ulang "dari nol" akan MENGHAPUS kuantitas tersebut.
 * Modul ini menolak menebak: bila sebuah produk tidak punya titik acuan yang
 * sah (stock opname `completed`, atau saldo awal eksplisit yang diberikan
 * pemanggil), hasilnya ditandai `unreliable` dan stok lama dibiarkan apa adanya
 * (lihat `onMissingBaseline`).
 *
 * Jalur penyelesaiannya: panggil `deriveOpeningBalances()` SEKALI di perangkat
 * yang datanya masih dipercaya (sebelum merge pertama menimpa apa pun),
 * simpan hasilnya, lalu berikan lewat `openingBalances` pada pemanggilan
 * berikutnya. Modul ini sengaja tidak menyimpannya sendiri — penyimpanan adalah
 * urusan lapisan yang memasang modul ini.
 */

// ---------------------------------------------------------------------------
// Tipe murni (tanpa Dexie)
// ---------------------------------------------------------------------------

export type MovementKind = 'stockIn' | 'stockOut' | 'sale';

/**
 * Satu pergerakan stok yang sudah dinormalkan.
 *
 * `quantity` SELALU bertanda: positif menambah stok, negatif mengurangi.
 * Pemanggil pure function tidak perlu tahu tabel asalnya.
 */
export interface StockMovement {
  kind: MovementKind;
  /** Bertanda: `+` masuk, `-` keluar/terjual. */
  quantity: number;
  date: Date;
  /**
   * Item milik bill yang belum dibayar (`transactions.status === 'open'`).
   *
   * Di aplikasi ini stok SUDAH dipotong saat bill dibuka, bukan saat dibayar,
   * jadi secara bawaan ini tetap dihitung. Lihat `countOpenBills`.
   */
  open?: boolean;
  /** Soft delete defensif; tabel pergerakan saat ini tidak memilikinya. */
  isDeleted?: number;
  /** Untuk penelusuran saat debug, tidak dipakai dalam perhitungan. */
  ref?: string;
}

export type BaselineSource =
  /** Stock opname `completed` terakhir — hitungan fisik, paling tepercaya. */
  | 'opname'
  /** Saldo awal eksplisit yang diberikan pemanggil. */
  | 'opening'
  /** Disimpulkan dari `products.stock` saat ini (lihat `onMissingBaseline`). */
  | 'derived'
  /** Tidak ada acuan sah sama sekali. */
  | 'none';

export interface StockBaseline {
  quantity: number;
  /**
   * Waktu berlakunya acuan. Hanya pergerakan yang BENAR-BENAR setelah waktu ini
   * yang dihitung. `null` berarti sejak awal waktu: semua pergerakan dihitung.
   */
  asOf: Date | null;
  source: BaselineSource;
}

/** Saldo awal eksplisit untuk kuantitas yang tidak punya jejak pergerakan. */
export interface OpeningBalance {
  productId: number;
  quantity: number;
  /** Pergerakan setelah waktu ini yang dihitung; `null` = semuanya. */
  asOf: Date | null;
}

export interface ComputeOptions {
  /**
   * Hitung item dari bill yang masih `open`. Bawaannya `true`, dan itu memang
   * yang benar untuk aplikasi ini: `saveOpenBill()` sudah memotong stok saat
   * bill disimpan, dan checkout hanya menerapkan selisihnya. Menyetel `false`
   * akan mengembalikan stok yang barangnya sudah keluar dan membuat produk
   * bisa terjual melebihi persediaan.
   */
  countOpenBills?: boolean;
  /** Jumlah desimal pembulatan; menyamai `Math.round(x * 1e6) / 1e6` di app. */
  precision?: number;
}

const DEFAULT_PRECISION = 6;

function round(value: number, precision: number): number {
  const f = Math.pow(10, precision);
  return Math.round(value * f) / f;
}

function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value).getTime();
  }
  return Number.NaN;
}

// ---------------------------------------------------------------------------
// Inti: fungsi murni
// ---------------------------------------------------------------------------

/**
 * Hitung stok satu produk dari acuan + pergerakan sesudahnya.
 *
 * Murni: tidak menyentuh Dexie, tidak membaca waktu sistem, dan urutan array
 * `movements` tidak memengaruhi hasil (penjumlahan bersifat komutatif). Itulah
 * yang membuat dua perangkat dengan kumpulan record yang sama pasti sampai pada
 * angka yang sama.
 *
 * Aturan penyaringan:
 *  - `isDeleted === 1` diabaikan.
 *  - Pergerakan pada atau sebelum `baseline.asOf` diabaikan. Sengaja memakai
 *    "benar-benar sesudah", bukan "sejak": saat stock opname diselesaikan,
 *    `StockOpname.tsx` menulis checkpoint DAN record penyesuaian
 *    `stockIns`/`stockOuts` dengan stempel waktu yang persis sama. Kalau
 *    perbandingannya `>=`, selisih opname akan terhitung dua kali.
 *  - Pergerakan tanpa tanggal yang sah hanya dihitung bila tidak ada acuan
 *    berwaktu, karena ia tidak bisa diurutkan terhadap acuan itu.
 */
export function computeStockFromMovements(
  baseline: StockBaseline,
  movements: readonly StockMovement[],
  options: ComputeOptions = {},
): number {
  const countOpenBills = options.countOpenBills !== false;
  const precision = options.precision ?? DEFAULT_PRECISION;
  const cutoff = baseline.asOf ? baseline.asOf.getTime() : null;

  let total = Number.isFinite(baseline.quantity) ? baseline.quantity : 0;

  for (const m of movements) {
    if (!m) continue;
    if (m.isDeleted === 1) continue;
    if (!Number.isFinite(m.quantity) || m.quantity === 0) continue;
    if (m.open && !countOpenBills) continue;

    const t = timeOf(m.date);
    if (Number.isNaN(t)) {
      // Tak bisa diurutkan terhadap acuan. Kalau tidak ada acuan berwaktu,
      // membuangnya justru menghilangkan penjualan yang nyata.
      if (cutoff !== null) continue;
    } else if (cutoff !== null && t <= cutoff) {
      continue;
    }

    total += m.quantity;
  }

  return round(total, precision);
}

// ---------------------------------------------------------------------------
// Pemilihan acuan
// ---------------------------------------------------------------------------

/** Checkpoint hasil stock opname yang sudah `completed`. */
export interface OpnameCheckpoint {
  /** `stockOpnameItems.realStock` — hitungan fisik, nilai MUTLAK bukan selisih. */
  realStock: number;
  /** `stockOpnames.date` saat sesi diselesaikan. */
  date: Date;
  /** Pemecah seri lintas perangkat; `id` lokal berbeda di tiap HP. */
  uid?: string;
  id?: number;
}

/**
 * Pilih checkpoint opname paling akhir sebagai acuan.
 *
 * Seri tanggal dipecah memakai `uid` (sama di semua perangkat) lebih dulu, baru
 * `id` lokal. Tanpa itu dua HP bisa memilih checkpoint berbeda untuk data yang
 * sama dan hasil hitungannya berbeda pula.
 */
export function pickOpnameBaseline(
  checkpoints: readonly OpnameCheckpoint[],
): StockBaseline | null {
  let best: OpnameCheckpoint | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;

  for (const c of checkpoints) {
    if (!c || !Number.isFinite(c.realStock)) continue;
    const t = timeOf(c.date);
    if (Number.isNaN(t)) continue;

    if (t > bestTime) {
      best = c;
      bestTime = t;
      continue;
    }
    if (t === bestTime && best) {
      const a = c.uid ?? '';
      const b = best.uid ?? '';
      if (a > b || (a === b && (c.id ?? 0) > (best.id ?? 0))) best = c;
    }
  }

  if (!best) return null;
  return { quantity: best.realStock, asOf: new Date(bestTime), source: 'opname' };
}

/**
 * Tentukan acuan untuk satu produk: opname `completed` terakhir kalau ada,
 * kalau tidak saldo awal eksplisit, kalau tidak juga — tidak ada acuan.
 */
export function resolveBaseline(
  checkpoints: readonly OpnameCheckpoint[],
  opening?: OpeningBalance | null,
): StockBaseline {
  const fromOpname = pickOpnameBaseline(checkpoints);
  if (fromOpname) return fromOpname;

  if (opening && Number.isFinite(opening.quantity)) {
    const t = opening.asOf ? timeOf(opening.asOf) : Number.NaN;
    return {
      quantity: opening.quantity,
      asOf: Number.isNaN(t) ? null : new Date(t),
      source: 'opening',
    };
  }

  return { quantity: 0, asOf: null, source: 'none' };
}

/**
 * Balik ledger: saldo awal tersirat = stok sekarang − total pergerakan.
 *
 * Hanya sah dipakai di perangkat yang `products.stock`-nya masih dipercaya,
 * yaitu SEBELUM merge lintas perangkat sempat menimpanya. Setelah itu angka
 * yang dibalik ikut membawa kerusakan yang mau kita perbaiki.
 */
export function deriveOpeningQuantity(
  currentStock: number,
  movements: readonly StockMovement[],
  options: ComputeOptions = {},
): number {
  const zero: StockBaseline = { quantity: 0, asOf: null, source: 'none' };
  const net = computeStockFromMovements(zero, movements, options);
  const precision = options.precision ?? DEFAULT_PRECISION;
  return round((Number.isFinite(currentStock) ? currentStock : 0) - net, precision);
}

// ---------------------------------------------------------------------------
// Lapisan Dexie
// ---------------------------------------------------------------------------

/** Bagian Dexie yang dipakai saja, supaya gampang dipalsukan saat tes. */
export interface StockDb {
  table(name: string): {
    toArray(): Promise<any[]>;
    where(index: string): {
      anyOf(values: any[]): { toArray(): Promise<any[]> };
      equals(value: any): { toArray(): Promise<any[]>; first(): Promise<any> };
    };
    update(key: any, changes: any): Promise<any>;
  };
}

/**
 * Di atas jumlah ini, satu kali baca seluruh tabel lebih murah daripada
 * `anyOf()` dengan ribuan kunci. Yang penting: berapa pun jumlah produknya,
 * setiap tabel dibaca TEPAT SEKALI per pemanggilan — tidak pernah per produk.
 */
const ANY_OF_THRESHOLD = 200;

async function readByProduct(
  db: StockDb,
  tableName: string,
  productIds: number[] | null,
): Promise<any[]> {
  const t = db.table(tableName);
  if (!productIds || productIds.length > ANY_OF_THRESHOLD) return t.toArray();
  if (productIds.length === 0) return [];
  return t.where('productId').anyOf(productIds).toArray();
}

async function readByIds(
  db: StockDb,
  tableName: string,
  ids: number[],
): Promise<any[]> {
  if (ids.length === 0) return [];
  const t = db.table(tableName);
  if (ids.length > ANY_OF_THRESHOLD) return t.toArray();
  return t.where('id').anyOf(ids).toArray();
}

function pushMovement(
  map: Map<number, StockMovement[]>,
  productId: unknown,
  m: StockMovement,
): void {
  if (typeof productId !== 'number' || !Number.isFinite(productId)) return;
  let list = map.get(productId);
  if (!list) {
    list = [];
    map.set(productId, list);
  }
  list.push(m);
}

export interface GatheredMovements {
  /** productId → pergerakan yang sudah dinormalkan (bertanda). */
  movements: Map<number, StockMovement[]>;
  /** productId → checkpoint dari opname yang `completed`. */
  checkpoints: Map<number, OpnameCheckpoint[]>;
}

/**
 * Kumpulkan pergerakan untuk sekumpulan produk dalam satu putaran.
 *
 * `productIds === null` berarti semua produk.
 *
 * Yang sengaja disaring di sini:
 *  - `transactionItems` yang transaksinya sudah tidak ada. Ini bukan kasus
 *    teoretis: `setupSyncHooks` hanya menulis tombstone untuk `transactions`,
 *    tidak untuk `transactionItems`, jadi saat penghapusan transaksi menyebar
 *    ke perangkat lain item-itemnya tertinggal sebagai yatim. Menghitungnya
 *    berarti memotong stok untuk penjualan yang sudah dibatalkan.
 *  - `transactions.status` selain `open`/`completed`.
 *  - `stockOpnameItems` yang sesinya hilang atau masih `draft`. Sesi `draft`
 *    belum menyentuh stok sama sekali (`handleSubmitOpname` yang menerapkannya).
 */
export async function gatherMovements(
  db: StockDb,
  productIds: number[] | null,
): Promise<GatheredMovements> {
  const movements = new Map<number, StockMovement[]>();
  const checkpoints = new Map<number, OpnameCheckpoint[]>();
  const wanted = productIds ? new Set(productIds) : null;
  const keep = (pid: unknown) =>
    !wanted || (typeof pid === 'number' && wanted.has(pid));

  const [stockIns, stockOuts, txItems, opnameItems] = await Promise.all([
    readByProduct(db, 'stockIns', productIds),
    readByProduct(db, 'stockOuts', productIds),
    readByProduct(db, 'transactionItems', productIds),
    readByProduct(db, 'stockOpnameItems', productIds),
  ]);

  for (const r of stockIns) {
    if (!keep(r.productId)) continue;
    pushMovement(movements, r.productId, {
      kind: 'stockIn',
      quantity: Number(r.quantity) || 0,
      date: r.date,
      isDeleted: r.isDeleted,
      ref: `stockIns:${r.id ?? r.uid ?? '?'}`,
    });
  }

  for (const r of stockOuts) {
    if (!keep(r.productId)) continue;
    pushMovement(movements, r.productId, {
      kind: 'stockOut',
      quantity: -(Number(r.quantity) || 0),
      date: r.date,
      isDeleted: r.isDeleted,
      ref: `stockOuts:${r.id ?? r.uid ?? '?'}`,
    });
  }

  // Induk transaksi dibaca sekali untuk seluruh batch, bukan per item.
  const txIds = [
    ...new Set(
      txItems
        .filter((r) => keep(r.productId))
        .map((r) => r.transactionId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];
  const txs = await readByIds(db, 'transactions', txIds);
  const txById = new Map<number, any>();
  for (const t of txs) if (typeof t.id === 'number') txById.set(t.id, t);

  for (const r of txItems) {
    if (!keep(r.productId)) continue;
    const tx = txById.get(r.transactionId);
    if (!tx) continue; // item yatim — transaksinya sudah dihapus
    if (tx.isDeleted === 1) continue;
    if (tx.status !== 'open' && tx.status !== 'completed') continue;

    pushMovement(movements, r.productId, {
      kind: 'sale',
      quantity: -(Number(r.quantity) || 0),
      date: tx.date ?? tx.closedAt ?? tx.openedAt,
      open: tx.status === 'open',
      isDeleted: r.isDeleted,
      ref: `transactionItems:${r.id ?? r.uid ?? '?'}`,
    });
  }

  const opnameIds = [
    ...new Set(
      opnameItems
        .filter((r) => keep(r.productId))
        .map((r) => r.opnameId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];
  const opnames = await readByIds(db, 'stockOpnames', opnameIds);
  const opnameById = new Map<number, any>();
  for (const o of opnames) if (typeof o.id === 'number') opnameById.set(o.id, o);

  for (const r of opnameItems) {
    if (!keep(r.productId)) continue;
    if (r.isDeleted === 1) continue;
    const o = opnameById.get(r.opnameId);
    if (!o) continue; // sesi opname sudah dihapus
    if (o.isDeleted === 1) continue;
    if (o.status !== 'completed') continue; // draft belum menyentuh stok
    if (!Number.isFinite(Number(r.realStock))) continue;

    const pid = r.productId as number;
    let list = checkpoints.get(pid);
    if (!list) {
      list = [];
      checkpoints.set(pid, list);
    }
    list.push({
      realStock: Number(r.realStock),
      date: o.date,
      uid: o.uid,
      id: o.id,
    });
  }

  return { movements, checkpoints };
}

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

export type MissingBaselinePolicy =
  /** Biarkan stok lama; laporkan `unreliable`. Bawaan — paling aman. */
  | 'skip'
  /** Hitung dari nol. Akan MENGHAPUS kuantitas yang tidak punya jejak. */
  | 'zero'
  /** Simpulkan saldo awal dari `products.stock` sekarang (lihat peringatan). */
  | 'derive';

export interface RecomputeOptions extends ComputeOptions {
  /** Saldo awal eksplisit per produk, dari `deriveOpeningBalances()`. */
  openingBalances?: readonly OpeningBalance[] | Map<number, OpeningBalance>;
  /** Apa yang dilakukan bila produk tidak punya acuan sah. Bawaan `skip`. */
  onMissingBaseline?: MissingBaselinePolicy;
  /** Ikut menghitung produk yang sudah di-soft-delete. Bawaan `false`. */
  includeDeletedProducts?: boolean;
}

export interface RecomputedStock {
  productId: number;
  /** Nilai `products.stock` sebelum dihitung ulang. */
  previousStock: number;
  /** Hasil hitung ulang; sama dengan `previousStock` bila dilewati. */
  stock: number;
  changed: boolean;
  /** `false` bila `trackStock === false` — stok produk ini memang diabaikan. */
  tracked: boolean;
  baseline: StockBaseline;
  movementCount: number;
  /**
   * `true` bila hasilnya tidak boleh dipercaya: tidak ada acuan sah, sehingga
   * kuantitas tanpa jejak pergerakan tidak terwakili. Pemanggil TIDAK boleh
   * menuliskannya ke basis data.
   */
  unreliable: boolean;
}

function toOpeningMap(
  input: RecomputeOptions['openingBalances'],
): Map<number, OpeningBalance> {
  if (!input) return new Map();
  if (input instanceof Map) return input;
  const m = new Map<number, OpeningBalance>();
  for (const o of input) if (o && typeof o.productId === 'number') m.set(o.productId, o);
  return m;
}

async function loadProducts(db: StockDb, productIds: number[] | null): Promise<any[]> {
  if (!productIds) return db.table('products').toArray();
  if (productIds.length === 0) return [];
  return readByIds(db, 'products', productIds);
}

/** `trackStock !== false`, sama persis dengan `isStockManaged()` di `db.ts`. */
function isTracked(product: any): boolean {
  return product?.trackStock !== false;
}

/**
 * Hitung ulang stok untuk sekumpulan produk. TIDAK menulis apa pun.
 *
 * `productIds === null`/dihilangkan berarti seluruh produk. Setiap tabel dibaca
 * satu kali untuk seluruh batch, jadi biayanya tidak tumbuh per produk.
 */
export async function recomputeStockForProducts(
  db: StockDb,
  productIds: number[] | null = null,
  options: RecomputeOptions = {},
): Promise<RecomputedStock[]> {
  const policy = options.onMissingBaseline ?? 'skip';
  const openings = toOpeningMap(options.openingBalances);
  const precision = options.precision ?? DEFAULT_PRECISION;

  const products = await loadProducts(db, productIds);
  const targets = products.filter(
    (p) =>
      typeof p?.id === 'number' &&
      (options.includeDeletedProducts === true || p.isDeleted !== 1),
  );
  if (targets.length === 0) return [];

  const ids = targets.map((p) => p.id as number);
  const { movements, checkpoints } = await gatherMovements(
    db,
    productIds === null ? null : ids,
  );

  const results: RecomputedStock[] = [];

  for (const p of targets) {
    const id = p.id as number;
    const previousStock = Number(p.stock) || 0;
    const mine = movements.get(id) ?? [];

    if (!isTracked(p)) {
      // `trackStock === false`: produk selalu tersedia dan seluruh jalur di app
      // melewati pembaruan stok. Menghitung ulang di sini hanya akan mengarang
      // angka untuk kolom yang memang tidak dipakai.
      results.push({
        productId: id,
        previousStock,
        stock: previousStock,
        changed: false,
        tracked: false,
        baseline: { quantity: previousStock, asOf: null, source: 'none' },
        movementCount: mine.length,
        unreliable: false,
      });
      continue;
    }

    let baseline = resolveBaseline(checkpoints.get(id) ?? [], openings.get(id));

    if (baseline.source === 'none') {
      if (policy === 'skip') {
        results.push({
          productId: id,
          previousStock,
          stock: previousStock,
          changed: false,
          tracked: true,
          baseline,
          movementCount: mine.length,
          unreliable: true,
        });
        continue;
      }
      if (policy === 'derive') {
        baseline = {
          quantity: deriveOpeningQuantity(previousStock, mine, options),
          asOf: null,
          source: 'derived',
        };
      }
      // policy === 'zero': acuan 0 dipakai apa adanya.
    }

    const stock = computeStockFromMovements(baseline, mine, options);
    results.push({
      productId: id,
      previousStock,
      stock,
      changed: round(previousStock, precision) !== stock,
      tracked: true,
      baseline,
      movementCount: mine.length,
      unreliable: false,
    });
  }

  return results;
}

/** Hitung ulang satu produk. `null` bila produknya tidak ada / tersaring. */
export async function recomputeProductStock(
  db: StockDb,
  productId: number,
  options: RecomputeOptions = {},
): Promise<RecomputedStock | null> {
  const [res] = await recomputeStockForProducts(db, [productId], options);
  return res ?? null;
}

/**
 * Ambil saldo awal tersirat untuk produk-produk yang belum punya opname.
 *
 * Jalankan SEKALI di perangkat yang `products.stock`-nya masih dipercaya, lalu
 * simpan hasilnya. Modul ini sengaja tidak menyimpan sendiri.
 */
export async function deriveOpeningBalances(
  db: StockDb,
  productIds: number[] | null = null,
  options: ComputeOptions = {},
): Promise<OpeningBalance[]> {
  const products = await loadProducts(db, productIds);
  const targets = products.filter((p) => typeof p?.id === 'number' && isTracked(p));
  if (targets.length === 0) return [];

  const ids = targets.map((p) => p.id as number);
  const { movements } = await gatherMovements(db, productIds === null ? null : ids);

  return targets.map((p) => ({
    productId: p.id as number,
    quantity: deriveOpeningQuantity(Number(p.stock) || 0, movements.get(p.id) ?? [], options),
    asOf: null,
  }));
}

export interface ApplyOptions {
  /**
   * Ikut menulis hasil yang ditandai `unreliable`. Bawaan `false`, dan
   * sebaiknya biarkan begitu — hasil tanpa acuan bisa jauh lebih kecil dari
   * stok sebenarnya.
   */
  allowUnreliable?: boolean;
}

/**
 * Tuliskan hasil hitung ulang ke `products.stock`.
 *
 * `updatedAt` dan `syncedAt` sengaja ditulis ulang dengan nilai LAMANYA. Hook
 * di `db.ts` memperlakukan update yang tidak menyebut kedua field itu sebagai
 * perubahan pengguna: ia akan memajukan `updatedAt` dan mengosongkan
 * `syncedAt`. Untuk angka hasil turunan itu keliru — record akan terkirim lagi
 * sebagai perubahan baru, perangkat lain menghitung ulang dan mengirim balik,
 * dan sync tidak pernah tenang. Stok hasil hitung ulang adalah kesimpulan
 * lokal atas data yang sama, jadi ia tidak boleh menjadi peristiwa sync.
 */
export async function applyRecomputedStock(
  db: StockDb,
  results: readonly RecomputedStock[],
  options: ApplyOptions = {},
): Promise<number> {
  const table = db.table('products');
  let written = 0;

  for (const r of results) {
    if (!r.changed) continue;
    if (!r.tracked) continue;
    if (r.unreliable && options.allowUnreliable !== true) continue;

    const current = await table.where('id').equals(r.productId).first();
    if (!current) continue;

    await table.update(r.productId, {
      stock: r.stock,
      updatedAt: current.updatedAt ?? new Date(),
      syncedAt: current.syncedAt ?? null,
    });
    written++;
  }

  return written;
}

/** Hitung ulang lalu tuliskan; mengembalikan hasil hitungnya. */
export async function recomputeAndApply(
  db: StockDb,
  productIds: number[] | null = null,
  options: RecomputeOptions & ApplyOptions = {},
): Promise<RecomputedStock[]> {
  const results = await recomputeStockForProducts(db, productIds, options);
  await applyRecomputedStock(db, results, options);
  return results;
}

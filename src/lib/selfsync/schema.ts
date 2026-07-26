/**
 * Metadata tabel untuk sync mandiri.
 *
 * Semua pengetahuan tentang "tabel mana punya relasi ke mana" dikumpulkan di
 * satu berkas ini, supaya server tetap bodoh dan logika merge tidak perlu
 * menebak-nebak bentuk data.
 */

import type { UidTableName } from './uid';

/** Field yang menyimpan id lokal milik tabel lain. */
export interface ForeignKey {
  /** Nama field di record, mis. `categoryId`. */
  field: string;
  /** Tabel tujuan yang id-nya disimpan di field itu. */
  target: UidTableName;
}

export interface TableMeta {
  /** Relasi keluar; nilainya diterjemahkan id lokal <-> uid saat sync. */
  foreignKeys: ForeignKey[];
  /**
   * Field bertipe `Date`. JSON tidak punya tipe tanggal, jadi daftar ini yang
   * dipakai untuk mengembalikan string ISO menjadi `Date` saat data masuk.
   * Sengaja eksplisit, bukan ditebak dari isinya — field catatan bisa saja
   * kebetulan berisi teks yang mirip tanggal.
   */
  dateFields: string[];
  /**
   * Field dengan indeks unik (`&` di skema Dexie). Dua perangkat bisa membuat
   * nilai yang sama secara mandiri — mis. dua kasir sama-sama menambah produk
   * ber-SKU `IND001` — sehingga saat digabung akan bentrok. Daftar ini dipakai
   * merge untuk mendeteksi dan menyelesaikannya, bukan supaya sync berhenti
   * dengan ConstraintError.
   */
  uniqueFields: string[];
}

/**
 * Urutan penerapan saat menerima data: induk sebelum anak.
 *
 * Menerjemahkan `transactionItems.transactionId` mustahil kalau transaksinya
 * belum ada di perangkat ini, jadi urutan di sini bukan sekadar rapi-rapian —
 * ia menentukan benar atau tidaknya hasil merge.
 */
export const MERGE_ORDER: UidTableName[] = [
  // Tanpa relasi keluar.
  'categories',
  'suppliers',
  'customers',
  'units',
  'paymentMethods',
  'users',
  'expenseCategories',
  // Bergantung pada yang di atas.
  'products',
  'stockIns',
  'stockOuts',
  'hppHistory',
  'transactions',
  'transactionItems',
  'expenses',
  'debts',
  'debtPayments',
  'stockOpnames',
  'stockOpnameItems',
];

export const TABLE_META: Record<UidTableName, TableMeta> = {
  categories: {
    foreignKeys: [],
    dateFields: ['createdAt', 'deletedAt', 'updatedAt'],
    uniqueFields: [],
  },
  suppliers: {
    foreignKeys: [],
    dateFields: ['createdAt', 'deletedAt', 'updatedAt'],
    uniqueFields: [],
  },
  customers: {
    foreignKeys: [],
    dateFields: ['createdAt', 'deletedAt', 'updatedAt'],
    uniqueFields: [],
  },
  units: {
    foreignKeys: [],
    dateFields: ['createdAt', 'deletedAt', 'updatedAt'],
    uniqueFields: ['name'],
  },
  paymentMethods: {
    foreignKeys: [],
    dateFields: ['createdAt', 'updatedAt'],
    uniqueFields: [],
  },
  users: {
    foreignKeys: [],
    dateFields: ['createdAt', 'lastLoginAt', 'updatedAt'],
    uniqueFields: ['username'],
  },
  expenseCategories: {
    foreignKeys: [],
    dateFields: ['createdAt', 'deletedAt', 'updatedAt'],
    uniqueFields: [],
  },
  products: {
    foreignKeys: [
      { field: 'categoryId', target: 'categories' },
      { field: 'createdBy', target: 'users' },
      { field: 'updatedBy', target: 'users' },
    ],
    dateFields: ['createdAt', 'updatedAt', 'deletedAt'],
    uniqueFields: ['sku'],
  },
  stockIns: {
    foreignKeys: [
      { field: 'productId', target: 'products' },
      { field: 'supplierId', target: 'suppliers' },
      { field: 'createdBy', target: 'users' },
    ],
    dateFields: ['date', 'updatedAt'],
    uniqueFields: [],
  },
  stockOuts: {
    foreignKeys: [
      { field: 'productId', target: 'products' },
      { field: 'createdBy', target: 'users' },
    ],
    dateFields: ['date', 'updatedAt'],
    uniqueFields: [],
  },
  hppHistory: {
    foreignKeys: [{ field: 'productId', target: 'products' }],
    dateFields: ['date', 'updatedAt'],
    uniqueFields: [],
  },
  transactions: {
    foreignKeys: [
      { field: 'paymentMethodId', target: 'paymentMethods' },
      { field: 'customerId', target: 'customers' },
      { field: 'createdBy', target: 'users' },
    ],
    dateFields: ['date', 'openedAt', 'closedAt', 'updatedAt'],
    uniqueFields: ['receiptNumber'],
  },
  transactionItems: {
    foreignKeys: [
      { field: 'transactionId', target: 'transactions' },
      { field: 'productId', target: 'products' },
    ],
    dateFields: [],
    uniqueFields: [],
  },
  expenses: {
    foreignKeys: [
      { field: 'categoryId', target: 'expenseCategories' },
      { field: 'paymentMethodId', target: 'paymentMethods' },
      { field: 'createdBy', target: 'users' },
    ],
    dateFields: ['date', 'createdAt', 'deletedAt', 'updatedAt'],
    uniqueFields: [],
  },
  debts: {
    foreignKeys: [
      { field: 'transactionId', target: 'transactions' },
      { field: 'customerId', target: 'customers' },
    ],
    dateFields: ['createdAt', 'settledAt', 'updatedAt'],
    uniqueFields: ['transactionId'],
  },
  debtPayments: {
    foreignKeys: [
      { field: 'debtId', target: 'debts' },
      { field: 'paymentMethodId', target: 'paymentMethods' },
      { field: 'createdBy', target: 'users' },
    ],
    dateFields: ['date', 'updatedAt'],
    uniqueFields: [],
  },
  stockOpnames: {
    foreignKeys: [{ field: 'createdBy', target: 'users' }],
    dateFields: ['date', 'updatedAt'],
    uniqueFields: [],
  },
  stockOpnameItems: {
    foreignKeys: [
      { field: 'opnameId', target: 'stockOpnames' },
      { field: 'productId', target: 'products' },
    ],
    dateFields: [],
    uniqueFields: [],
  },
};

/**
 * Field yang TIDAK pernah dikirim ke server.
 *
 * `id` khusus per perangkat, dan `syncedAt` adalah catatan lokal tentang sync
 * itu sendiri — mengirimnya hanya akan memicu putaran sync tanpa akhir.
 */
export const LOCAL_ONLY_FIELDS = ['id', 'syncedAt'] as const;

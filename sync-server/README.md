# FreeKasir Sync Server

Server sinkronisasi untuk aplikasi kasir offline-first **FreeKasir**, jalan di
**Cloudflare Workers + D1**. Beberapa HP/tablet di satu toko masing-masing punya
salinan IndexedDB sendiri; server ini yang membuat semuanya nyambung.

> Folder ini **berdiri sendiri**. Worker frontend di root repo tidak ada
> hubungannya dan tidak boleh ikut diubah. Semua perintah di bawah dijalankan
> **dari dalam folder `sync-server/`**.

---

## Apa yang dikerjakan server ini (dan apa yang TIDAK)

Server ini **penyimpanan bodoh**. Dia cuma tahu:

> "Ada baris dengan `table` ini, `uid` ini, terakhir diubah jam segini, isinya
> blob JSON ini."

Server **tidak tahu** apa itu produk, transaksi, atau stok. Server **tidak**
menerjemahkan foreign key dan **tidak** menghitung ulang stok. Semua itu
dikerjakan di aplikasi (client). Kalau nanti ada kolom baru di aplikasi, server
ini **tidak perlu diubah sama sekali**.

Yang dilakukan server hanya dua hal:

1. Menerima perubahan dari sebuah device dan menyimpannya.
2. Mengembalikan semua perubahan yang belum pernah dilihat device itu.

---

## Cara pasang (ikuti berurutan)

Butuh **Node.js 18+** terpasang dan sebuah **akun Cloudflare** (free tier cukup).
Semua perintah di bawah dijalankan dari folder `sync-server/`.

### Langkah 0 — masuk ke folder ini

```bash
cd sync-server
```

### Langkah 1 — login ke Cloudflare

Browser akan terbuka, klik **Allow**.

```bash
npx wrangler login
```

### Langkah 2 — buat database D1

```bash
npx wrangler d1 create freekasir-sync
```

Outputnya kira-kira seperti ini:

```
✅ Successfully created DB 'freekasir-sync'

[[d1_databases]]
binding = "DB"
database_name = "freekasir-sync"
database_id = "a1b2c3d4-5678-90ab-cdef-1234567890ab"
```

**Salin nilai `database_id` itu.**

### Langkah 3 — tempel `database_id` ke `wrangler.jsonc`

Buka file `wrangler.jsonc` di folder ini. Cari baris:

```jsonc
"database_id": "<PASTE_DATABASE_ID>"
```

Ganti `<PASTE_DATABASE_ID>` dengan id dari Langkah 2 (tanda kutipnya tetap ada):

```jsonc
"database_id": "a1b2c3d4-5678-90ab-cdef-1234567890ab"
```

Simpan filenya.

### Langkah 4 — buat tabelnya

```bash
npx wrangler d1 execute freekasir-sync --remote --file=./schema.sql
```

Kalau ditanya konfirmasi, jawab **y**. Flag `--remote` itu **wajib** — tanpa itu
tabel cuma dibuat di komputer kamu, bukan di server Cloudflare.

### Langkah 5 — pasang password (secret)

```bash
npx wrangler secret put SYNC_SECRET
```

Akan muncul prompt untuk mengetik nilainya. Isi dengan string acak yang panjang
— ini satu-satunya pengaman server. Contoh cara bikin yang acak:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Simpan baik-baik.** Nilai yang sama harus dimasukkan ke setiap HP/tablet yang
dipakai di toko. Kalau hilang, tinggal ulangi Langkah 5 dengan nilai baru, lalu
perbarui di semua device.

### Langkah 6 — deploy

```bash
npx wrangler deploy
```

Outputnya menampilkan URL worker, misalnya:

```
https://kasirgratisan-sync.NAMA-AKUN.workers.dev
```

### Langkah 7 — cek sudah hidup

```bash
curl https://kasirgratisan-sync.NAMA-AKUN.workers.dev/api/health
```

Harus muncul:

```json
{"ok":true}
```

Selesai. Masukkan URL worker + `SYNC_SECRET` ke pengaturan sinkronisasi di
aplikasi FreeKasir di tiap device.

---

## Ringkasan perintah

```bash
cd sync-server
npx wrangler login
npx wrangler d1 create freekasir-sync
# tempel database_id ke wrangler.jsonc
npx wrangler d1 execute freekasir-sync --remote --file=./schema.sql
npx wrangler secret put SYNC_SECRET
npx wrangler deploy
```

Kalau sudah pernah `npm install` di folder ini, bisa pakai script pendek:
`npm run db:init`, `npm run secret`, `npm run deploy`.

---

## API

Semua request ke `/api/sync` **wajib** membawa header:

```
Authorization: Bearer <SYNC_SECRET>
```

Kalau salah atau tidak ada → **401**. Tidak ada login per-user; satu toko satu
secret bersama, itu memang desainnya.

### `GET /api/health`

Tanpa auth. Untuk mengecek server hidup.

```json
{ "ok": true }
```

### `POST /api/sync`

Satu-satunya endpoint yang sebenarnya. Push dan pull sekaligus dalam satu
request.

**Request:**

```json
{
  "deviceId": "hp-kasir-1",
  "since": 0,
  "changes": [
    {
      "table": "products",
      "uid": "3f2a…",
      "updatedAt": "2026-07-27T10:00:00.000Z",
      "deleted": false,
      "data": { "name": "Kopi Susu", "price": 12000 }
    }
  ]
}
```

| Field      | Keterangan                                                              |
| ---------- | ----------------------------------------------------------------------- |
| `deviceId` | Penanda device. Hanya untuk log; server tidak memakainya untuk filter.   |
| `since`    | Cursor dari response sebelumnya. Pertama kali kirim `0`.                 |
| `changes`  | Perubahan lokal yang mau dikirim. Boleh `[]` kalau cuma mau menarik data.|
| `updatedAt`| **Wajib** UTC ISO-8601 kanonik `YYYY-MM-DDTHH:MM:SS.sssZ` — lihat di bawah. |

#### Format `updatedAt` itu wajib persis

Setiap `updatedAt` harus persis seperti keluaran `Date.prototype.toISOString()`
di JavaScript, misalnya `2026-07-27T10:00:00.000Z`. Di client cukup:

```js
const updatedAt = new Date().toISOString();
```

Yang **ditolak** dengan 400 `invalid_updated_at_format`:

| Contoh                          | Kenapa ditolak            |
| ------------------------------- | ------------------------- |
| `2026-07-27T10:00:00Z`          | tidak ada milidetik       |
| `2026-07-27T10:00:00.000000Z`   | milidetiknya 6 digit      |
| `2026-07-27T17:00:00.000+07:00` | pakai offset, bukan UTC   |
| `2026-07-27 10:00:00.000Z`      | pemisahnya spasi          |
| `1785146400000`                 | epoch, bukan ISO          |
| `2026-02-31T10:00:00.000Z`      | tanggalnya tidak nyata    |

Kenapa serewel itu? Karena aturan last-write-wins membandingkan `updated_at`
**sebagai teks**. Perbandingan teks baru sama dengan urutan waktu kalau semua
device memakai format yang identik, lebar tetap, dan UTC. Tiga string
`2026-07-27T10:00:00Z`, `2026-07-27T10:00:00.000Z`, dan
`2026-07-27T17:00:00+07:00` menunjuk instan yang sama tapi urutan teksnya
berbeda-beda — kalau dibiarkan, tulisan basi bisa mengalahkan yang segar dan
menimpa data bagus **tanpa ada tanda apa pun**. Ditolak keras di depan jauh
lebih baik daripada data rusak diam-diam berbulan-bulan kemudian.

**Response:**

```json
{
  "cursor": 1234,
  "changes": [
    {
      "table": "products",
      "uid": "3f2a…",
      "updatedAt": "2026-07-27T10:00:00.000Z",
      "deleted": false,
      "data": { "name": "Kopi Susu", "price": 12000 },
      "serverSeq": 1234
    }
  ],
  "hasMore": true
}
```

- `cursor` — simpan nilai ini di device, kirim lagi sebagai `since` berikutnya.
- `hasMore` — kalau `true`, **langsung panggil lagi** dengan `since` = `cursor`
  yang baru, sampai `hasMore` jadi `false`.

**Kode status:**

| Kode | Arti                                                                    |
| ---- | ----------------------------------------------------------------------- |
| 200  | Sukses.                                                                 |
| 400  | Body atau field-nya tidak valid. Cek `error` di response.               |
| 401  | `SYNC_SECRET` salah atau tidak dikirim.                                 |
| 413  | `changes` lebih dari **200** item. Pecah jadi beberapa request.          |
| 500  | Gagal menulis. Tidak ada yang tersimpan — request boleh diulang apa adanya. |

Kode `error` yang penting:

| `error`                     | Artinya                                          |
| --------------------------- | ------------------------------------------------ |
| `invalid_updated_at_format` | `updatedAt` bukan ISO-8601 UTC kanonik. Response ikut menyebut `table`, `uid`, dan nilai yang diterima. |
| `payload_too_large`         | `changes` lebih dari 200 item.                    |
| `unauthorized`              | Secret salah.                                     |
| `write_failed`              | Transaksi gagal; tidak ada yang tertulis.         |

---

## Hal penting yang harus dipahami client

**1. Data yang baru kamu push akan ikut terbaca di pull-mu sendiri.**
Ini disengaja dan normal — push dan pull terjadi dalam satu transaksi. Client
harus melakukan dedupe (abaikan baris yang `uid`-nya baru saja dia kirim dengan
`updatedAt` yang sama).

**2. Aturan konflik: last-write-wins pada `updatedAt`.**
Kalau baris yang tersimpan di server punya `updatedAt` yang **lebih baru**,
kiriman client **dibuang** dan versi server dipertahankan. Kalau `updatedAt`
persis sama, kiriman client yang menang.

**3. `cursor` itu nomor urut milik server, bukan waktu.**
Jangan pernah mengirim timestamp sebagai `since`. Jam di HP toko sering salah;
`server_seq` dinaikkan server sendiri sehingga urutannya selalu benar.

Nomor itu diberikan **di dalam transaksi tulis yang sama**, bukan sebelumnya.
Ini penting untuk toko dengan beberapa kasir: kalau nomor dipesan lebih dulu di
query terpisah, dua push yang bersamaan bisa saling mendahului commit, device
lain sempat menarik nomor yang lebih tinggi dan memajukan cursornya, lalu baris
bernomor lebih kecil baru ikut commit — dan **hilang selamanya** dari pull
berikutnya. Jaminannya sekarang: tidak ada baris yang bisa commit dengan nomor
di bawah cursor yang sudah pernah terlihat client.

**4. Delete itu soft delete.**
Kirim `"deleted": true`, jangan hilangkan barisnya. Baris yang dihapus tetap
disinkronkan supaya device lain tahu ada penghapusan.

**5. Maksimum 200 perubahan per request.**
Lebih dari itu dijawab 413. Ini disengaja supaya client memecah kiriman, bukan
server diam-diam memotong data.

**6. Maksimum 500 baris per pull.**
Kalau masih ada sisa, `hasMore` bernilai `true`. Ulangi sampai `false`.

**7. `updatedAt` harus `new Date().toISOString()`.**
Format lain ditolak 400. Jangan bikin formatter timestamp sendiri, dan jangan
kirim waktu lokal. Lihat bagian format `updatedAt` di atas.

---

## Batasan free tier yang sudah diperhitungkan

Cloudflare free tier membatasi **50 query D1 per request** dan **10 ms CPU**.
Worker ini dirancang supaya tidak pernah mendekati batas itu:

| Bagian                      | Jumlah query                            |
| --------------------------- | --------------------------------------- |
| Upsert (16 baris/statement) | maksimal 13 (untuk 200 perubahan)       |
| Menaikkan counter seq       | 1 (dilewati kalau `changes` kosong)     |
| Pull                        | 1                                       |
| **Total maksimum**          | **15 query**, berapa pun ukuran payload |

Caranya: `INSERT … VALUES (…),(…),(…) ON CONFLICT DO UPDATE` multi-baris,
dikirim lewat `env.DB.batch()`. Satu record memakai 6 bound parameter dan D1
membatasi 100 parameter per query, jadi satu statement diisi 16 record
(16 × 6 = 96).

Seluruh statement itu — upsert, kenaikan counter, dan pull — masuk ke **satu**
`env.DB.batch()`, yang dijalankan D1 sebagai satu transaksi. `server_seq` tiap
baris dihitung di dalamnya lewat `(SELECT value FROM meta WHERE key='seq') + k`,
dan statement penaik counter sengaja diletakkan **setelah** semua upsert supaya
tiap baris membaca nilai yang sama (sebelum kenaikan). Urutan ini bukan
kosmetik; ada test khusus yang menjaganya.

Untuk hemat CPU, blob `data` **tidak pernah** di-`JSON.parse` saat pull —
response body dirakit sebagai string dan blob JSON disisipkan apa adanya.

---

## Menjalankan test

```bash
npx vitest run
```

Test memakai **SQLite in-memory bawaan Node** (`node:sqlite`) sebagai tiruan
binding D1, jadi tidak perlu akun Cloudflare dan semantik SQL-nya tetap asli.
Butuh Node 22.5+ (di Node 22 tambahkan flag `--experimental-sqlite`).

Yang diuji: penolakan auth, round-trip insert, aturan last-write-wins,
paginasi cursor, penolakan 413, validasi format `updatedAt`, penegakan batas
50-query dan batas 100 bound parameter, serta **dua push yang bersamaan** —
satu push ditahan tepat di ambang commit sementara push lain selesai duluan,
untuk membuktikan tidak ada baris yang bisa lolos di bawah cursor yang sudah
terlihat client.

Untuk mengecek konfigurasi tanpa benar-benar deploy:

```bash
npx wrangler deploy --dry-run
```

---

## Struktur file

```
sync-server/
├── wrangler.jsonc     konfigurasi worker + binding D1
├── schema.sql         skema tabel D1
├── package.json       script lokal (deploy, db:init, test)
├── tsconfig.json
├── vitest.config.ts
├── src/
│   └── index.ts       seluruh worker
└── test/
    ├── fake-d1.ts     tiruan binding D1 di atas node:sqlite
    └── sync.test.ts   test
```

/// <reference types="@cloudflare/workers-types" />

/**
 * FreeKasir sync server — DUMB STORAGE.
 *
 * Server ini TIDAK tahu apa-apa soal produk, transaksi, stok, atau foreign key.
 * Ia hanya menyimpan baris opaque `(table, uid, updatedAt, deleted, data)` dan
 * mengembalikan apa saja yang berubah sejak cursor tertentu. Semua merge,
 * penerjemahan FK, dan perhitungan ulang stok dikerjakan di client.
 *
 * Batasan Cloudflare free tier yang dihormati di sini:
 *  - Maks 50 query D1 per invocation  -> lihat komentar "ANGGARAN QUERY" di bawah.
 *  - Maks 100 bound parameter per query D1 -> CHUNK_RECORDS = 16 (16 x 6 = 96).
 *  - 10 ms CPU per invocation -> blob `data` TIDAK pernah di-JSON.parse saat pull;
 *    response body dirakit sebagai string dan blob disisipkan apa adanya.
 *
 * ATOMISITAS server_seq: alokasi nomor urut TIDAK boleh terjadi di luar
 * transaksi tulis. Kalau counter dinaikkan lebih dulu di query terpisah, dua
 * push yang bersamaan bisa saling mendahului commit; device lain sempat menarik
 * seq yang lebih tinggi, memajukan cursornya, lalu seq yang lebih rendah baru
 * ikut commit dan HILANG SELAMANYA dari pull berikutnya. Karena itu seq dibaca
 * lewat subselect di dalam statement INSERT dan counter dinaikkan oleh statement
 * lain di dalam `env.DB.batch()` yang sama -- satu transaksi, tak ada celah.
 */

export interface Env {
  DB: D1Database;
  SYNC_SECRET: string;
}

/** Maksimum item dalam `changes` per request. Lebih dari ini -> HTTP 413. */
export const MAX_CHANGES = 200;

/** Maksimum baris yang dikembalikan per pull. */
export const MAX_PULL = 500;

/**
 * Record per statement INSERT. D1 membatasi 100 bound parameter per query dan
 * tiap record memakai 6 parameter, jadi 16 x 6 = 96 -> aman di bawah limit.
 */
export const CHUNK_RECORDS = 16;

const PULL_SQL =
  'SELECT table_name, uid, updated_at, deleted, data, server_seq ' +
  'FROM records WHERE server_seq > ? ORDER BY server_seq LIMIT ?';

/**
 * Menaikkan counter sebanyak jumlah baris yang ditulis. Statement ini WAJIB
 * diletakkan SESUDAH semua statement upsert di dalam batch, supaya subselect
 * `SEQ_EXPR` di tiap upsert masih membaca nilai sebelum kenaikan.
 */
const BUMP_SEQ_SQL = "UPDATE meta SET value = value + ? WHERE key = 'seq'";

/**
 * Ekspresi server_seq untuk satu baris: nilai counter saat ini + urutan baris
 * dalam request (1-based, di-bind sebagai parameter). Dievaluasi di dalam
 * transaksi batch, jadi tidak bisa didahului push lain.
 */
const SEQ_EXPR = "(SELECT value FROM meta WHERE key = 'seq') + ?";

/**
 * `updated_at` wajib UTC ISO-8601 kanonik dengan tepat 3 digit milidetik,
 * yaitu persis keluaran `Date.prototype.toISOString()` di JS.
 *
 * Ini bukan kerewelan: seluruh aturan last-write-wins membandingkan kolom ini
 * sebagai TEKS (baik saat dedupe di JS maupun di `ON CONFLICT ... WHERE` di
 * SQL). Perbandingan teks hanya sama dengan urutan waktu kalau formatnya
 * seragam, lebar tetap, dan zona waktunya UTC. Kalau ada client mengirim
 * "2026-07-27T10:00:00Z" atau "2026-07-27T17:00:00+07:00", instannya bisa sama
 * tapi urutan teksnya berbeda -> tulisan basi bisa mengalahkan yang segar dan
 * menimpa data bagus tanpa suara. Lebih baik ditolak keras dan lebih awal.
 */
const ISO_UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCanonicalIsoUtc(s: string): boolean {
  // Cek panjang dulu: penolakan paling murah untuk mayoritas kasus salah.
  if (s.length !== 24 || !ISO_UTC_MS_RE.test(s)) return false;
  // Round-trip menolak tanggal yang polanya benar tapi tidak nyata,
  // misalnya "2026-02-31T00:00:00.000Z".
  const t = Date.parse(s);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString() === s;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function fail(status: number, code: string): Response {
  return json('{"ok":false,"error":' + JSON.stringify(code) + '}', status);
}

/**
 * Perbandingan constant-time via double-HMAC dengan kunci acak sekali pakai.
 * Panjang input tidak bocor karena yang dibandingkan adalah dua digest 32-byte.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const ha = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/** Ambil token dari header `Authorization: Bearer <token>`. */
function bearerToken(request: Request): string | null {
  const raw = request.headers.get('Authorization');
  if (!raw) return null;
  // Prefix "Bearer " (7 char), case-insensitive.
  if (raw.length < 8) return null;
  if (raw.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return raw.slice(7).trim();
}

/** Cache SQL upsert per jumlah tuple; isolate dipakai ulang antar request. */
const upsertSqlCache = new Map<number, string>();

function upsertSql(count: number): string {
  const cached = upsertSqlCache.get(count);
  if (cached !== undefined) return cached;
  // 6 bound parameter per baris: 5 kolom + offset urutan untuk SEQ_EXPR.
  const tuples = new Array(count).fill('(?,?,?,?,?,' + SEQ_EXPR + ')').join(',');
  const sql =
    'INSERT INTO records (table_name, uid, updated_at, deleted, data, server_seq) VALUES ' +
    tuples +
    ' ON CONFLICT(table_name, uid) DO UPDATE SET ' +
    'updated_at = excluded.updated_at, ' +
    'deleted    = excluded.deleted, ' +
    'data       = excluded.data, ' +
    'server_seq = excluded.server_seq ' +
    // Last-write-wins pada updated_at. Perbandingan teks di sini sah karena
    // format sudah dipaksa kanonik (lihat ISO_UTC_MS_RE). `>=` berarti seri
    // dimenangkan incoming. Kalau baris tersimpan strictly lebih baru, update
    // di-skip dan server_seq lama dipertahankan.
    'WHERE excluded.updated_at >= records.updated_at';
  upsertSqlCache.set(count, sql);
  return sql;
}

interface PendingRow {
  table: string;
  uid: string;
  updatedAt: string;
  deleted: number;
  data: string;
}

// ---------------------------------------------------------------------------
// POST /api/sync
// ---------------------------------------------------------------------------

export async function handleSync(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'invalid_json');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'invalid_body');
  }

  const since = body.since === undefined || body.since === null ? 0 : body.since;
  if (typeof since !== 'number' || !Number.isInteger(since) || since < 0) {
    return fail(400, 'invalid_since');
  }

  const changes = body.changes === undefined || body.changes === null ? [] : body.changes;
  if (!Array.isArray(changes)) return fail(400, 'invalid_changes');

  // Tolak payload gemuk supaya client memaginasi, bukan server diam-diam memotong.
  if (changes.length > MAX_CHANGES) {
    return json(
      '{"ok":false,"error":"payload_too_large","maxChanges":' + MAX_CHANGES + '}',
      413,
    );
  }

  // Dedupe per (table, uid): satu request tidak boleh menabrak dirinya sendiri
  // di dalam satu statement multi-row. Yang menang: updatedAt terbesar,
  // seri dimenangkan yang muncul belakangan. Perbandingan teks di bawah sah
  // karena format updatedAt sudah dipaksa kanonik lebih dulu.
  const pending = new Map<string, PendingRow>();
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c === null || typeof c !== 'object') return fail(400, 'invalid_change');
    const table = c.table;
    const uid = c.uid;
    const updatedAt = c.updatedAt;
    if (typeof table !== 'string' || table.length === 0) return fail(400, 'invalid_change_table');
    if (typeof uid !== 'string' || uid.length === 0) return fail(400, 'invalid_change_uid');
    if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
      return fail(400, 'invalid_change_updated_at');
    }
    if (!isCanonicalIsoUtc(updatedAt)) {
      return json(
        '{"ok":false,"error":"invalid_updated_at_format"' +
          ',"expected":"YYYY-MM-DDTHH:MM:SS.sssZ (UTC, persis Date.toISOString())"' +
          ',"received":' + JSON.stringify(updatedAt.slice(0, 64)) +
          ',"table":' + JSON.stringify(table) +
          ',"uid":' + JSON.stringify(uid) +
          '}',
        400,
      );
    }
    // Pemisah U+0000 tidak mungkin muncul di nama tabel maupun uid, jadi
    // ("a", "b:c") dan ("a:b", "c") dijamin tidak bertabrakan.
    const key = table + '\u0000' + uid;
    const prev = pending.get(key);
    if (prev !== undefined && prev.updatedAt > updatedAt) continue;
    pending.set(key, {
      table,
      uid,
      updatedAt,
      deleted: c.deleted ? 1 : 0,
      data: JSON.stringify(c.data === undefined ? null : c.data),
    });
  }

  const rows = [...pending.values()];
  const n = rows.length;

  // --- ANGGARAN QUERY ------------------------------------------------------
  // ceil(n/16): statement upsert multi-row, n <= 200 -> maks 13
  // 1 query  : menaikkan counter server_seq
  // 1 query  : SELECT pull
  // -------------------------------------------------------------------------
  // Total maksimum = 13 + 1 + 1 = 15 query per request, apa pun ukuran payload.
  // Jauh di bawah batas 50 query per invocation di free tier.
  // Semuanya masuk SATU `env.DB.batch()` = satu transaksi.

  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < n; offset += CHUNK_RECORDS) {
    const size = Math.min(CHUNK_RECORDS, n - offset);
    const params: unknown[] = new Array(size * 6);
    for (let i = 0; i < size; i++) {
      const r = rows[offset + i];
      const p = i * 6;
      params[p] = r.table;
      params[p + 1] = r.uid;
      params[p + 2] = r.updatedAt;
      params[p + 3] = r.deleted;
      params[p + 4] = r.data;
      // Offset 1-based dalam request. Nilai absolutnya baru ditentukan di dalam
      // transaksi: SEQ_EXPR menambahkannya ke counter yang dibaca saat itu juga.
      params[p + 5] = offset + i + 1;
    }
    statements.push(env.DB.prepare(upsertSql(size)).bind(...params));
  }

  // WAJIB setelah semua upsert: selama counter belum naik, setiap SEQ_EXPR di
  // atas membaca nilai yang sama (pre-bump), sehingga baris ke-k dapat seq
  // `value + k` tanpa tabrakan. Kalau statement ini dipindah ke depan, semua
  // baris akan menabrak nomor yang sudah dipakai.
  if (n > 0) statements.push(env.DB.prepare(BUMP_SEQ_SQL).bind(n));

  // Pull ikut dalam batch yang sama supaya semuanya satu transaksi. Konsekuensi
  // yang disengaja: baris yang baru saja di-push client akan ikut terbaca di
  // pull-nya sendiri. Client sudah dedupe, jadi ini aman.
  const pullStmt = env.DB.prepare(PULL_SQL).bind(since, MAX_PULL);

  let pulled: any[];
  try {
    if (statements.length === 0) {
      const res = await pullStmt.all<any>();
      pulled = res.results || [];
    } else {
      statements.push(pullStmt);
      const results = await env.DB.batch<any>(statements);
      pulled = results[results.length - 1].results || [];
    }
  } catch (err) {
    // Batch adalah satu transaksi: kalau gagal, TIDAK ada yang tertulis dan
    // counter tidak naik. Client aman untuk mengulang request yang sama.
    console.error('sync batch failed', err);
    return fail(500, 'write_failed');
  }

  // Rakit response manual: blob `data` disisipkan mentah, tanpa parse/stringify.
  const count = pulled.length;
  const parts: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const r = pulled[i];
    const blob = r.data;
    parts[i] =
      '{"table":' + JSON.stringify(r.table_name) +
      ',"uid":' + JSON.stringify(r.uid) +
      ',"updatedAt":' + JSON.stringify(r.updated_at) +
      ',"deleted":' + (r.deleted ? 'true' : 'false') +
      ',"data":' + (typeof blob === 'string' && blob.length > 0 ? blob : 'null') +
      ',"serverSeq":' + r.server_seq +
      '}';
  }

  const cursor = count > 0 ? Number(pulled[count - 1].server_seq) : since;
  const hasMore = count === MAX_PULL;

  return json(
    '{"cursor":' + cursor + ',"changes":[' + parts.join(',') + '],"hasMore":' + hasMore + '}',
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Health check sengaja tanpa auth: dipakai untuk smoke test.
  if (pathname === '/api/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, 'method_not_allowed');
    }
    return json('{"ok":true}');
  }

  if (pathname === '/api/sync') {
    if (request.method !== 'POST') return fail(405, 'method_not_allowed');

    const secret = env.SYNC_SECRET;
    if (typeof secret !== 'string' || secret.length === 0) {
      return fail(500, 'sync_secret_not_configured');
    }
    const token = bearerToken(request);
    if (token === null || !(await timingSafeEqual(token, secret))) {
      return json('{"ok":false,"error":"unauthorized"}', 401);
    }

    return handleSync(request, env);
  }

  return fail(404, 'not_found');
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeD1 } from './fake-d1';
import {
  handleRequest,
  MAX_CHANGES,
  MAX_PULL,
  CHUNK_RECORDS,
  type Env,
} from '../src/index';

const SECRET = 'rahasia-toko-123';

let db: FakeD1;
let env: Env;

beforeEach(() => {
  db = new FakeD1();
  env = { DB: db as unknown as Env['DB'], SYNC_SECRET: SECRET };
});

/** Timestamp UTC ISO-8601 kanonik (persis format `Date.toISOString()`). */
function ts(hour: number, minute = 0): string {
  const h = String(hour).padStart(2, '0');
  const m = String(minute).padStart(2, '0');
  return `2026-07-27T${h}:${m}:00.000Z`;
}

const T1 = ts(10);
const T2 = ts(11);

type Change = {
  table: string;
  uid: string;
  updatedAt: string;
  deleted?: boolean;
  data?: unknown;
};

function syncRequest(body: unknown, token: string | null = SECRET): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = 'Bearer ' + token;
  return new Request('https://sync.example.com/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readResult(res: Response, queries: number) {
  const text = await res.text();
  return { status: res.status, queries, body: text ? JSON.parse(text) : null, raw: text };
}

async function sync(
  body: { deviceId?: string; since?: number; changes?: Change[] },
  token: string | null = SECRET,
) {
  db.resetQueryCount();
  const res = await handleRequest(syncRequest({ deviceId: 'dev-1', ...body }, token), env);
  return readResult(res, db.queryCount);
}

function makeChanges(n: number, prefix = 'u'): Change[] {
  const out: Change[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { table: 't', uid: prefix + i, updatedAt: T1, data: { i } };
  }
  return out;
}

/** Nilai counter `meta.seq` saat ini. */
function metaSeq(): number {
  const row = db.db.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as any;
  return Number(row.value);
}

/**
 * Menahan batch berikutnya tepat sebelum transaksinya dimulai.
 * Mengembalikan promise yang resolve saat batch itu tercapai, plus pelepasnya.
 */
function blockNextBatch(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  db.beforeBatch = async () => {
    signal();
    await blocked;
  };
  return { reached, release };
}

// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('mengembalikan ok tanpa auth', async () => {
    const res = await handleRequest(new Request('https://sync.example.com/api/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('tidak menyentuh D1 sama sekali', async () => {
    db.resetQueryCount();
    await handleRequest(new Request('https://sync.example.com/api/health'), env);
    expect(db.queryCount).toBe(0);
  });
});

describe('auth', () => {
  it('401 kalau header Authorization tidak ada', async () => {
    const r = await sync({ since: 0, changes: [] }, null);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('unauthorized');
  });

  it('401 kalau secret salah', async () => {
    const r = await sync({ since: 0, changes: [] }, 'secret-yang-salah');
    expect(r.status).toBe(401);
  });

  it('401 kalau secret hanya prefix yang benar', async () => {
    const r = await sync({ since: 0, changes: [] }, SECRET.slice(0, 5));
    expect(r.status).toBe(401);
  });

  it('401 kalau skema bukan Bearer', async () => {
    const res = await handleRequest(
      new Request('https://sync.example.com/api/sync', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + SECRET },
        body: '{}',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('menerima secret yang benar', async () => {
    const r = await sync({ since: 0, changes: [] });
    expect(r.status).toBe(200);
  });

  it('tidak menyentuh D1 saat auth gagal', async () => {
    const r = await sync({ since: 0, changes: makeChanges(1) }, 'salah');
    expect(r.status).toBe(401);
    expect(r.queries).toBe(0);
  });

  it('500 kalau SYNC_SECRET belum diset', async () => {
    env.SYNC_SECRET = '';
    const r = await sync({ since: 0, changes: [] });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('sync_secret_not_configured');
  });
});

describe('insert round-trip', () => {
  it('menyimpan perubahan lalu mengembalikannya di pull yang sama', async () => {
    const r = await sync({
      since: 0,
      changes: [
        { table: 'products', uid: 'p1', updatedAt: T1, data: { name: 'Kopi', price: 5000 } },
        { table: 'products', uid: 'p2', updatedAt: T2, data: { name: 'Teh', price: 4000 } },
      ],
    });

    expect(r.status).toBe(200);
    expect(r.body.changes).toHaveLength(2);
    expect(r.body.cursor).toBe(2);
    expect(r.body.hasMore).toBe(false);

    expect(r.body.changes[0]).toEqual({
      table: 'products',
      uid: 'p1',
      updatedAt: T1,
      deleted: false,
      data: { name: 'Kopi', price: 5000 },
      serverSeq: 1,
    });
  });

  it('data blob dikembalikan utuh, tidak double-encoded', async () => {
    const blob = { nested: { a: [1, 2, 3], b: 'teks "berkutip"' }, n: null, f: 1.5 };
    await sync({ since: 0, changes: [{ table: 'x', uid: 'u', updatedAt: T1, data: blob }] });
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes[0].data).toEqual(blob);
  });

  it('flag deleted ikut tersimpan', async () => {
    await sync({ since: 0, changes: [{ table: 'products', uid: 'p1', updatedAt: T1, data: {} }] });
    const r = await sync({
      since: 0,
      changes: [{ table: 'products', uid: 'p1', updatedAt: T2, deleted: true, data: {} }],
    });
    expect(r.body.changes).toHaveLength(1);
    expect(r.body.changes[0].deleted).toBe(true);
  });

  it('device lain melihat perubahan device pertama', async () => {
    await sync({
      since: 0,
      changes: [{ table: 'products', uid: 'p1', updatedAt: T1, data: { name: 'Kopi' } }],
    });
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes.map((c: any) => c.uid)).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// Alokasi server_seq — bagian paling rawan.
// ---------------------------------------------------------------------------

describe('alokasi server_seq', () => {
  it('server yang memberi nomor, bukan client', async () => {
    await sync({ since: 0, changes: [{ table: 't', uid: 'a', updatedAt: T1, data: {} }] });
    await sync({ since: 0, changes: [{ table: 't', uid: 'b', updatedAt: T1, data: {} }] });
    expect(db.rows().map((r) => Number(r.server_seq))).toEqual([1, 2]);
  });

  it('semua baris dalam satu request dapat nomor berurutan tanpa duplikat', async () => {
    // 200 perubahan = 13 statement upsert. Subselect di tiap statement harus
    // membaca nilai counter SEBELUM kenaikan, kalau tidak nomor akan bertabrakan
    // antar chunk. Ini yang membuktikan urutan statement di dalam batch benar.
    const r = await sync({ since: 0, changes: makeChanges(MAX_CHANGES) });
    expect(r.status).toBe(200);

    const seqs = db.rows().map((row) => Number(row.server_seq));
    expect(seqs).toHaveLength(MAX_CHANGES);
    expect(new Set(seqs).size).toBe(MAX_CHANGES);
    expect(seqs).toEqual(Array.from({ length: MAX_CHANGES }, (_, i) => i + 1));
  });

  it('counter meta selalu sama dengan seq tertinggi yang dipakai', async () => {
    await sync({ since: 0, changes: makeChanges(30, 'a') });
    expect(metaSeq()).toBe(30);
    await sync({ since: 0, changes: makeChanges(20, 'b') });
    expect(metaSeq()).toBe(50);
    const seqs = db.rows().map((row) => Number(row.server_seq));
    expect(Math.max(...seqs)).toBe(50);
  });

  it('request berikutnya selalu mulai di atas seq request sebelumnya', async () => {
    await sync({ since: 0, changes: makeChanges(5, 'a') });
    await sync({ since: 0, changes: makeChanges(5, 'b') });
    const rows = db.rows();
    const aMax = Math.max(
      ...rows.filter((r) => r.uid.startsWith('a')).map((r) => Number(r.server_seq)),
    );
    const bMin = Math.min(
      ...rows.filter((r) => r.uid.startsWith('b')).map((r) => Number(r.server_seq)),
    );
    expect(bMin).toBeGreaterThan(aMax);
  });

  it('pull kosong tidak menaikkan counter', async () => {
    await sync({ since: 0, changes: makeChanges(3) });
    const before = metaSeq();
    await sync({ since: 0, changes: [] });
    expect(metaSeq()).toBe(before);
  });
});

describe('dua push bersamaan (regresi kehilangan data)', () => {
  /**
   * Reproduksi bug alokasi seq di luar transaksi.
   *
   * Skenario nyata: dua kasir menekan "simpan" hampir bersamaan.
   *   - A masuk, lalu tertahan tepat di ambang commit.
   *   - B jalan sampai selesai dan commit.
   *   - Device ketiga menarik data sekarang dan memajukan cursornya.
   *   - A baru commit.
   * Kalau A sudah "memesan" nomor seq sebelum transaksinya, nomor itu lebih
   * kecil daripada cursor yang sudah dipegang device ketiga, dan baris A tidak
   * akan pernah muncul lagi di pull mana pun.
   */
  it('tidak ada baris yang hilang kalau satu push commit belakangan', async () => {
    const changesA = makeChanges(10, 'A');
    const changesB = makeChanges(10, 'B');

    const gate = blockNextBatch();

    const aPromise = handleRequest(
      syncRequest({ deviceId: 'A', since: 0, changes: changesA }),
      env,
    );
    await gate.reached; // A sekarang menggantung tepat sebelum menulis.

    // B menyelesaikan seluruh push-nya lebih dulu.
    const b = await sync({ deviceId: 'B', since: 0, changes: changesB });
    expect(b.status).toBe(200);

    // Device ketiga menarik data dan memajukan cursornya.
    const pull1 = await sync({ deviceId: 'C', since: 0, changes: [] });
    const cursor = pull1.body.cursor as number;
    expect(pull1.body.changes).toHaveLength(10); // baris A belum commit

    // Baru sekarang A commit.
    gate.release();
    const a = await readResult(await aPromise, 0);
    expect(a.status).toBe(200);

    // Invariannya: tidak ada baris yang commit dengan seq di bawah cursor yang
    // sudah terlanjur dilihat client.
    const aSeqs = db
      .rows()
      .filter((r) => String(r.uid).startsWith('A'))
      .map((r) => Number(r.server_seq));
    expect(aSeqs).toHaveLength(10);
    expect(Math.min(...aSeqs)).toBeGreaterThan(cursor);

    // Dan konsekuensinya: device ketiga tetap mendapat semua baris A.
    const pull2 = await sync({ deviceId: 'C', since: cursor, changes: [] });
    const seen = new Set<string>([
      ...pull1.body.changes.map((c: any) => c.uid),
      ...pull2.body.changes.map((c: any) => c.uid),
    ]);
    for (const c of changesA) expect(seen.has(c.uid)).toBe(true);
    for (const c of changesB) expect(seen.has(c.uid)).toBe(true);
    expect(seen.size).toBe(20);
  });

  it('semua seq unik walau push saling menyusul', async () => {
    const gate = blockNextBatch();

    const aPromise = handleRequest(
      syncRequest({ deviceId: 'A', since: 0, changes: makeChanges(25, 'A') }),
      env,
    );
    await gate.reached;
    await sync({ deviceId: 'B', since: 0, changes: makeChanges(25, 'B') });
    gate.release();
    await aPromise;

    const seqs = db.rows().map((r) => Number(r.server_seq));
    expect(seqs).toHaveLength(50);
    expect(new Set(seqs).size).toBe(50);
    expect(metaSeq()).toBe(50);
  });
});

describe('last-write-wins pada updatedAt', () => {
  const uid = 'p1';
  const TENGAH = ts(12);
  const LAMA = ts(11);
  const BARU = ts(13);

  async function seed() {
    await sync({
      since: 0,
      changes: [{ table: 'products', uid, updatedAt: TENGAH, data: { v: 'tengah' } }],
    });
  }

  it('tulisan yang lebih baru menang', async () => {
    await seed();
    await sync({
      since: 0,
      changes: [{ table: 'products', uid, updatedAt: BARU, data: { v: 'baru' } }],
    });
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes[0].data).toEqual({ v: 'baru' });
    expect(r.body.changes[0].updatedAt).toBe(BARU);
  });

  it('tulisan yang lebih lama DIBUANG, baris tersimpan dipertahankan', async () => {
    await seed();
    await sync({
      since: 0,
      changes: [{ table: 'products', uid, updatedAt: LAMA, data: { v: 'lama' } }],
    });
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes[0].data).toEqual({ v: 'tengah' });
    expect(r.body.changes[0].updatedAt).toBe(TENGAH);
  });

  it('tulisan yang lebih lama tidak menaikkan server_seq baris itu', async () => {
    await seed();
    const seqBefore = Number(db.rows()[0].server_seq);
    await sync({
      since: 0,
      changes: [{ table: 'products', uid, updatedAt: LAMA, data: { v: 'lama' } }],
    });
    expect(Number(db.rows()[0].server_seq)).toBe(seqBefore);
  });

  it('seri dimenangkan incoming', async () => {
    await seed();
    await sync({
      since: 0,
      changes: [{ table: 'products', uid, updatedAt: TENGAH, data: { v: 'seri' } }],
    });
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes[0].data).toEqual({ v: 'seri' });
  });

  it('delete yang lebih lama tidak menghapus baris yang lebih baru', async () => {
    await seed();
    await sync({
      since: 0,
      changes: [{ table: 'products', uid, updatedAt: LAMA, deleted: true, data: {} }],
    });
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes[0].deleted).toBe(false);
  });

  it('duplikat (table, uid) dalam SATU request diselesaikan pakai aturan yang sama', async () => {
    const r = await sync({
      since: 0,
      changes: [
        { table: 'products', uid, updatedAt: ts(12), data: { v: 'a' } },
        { table: 'products', uid, updatedAt: ts(9), data: { v: 'terlalu-lama' } },
        { table: 'products', uid, updatedAt: ts(14), data: { v: 'paling-baru' } },
      ],
    });
    expect(r.body.changes).toHaveLength(1);
    expect(r.body.changes[0].data).toEqual({ v: 'paling-baru' });
    expect(db.rows()).toHaveLength(1);
  });

  it('(table, uid) yang sama di tabel berbeda adalah baris berbeda', async () => {
    const r = await sync({
      since: 0,
      changes: [
        { table: 'products', uid: 'same', updatedAt: T1, data: { a: 1 } },
        { table: 'customers', uid: 'same', updatedAt: T1, data: { a: 2 } },
      ],
    });
    expect(r.body.changes).toHaveLength(2);
  });

  it('urutan teks sama dengan urutan waktu untuk format kanonik', async () => {
    // Lintas milidetik, menit, jam, dan hari: perbandingan string harus tetap
    // benar, itulah yang membuat aturan LWW di SQL sah.
    const naik = [
      '2026-07-27T09:59:59.999Z',
      ts(10),
      ts(10, 1),
      ts(23, 59),
      '2026-07-28T00:00:00.000Z',
    ];
    for (let i = 1; i < naik.length; i++) expect(naik[i] > naik[i - 1]).toBe(true);

    for (const t of naik) {
      await sync({ since: 0, changes: [{ table: 'p', uid: 'x', updatedAt: t, data: { t } }] });
    }
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes[0].updatedAt).toBe(naik[naik.length - 1]);
  });
});

describe('validasi format updatedAt', () => {
  const TOLAK: Array<[string, string]> = [
    ['tanpa milidetik', '2026-07-27T10:00:00Z'],
    ['milidetik 1 digit', '2026-07-27T10:00:00.0Z'],
    ['milidetik 6 digit', '2026-07-27T10:00:00.000000Z'],
    ['offset zona waktu', '2026-07-27T17:00:00.000+07:00'],
    ['tanpa penanda zona', '2026-07-27T10:00:00.000'],
    ['pemisah spasi', '2026-07-27 10:00:00.000Z'],
    ['huruf kecil z', '2026-07-27T10:00:00.000z'],
    ['hanya tanggal', '2026-07-27'],
    ['epoch milidetik', '1785146400000'],
    ['bukan tanggal', 'kemarin'],
    ['tanggal tidak nyata', '2026-02-31T10:00:00.000Z'],
    ['bulan tidak nyata', '2026-13-01T10:00:00.000Z'],
    ['jam tidak nyata', '2026-07-27T25:00:00.000Z'],
    ['ada spasi di ujung', ' 2026-07-27T10:00:00.000Z'],
  ];

  for (const [nama, nilai] of TOLAK) {
    it(`menolak ${nama}: ${JSON.stringify(nilai)}`, async () => {
      const r = await sync({
        since: 0,
        changes: [{ table: 'products', uid: 'p1', updatedAt: nilai, data: { v: 1 } }],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_updated_at_format');
    });
  }

  it('menerima keluaran Date.toISOString() apa adanya', async () => {
    const kandidat = [
      new Date().toISOString(),
      new Date(0).toISOString(),
      new Date('2026-07-27T17:00:00+07:00').toISOString(),
      new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999)).toISOString(),
    ];
    for (const t of kandidat) {
      const r = await sync({
        since: 0,
        changes: [{ table: 'p', uid: 'u-' + t, updatedAt: t, data: {} }],
      });
      expect(r.status).toBe(200);
    }
    expect(db.rows()).toHaveLength(kandidat.length);
  });

  it('menolak seluruh request, tidak menulis sebagian', async () => {
    const r = await sync({
      since: 0,
      changes: [
        { table: 'p', uid: 'ok-1', updatedAt: T1, data: {} },
        { table: 'p', uid: 'ok-2', updatedAt: T1, data: {} },
        { table: 'p', uid: 'rusak', updatedAt: '2026-07-27T10:00:00Z', data: {} },
      ],
    });
    expect(r.status).toBe(400);
    expect(db.rows()).toHaveLength(0);
    expect(r.queries).toBe(0);
    expect(metaSeq()).toBe(0);
  });

  it('menyebutkan baris mana yang salah', async () => {
    const r = await sync({
      since: 0,
      changes: [{ table: 'products', uid: 'p-99', updatedAt: 'kemarin', data: {} }],
    });
    expect(r.body.table).toBe('products');
    expect(r.body.uid).toBe('p-99');
    expect(r.body.received).toBe('kemarin');
    expect(r.body.expected).toContain('sssZ');
  });

  it('updatedAt kosong atau bukan string tetap 400 dengan kode lain', async () => {
    const kosong = await sync({ since: 0, changes: [{ table: 'p', uid: 'a', updatedAt: '' }] });
    expect(kosong.status).toBe(400);
    expect(kosong.body.error).toBe('invalid_change_updated_at');

    const angka = await sync({
      since: 0,
      changes: [{ table: 'p', uid: 'a', updatedAt: 123 } as any],
    });
    expect(angka.status).toBe(400);
    expect(angka.body.error).toBe('invalid_change_updated_at');
  });
});

describe('cursor & paginasi', () => {
  it('since memfilter apa yang sudah dilihat client', async () => {
    const first = await sync({
      since: 0,
      changes: [{ table: 't', uid: 'a', updatedAt: T1, data: {} }],
    });
    expect(first.body.cursor).toBe(1);

    const second = await sync({
      since: first.body.cursor,
      changes: [{ table: 't', uid: 'b', updatedAt: T1, data: {} }],
    });
    expect(second.body.changes.map((c: any) => c.uid)).toEqual(['b']);
    expect(second.body.cursor).toBe(2);

    const third = await sync({ since: second.body.cursor, changes: [] });
    expect(third.body.changes).toHaveLength(0);
    expect(third.body.hasMore).toBe(false);
  });

  it('cursor tidak berubah kalau tidak ada yang dikembalikan', async () => {
    await sync({ since: 0, changes: [{ table: 't', uid: 'a', updatedAt: T1, data: {} }] });
    const r = await sync({ since: 7, changes: [] });
    expect(r.body.changes).toHaveLength(0);
    expect(r.body.cursor).toBe(7);
  });

  it('baris yang diperbarui muncul lagi dengan server_seq baru', async () => {
    const a = await sync({
      since: 0,
      changes: [{ table: 't', uid: 'a', updatedAt: T1, data: { v: 1 } }],
    });
    const b = await sync({
      since: a.body.cursor,
      changes: [{ table: 't', uid: 'a', updatedAt: T2, data: { v: 2 } }],
    });
    expect(b.body.changes).toHaveLength(1);
    expect(b.body.changes[0].serverSeq).toBe(2);
  });

  it('hasMore true pada MAX_PULL dan client bisa menyelesaikan sisanya', async () => {
    const total = MAX_PULL + 100;
    for (let i = 0; i < total; i += MAX_CHANGES) {
      const batch: Change[] = [];
      for (let j = i; j < Math.min(i + MAX_CHANGES, total); j++) {
        batch.push({ table: 't', uid: 'u' + j, updatedAt: T1, data: { i: j } });
      }
      const r = await sync({ since: 0, changes: batch });
      expect(r.status).toBe(200);
    }

    const page1 = await sync({ since: 0, changes: [] });
    expect(page1.body.changes).toHaveLength(MAX_PULL);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.cursor).toBe(MAX_PULL);

    const page2 = await sync({ since: page1.body.cursor, changes: [] });
    expect(page2.body.changes).toHaveLength(total - MAX_PULL);
    expect(page2.body.hasMore).toBe(false);
    expect(page2.body.cursor).toBe(total);

    const page3 = await sync({ since: page2.body.cursor, changes: [] });
    expect(page3.body.changes).toHaveLength(0);
    expect(page3.body.hasMore).toBe(false);
  });

  it('hasil pull terurut naik menurut server_seq', async () => {
    await sync({ since: 0, changes: makeChanges(40) });
    const r = await sync({ since: 0, changes: [] });
    const seqs = r.body.changes.map((c: any) => c.serverSeq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));
  });
});

describe('payload berlebih (413)', () => {
  it('menolak changes > MAX_CHANGES dengan 413', async () => {
    const r = await sync({ since: 0, changes: makeChanges(MAX_CHANGES + 1) });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('payload_too_large');
    expect(r.body.maxChanges).toBe(MAX_CHANGES);
  });

  it('tidak menulis apa pun saat ditolak', async () => {
    await sync({ since: 0, changes: makeChanges(MAX_CHANGES + 1) });
    expect(db.rows()).toHaveLength(0);
  });

  it('tidak menyentuh D1 saat ditolak', async () => {
    const r = await sync({ since: 0, changes: makeChanges(MAX_CHANGES + 5) });
    expect(r.queries).toBe(0);
  });

  it('menerima tepat MAX_CHANGES', async () => {
    const r = await sync({ since: 0, changes: makeChanges(MAX_CHANGES) });
    expect(r.status).toBe(200);
    expect(db.rows()).toHaveLength(MAX_CHANGES);
  });
});

describe('anggaran query free tier', () => {
  it('payload maksimal tetap jauh di bawah 50 query', async () => {
    const r = await sync({ since: 0, changes: makeChanges(MAX_CHANGES) });
    // ceil(200/16)=13 upsert + 1 bump counter + 1 pull = 15
    const expected = Math.ceil(MAX_CHANGES / CHUNK_RECORDS) + 1 + 1;
    expect(r.queries).toBe(expected);
    expect(r.queries).toBeLessThan(50);
  });

  it('pull murni hanya 1 query', async () => {
    const r = await sync({ since: 0, changes: [] });
    expect(r.queries).toBe(1);
  });

  it('satu perubahan hanya 3 query', async () => {
    const r = await sync({ since: 0, changes: makeChanges(1) });
    expect(r.queries).toBe(3);
  });

  it('pull besar tetap 1 query berapa pun jumlah barisnya', async () => {
    await sync({ since: 0, changes: makeChanges(MAX_CHANGES) });
    const r = await sync({ since: 0, changes: [] });
    expect(r.body.changes).toHaveLength(MAX_CHANGES);
    expect(r.queries).toBe(1);
  });
});

describe('validasi request', () => {
  it('400 untuk JSON rusak', async () => {
    const res = await handleRequest(
      new Request('https://sync.example.com/api/sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SECRET },
        body: '{bukan json',
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('400 untuk since negatif atau bukan integer', async () => {
    expect((await sync({ since: -1, changes: [] })).status).toBe(400);
    expect((await sync({ since: 1.5, changes: [] })).status).toBe(400);
  });

  it('400 untuk change yang tidak lengkap', async () => {
    expect((await sync({ since: 0, changes: [{ uid: 'a', updatedAt: T1 } as any] })).status).toBe(400);
    expect((await sync({ since: 0, changes: [{ table: 't', updatedAt: T1 } as any] })).status).toBe(400);
    expect((await sync({ since: 0, changes: [{ table: 't', uid: 'a' } as any] })).status).toBe(400);
  });

  it('since dan changes boleh tidak dikirim', async () => {
    const r = await sync({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ cursor: 0, changes: [], hasMore: false });
  });

  it('405 untuk method yang salah, 404 untuk path tak dikenal', async () => {
    const get = await handleRequest(
      new Request('https://sync.example.com/api/sync', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + SECRET },
      }),
      env,
    );
    expect(get.status).toBe(405);

    const nf = await handleRequest(new Request('https://sync.example.com/nope'), env);
    expect(nf.status).toBe(404);
  });

  it('preflight OPTIONS dijawab tanpa auth', async () => {
    const res = await handleRequest(
      new Request('https://sync.example.com/api/sync', { method: 'OPTIONS' }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

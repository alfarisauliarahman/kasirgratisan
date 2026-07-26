import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { runSync, collectDirty } from '@/lib/selfsync/engine';
import { setConfig, getCursor, setCursor, resetCursor } from '@/lib/selfsync/config';
import type { WireRecord } from '@/lib/selfsync/wire';

interface Captured {
  since: number;
  changes: WireRecord[];
}

/** Server tiruan: mencatat apa yang dikirim, membalas apa yang kita tentukan. */
function fakeServer(
  replies: { cursor: number; changes: any[]; hasMore?: boolean }[] | (() => never),
) {
  const captured: Captured[] = [];
  let call = 0;

  const fetchMock = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    captured.push({ since: body.since, changes: body.changes });
    if (typeof replies === 'function') replies();
    const reply = (replies as any[])[Math.min(call, replies.length - 1)];
    call++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ hasMore: false, ...reply }),
    } as any;
  });

  vi.stubGlobal('fetch', fetchMock);
  return { captured, fetchMock };
}

function failingServer(status: number, error = '') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ error }),
    })) as any,
  );
}

/**
 * `localStorage` versi memori.
 *
 * jsdom di proyek ini tidak menyediakan implementasi yang lengkap, dan tes ini
 * memang tidak semestinya bergantung pada detail itu — yang diuji adalah mesin
 * sync, bukan penyimpanan browser.
 */
function installMemoryStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
}

async function clearAll() {
  await db.categories.clear();
  await db.products.clear();
  await db.paymentMethods.clear();
  await db.deletedRecords.clear();
}

async function addCategory(name: string) {
  return db.categories.add({
    name,
    isDeleted: 0,
    deletedAt: null,
    createdAt: new Date(),
  } as any);
}

beforeEach(async () => {
  installMemoryStorage();
  await clearAll();
  setConfig({ url: 'https://sync.example.com', secret: 'rahasia', enabled: true });
  resetCursor();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('penjagaan', () => {
  it('tidak melakukan apa-apa kalau sync belum diatur', async () => {
    setConfig({ enabled: false });
    const { fetchMock } = fakeServer([{ cursor: 0, changes: [] }]);

    const res = await runSync();

    expect(res.skipped).toBe('not-configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tetap menarik data walau tidak ada perubahan lokal', async () => {
    const { captured } = fakeServer([{ cursor: 0, changes: [] }]);

    await runSync();

    expect(captured).toHaveLength(1);
    expect(captured[0].changes).toHaveLength(0);
  });
});

describe('mengirim perubahan lokal', () => {
  it('mengirim record yang belum pernah tersinkron', async () => {
    await addCategory('Minuman');
    const { captured } = fakeServer([{ cursor: 1, changes: [] }]);

    const res = await runSync();

    expect(res.pushed).toBe(1);
    expect(captured[0].changes[0].table).toBe('categories');
    expect(captured[0].changes[0].data?.name).toBe('Minuman');
  });

  it('mengirim tanggal dalam format yang diterima server', async () => {
    await addCategory('X');
    const { captured } = fakeServer([{ cursor: 1, changes: [] }]);

    await runSync();

    expect(captured[0].changes[0].updatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('tidak mengirim ulang record yang sudah bersih', async () => {
    await addCategory('Sekali');
    fakeServer([{ cursor: 1, changes: [] }]);
    await runSync();

    const { captured } = fakeServer([{ cursor: 1, changes: [] }]);
    await runSync();

    expect(captured[0].changes).toHaveLength(0);
  });

  it('mengirim ulang kalau record diedit lagi', async () => {
    const id = await addCategory('Awal');
    fakeServer([{ cursor: 1, changes: [] }]);
    await runSync();

    await db.categories.update(id, { name: 'Diedit' } as any);
    const { captured } = fakeServer([{ cursor: 2, changes: [] }]);
    await runSync();

    expect(captured[0].changes).toHaveLength(1);
    expect(captured[0].changes[0].data?.name).toBe('Diedit');
  });

  it('mengirim penghapusan lewat tombstone', async () => {
    const id = await db.paymentMethods.add({
      name: 'QRIS',
      category: 'qris',
      isDefault: false,
      createdAt: new Date(),
    } as any);
    fakeServer([{ cursor: 1, changes: [] }]);
    await runSync();

    await db.paymentMethods.delete(id);
    await new Promise((r) => setTimeout(r, 20)); // hook tombstone pakai setTimeout

    const { captured } = fakeServer([{ cursor: 2, changes: [] }]);
    await runSync();

    const hapus = captured[0].changes.find((c) => c.deleted);
    expect(hapus).toBeDefined();
    expect(hapus?.table).toBe('paymentMethods');
  });
});

describe('menerima perubahan', () => {
  it('menerapkan record dari perangkat lain', async () => {
    fakeServer([
      {
        cursor: 5,
        changes: [
          {
            table: 'categories',
            uid: 'uid-dari-hp-lain',
            updatedAt: '2026-07-27T10:00:00.000Z',
            deleted: false,
            data: { name: 'Dari HP B', isDeleted: 0 },
            serverSeq: 5,
          },
        ],
      },
    ]);

    const res = await runSync();

    expect(res.applied).toBe(1);
    expect((await db.categories.toArray())[0].name).toBe('Dari HP B');
  });

  it('menyimpan cursor supaya tarikan berikutnya tidak mengulang', async () => {
    fakeServer([
      {
        cursor: 7,
        changes: [
          {
            table: 'categories',
            uid: 'u1',
            updatedAt: '2026-07-27T10:00:00.000Z',
            deleted: false,
            data: { name: 'A', isDeleted: 0 },
            serverSeq: 7,
          },
        ],
      },
    ]);

    await runSync();

    expect(getCursor()).toBe(7);
  });

  it('menahan cursor di belakang record yang tertunda', async () => {
    fakeServer([
      {
        cursor: 9,
        changes: [
          // Induknya tidak ikut, jadi harus tertunda.
          {
            table: 'transactionItems',
            uid: 'item-1',
            updatedAt: '2026-07-27T10:00:00.000Z',
            deleted: false,
            data: { transactionId: 'trx-belum-ada', productId: 'prod-belum-ada', quantity: 1 },
            serverSeq: 9,
          },
        ],
      },
    ]);

    const res = await runSync();

    expect(res.deferred).toBe(1);
    // Kalau cursor sampai maju ke 9, record itu hilang selamanya dari HP ini.
    expect(getCursor()).toBeLessThan(9);
  });

  it('berhenti menarik saat cursor mandek, tidak berputar selamanya', async () => {
    const { fetchMock } = fakeServer([
      {
        cursor: 3,
        changes: [
          {
            table: 'transactionItems',
            uid: 'item-x',
            updatedAt: '2026-07-27T10:00:00.000Z',
            deleted: false,
            data: { transactionId: 'hilang', productId: 'hilang', quantity: 1 },
            serverSeq: 3,
          },
        ],
        hasMore: true,
      },
    ]);

    await runSync();

    // Satu kirim + satu tarik lanjutan, lalu berhenti karena cursor tidak maju.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('saat gagal', () => {
  it('tidak menandai record sebagai terkirim kalau server menolak', async () => {
    await addCategory('Gagal kirim');
    failingServer(500);

    const res = await runSync();
    expect(res.ok).toBe(false);

    // Masih kotor, jadi akan dicoba lagi.
    const { pushes } = await collectDirty();
    expect(pushes).toHaveLength(1);
  });

  it('tidak memajukan cursor kalau gagal', async () => {
    setCursor(4);
    failingServer(500);

    await runSync();

    expect(getCursor()).toBe(4);
  });

  it('menjelaskan kunci yang salah dengan bahasa yang bisa ditindaklanjuti', async () => {
    failingServer(401);

    const res = await runSync();

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/[Kk]unci/);
  });

  it('tidak membocorkan kunci ke dalam pesan error', async () => {
    setConfig({ secret: 'kunci-super-rahasia' });
    failingServer(401);

    const res = await runSync();

    expect(res.error).not.toContain('kunci-super-rahasia');
  });

  it('bertahan saat jaringan mati', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }) as any);

    const res = await runSync();

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/koneksi|hubungi/i);
  });
});

describe('memutus perangkat', () => {
  it('menghapus kunci, bukan sekadar mematikan sync', async () => {
    const { disconnectDevice, getConfig } = await import('@/lib/selfsync/config');
    setConfig({ url: 'https://sync.example.com', secret: 'kunci-toko', enabled: true });

    disconnectDevice();

    const c = getConfig();
    expect(c.secret).toBe('');
    expect(c.url).toBe('');
    expect(c.enabled).toBe(false);
  });

  it('sync berhenti jalan setelah diputus', async () => {
    const { disconnectDevice } = await import('@/lib/selfsync/config');
    const { fetchMock } = fakeServer([{ cursor: 0, changes: [] }]);

    disconnectDevice();
    const res = await runSync();

    expect(res.skipped).toBe('not-configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tidak menghapus data kasir', async () => {
    const { disconnectDevice } = await import('@/lib/selfsync/config');
    await addCategory('Tetap ada');

    disconnectDevice();

    expect(await db.categories.count()).toBe(1);
  });
});

describe('keamanan permintaan', () => {
  it('mengirim kunci lewat header, bukan di URL', async () => {
    const { fetchMock } = fakeServer([{ cursor: 0, changes: [] }]);

    await runSync();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('rahasia');
    expect(init.headers.Authorization).toBe('Bearer rahasia');
  });
});

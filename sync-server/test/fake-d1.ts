/**
 * Fake binding D1 di atas `node:sqlite`.
 *
 * Menjalankan test terhadap D1 sungguhan tidak praktis (butuh akun Cloudflare),
 * jadi kita pakai SQLite in-memory bawaan Node dengan permukaan API yang sama
 * seperti `D1Database`: prepare / bind / first / all / run / batch.
 * Semantik SQL-nya asli, jadi aturan `ON CONFLICT ... WHERE` benar-benar diuji.
 *
 * Bonus: setiap statement yang dieksekusi dihitung, sehingga test bisa
 * menegakkan batas 50-query-per-invocation dari Cloudflare free tier.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));

export class FakeD1 {
  readonly db: DatabaseSync;
  /** Jumlah statement SQL yang dieksekusi sejak `resetQueryCount()` terakhir. */
  queryCount = 0;

  /**
   * Kait sekali-pakai yang di-await tepat SEBELUM sebuah batch memulai
   * transaksinya, lalu langsung dilepas. Dipakai test konkurensi untuk
   * menahan satu push di ambang commit sementara push lain jalan sampai
   * selesai. Sengaja dipasang sebelum `BEGIN` supaya transaksi kedua tidak
   * bertabrakan dengan yang pertama pada satu koneksi SQLite.
   */
  beforeBatch: (() => Promise<void>) | null = null;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  }

  resetQueryCount(): void {
    this.queryCount = 0;
  }

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements: FakeD1Statement[]): Promise<Array<{ results: any[]; success: true }>> {
    const hook = this.beforeBatch;
    if (hook) {
      this.beforeBatch = null;
      await hook();
    }
    this.db.exec('BEGIN');
    try {
      const out: Array<{ results: any[]; success: true }> = [];
      for (const stmt of statements) out.push(await stmt.all());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Helper test, tidak ada di API D1 sungguhan. */
  rows(): any[] {
    return this.db.prepare('SELECT * FROM records ORDER BY server_seq').all() as any[];
  }
}

class FakeD1Statement {
  #owner: FakeD1;
  #sql: string;
  #params: unknown[] = [];

  constructor(owner: FakeD1, sql: string) {
    this.#owner = owner;
    this.#sql = sql;
  }

  bind(...params: unknown[]): FakeD1Statement {
    // D1 membatasi 100 bound parameter per query. Ditegakkan di sini supaya
    // regresi pada ukuran chunk langsung gagal di test, bukan di produksi.
    if (params.length > 100) {
      throw new Error(`too many bound parameters: ${params.length} (D1 limit is 100)`);
    }
    this.#params = params;
    return this;
  }

  #exec(): any[] {
    this.#owner.queryCount++;
    const stmt = this.#owner.db.prepare(this.#sql);
    return stmt.all(...(this.#params as any[])) as any[];
  }

  async all(): Promise<{ results: any[]; success: true }> {
    return { results: this.#exec(), success: true };
  }

  async first<T = any>(): Promise<T | null> {
    const rows = this.#exec();
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  async run(): Promise<{ success: true }> {
    this.#exec();
    return { success: true };
  }
}

export type { FakeD1Statement };

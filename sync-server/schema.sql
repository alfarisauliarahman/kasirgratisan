-- FreeKasir sync server — D1 schema
-- Terapkan dengan:  npx wrangler d1 execute freekasir-sync --remote --file=./schema.sql

-- Satu tabel untuk SEMUA record yang disinkronkan.
-- Server tidak tahu (dan tidak peduli) isi kolom `data`; itu blob JSON opaque.
CREATE TABLE IF NOT EXISTS records (
  table_name TEXT    NOT NULL,
  uid        TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,          -- ISO-8601 UTC, dikirim client
  deleted    INTEGER NOT NULL DEFAULT 0,
  data       TEXT    NOT NULL,          -- blob JSON opaque
  server_seq INTEGER NOT NULL,          -- selalu diberikan SERVER, bukan client
  PRIMARY KEY (table_name, uid)
);

CREATE INDEX IF NOT EXISTS idx_records_seq ON records(server_seq);

-- Counter monotonik untuk server_seq. Sengaja TIDAK memakai timestamp:
-- jam device toko sering salah, jadi cursor sync harus milik server.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', 0);

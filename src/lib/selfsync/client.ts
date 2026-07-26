/**
 * Klien HTTP ke sync server sendiri.
 *
 * Tipis saja: satu endpoint, satu bentuk request. Semua keputusan soal data
 * ada di `engine.ts` dan `merge.ts`.
 */

import { getConfig, getDeviceId } from './config';
import type { WireRecord } from './wire';

/**
 * Server menolak lebih dari 200 perubahan per request. Dipatok di bawahnya
 * supaya masih ada ruang kalau batasnya suatu saat diperketat.
 */
export const PUSH_BATCH_SIZE = 150;

export interface PulledRecord extends WireRecord {
  serverSeq?: number;
}

export interface SyncResponse {
  cursor: number;
  changes: PulledRecord[];
  hasMore: boolean;
}

export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Pesan yang layak dibaca pemilik toko, bukan pemilik server.
 *
 * Kesalahan yang paling mungkin terjadi di lapangan adalah kunci yang beda
 * antar HP dan alamat yang salah ketik, jadi keduanya disebut eksplisit.
 */
function describe(status: number, code: string): string {
  if (status === 401) {
    return 'Kunci sync ditolak server. Pastikan kunci di HP ini sama persis dengan yang dipasang di server.';
  }
  if (status === 413) {
    return 'Data yang dikirim terlalu banyak sekaligus. Sync akan mencoba lagi dengan potongan lebih kecil.';
  }
  if (status === 400 && code === 'invalid_updated_at_format') {
    return 'Ada record dengan format tanggal yang tidak dikenali server. Laporkan ini — bukan kesalahan pemakaian.';
  }
  if (status >= 500) {
    return 'Server sync sedang bermasalah. Data lokal aman, sync akan dicoba lagi nanti.';
  }
  return `Server menolak permintaan sync (${status}${code ? ': ' + code : ''}).`;
}

/**
 * Kirim perubahan dan ambil yang belum terlihat, dalam satu perjalanan.
 *
 * `signal` dipakai supaya sync tidak menggantung selamanya di jaringan toko
 * yang putus-putus.
 */
export async function postSync(
  since: number,
  changes: WireRecord[],
  signal?: AbortSignal,
): Promise<SyncResponse> {
  const { url, secret } = getConfig();
  if (!url) throw new SyncHttpError(0, 'no_url', 'Alamat server sync belum diisi.');
  if (!secret) throw new SyncHttpError(0, 'no_secret', 'Kunci sync belum diisi.');

  let res: Response;
  try {
    res = await fetch(url + '/api/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + secret,
      },
      body: JSON.stringify({ deviceId: getDeviceId(), since, changes }),
      signal,
    });
  } catch (err) {
    throw new SyncHttpError(
      0,
      'network',
      'Tidak bisa menghubungi server sync. Periksa koneksi internet.',
    );
  }

  if (!res.ok) {
    let code = '';
    try {
      const body = await res.json();
      code = typeof body?.error === 'string' ? body.error : '';
    } catch {
      /* badan respons bukan JSON; cukup pakai status saja */
    }
    throw new SyncHttpError(res.status, code, describe(res.status, code));
  }

  const body = await res.json();
  return {
    cursor: typeof body?.cursor === 'number' ? body.cursor : since,
    changes: Array.isArray(body?.changes) ? body.changes : [],
    hasMore: body?.hasMore === true,
  };
}

/** Cek cepat apakah alamatnya benar; tidak butuh kunci. */
export async function checkHealth(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + '/api/health', { signal });
  if (!res.ok) return false;
  const body = await res.json();
  return body?.ok === true;
}

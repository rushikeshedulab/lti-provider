import pg from 'pg';
import { env } from '../config/env.js';

export const pool = new pg.Pool({ connectionString: env.databaseUrl });

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err);
});

/** Thin typed wrapper so route code reads as plain SQL. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

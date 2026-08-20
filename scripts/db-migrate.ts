import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../src/db/pool.js';

const sql = readFileSync(resolve(process.cwd(), 'db/schema.sql'), 'utf8');

try {
  await pool.query(sql);
  console.log('Provider schema applied.');
} catch (err) {
  console.error('Migration failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

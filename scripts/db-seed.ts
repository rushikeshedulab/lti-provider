import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../src/db/pool.js';
import { defaultPlatformRegistration } from '../src/config/registration.js';
import { upsertPlatform } from '../src/lti/platformStore.js';

const sql = readFileSync(resolve(process.cwd(), 'db/seed.sql'), 'utf8');

try {
  await pool.query(sql);
  console.log('Static content seeded (1 course, 3 modules, 6 lectures).');

  const platform = await upsertPlatform(defaultPlatformRegistration);
  console.log('Platform registration stored:');
  console.log(`  name           ${platform.name}`);
  console.log(`  issuer         ${platform.issuer}`);
  console.log(`  client_id      ${platform.client_id}`);
  console.log(`  deployment_ids ${platform.deployment_ids.join(', ')}`);
  console.log(`  auth login     ${platform.auth_login_url}`);
  console.log(`  token endpoint ${platform.auth_token_url}`);
  console.log(`  platform JWKS  ${platform.jwks_url}`);
} catch (err) {
  console.error('Seed failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

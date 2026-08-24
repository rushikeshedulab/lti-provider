import { pool } from '../src/db/pool.js';
import { defaultPlatformRegistration } from '../src/config/registration.js';
import { upsertPlatform } from '../src/lti/platformStore.js';

/**
 * Stores the trust relationship with the consumer LMS. That is ALL this script
 * does - the provider ships with no content. Courses, modules and content items
 * are created by the administrator at /admin, and every consumer picks them up
 * automatically from /api/catalog.
 */
try {
  const platform = await upsertPlatform(defaultPlatformRegistration);
  console.log('Platform registration stored:');
  console.log(`  name           ${platform.name}`);
  console.log(`  issuer         ${platform.issuer}`);
  console.log(`  client_id      ${platform.client_id}`);
  console.log(`  deployment_ids ${platform.deployment_ids.join(', ')}`);
  console.log(`  auth login     ${platform.auth_login_url}`);
  console.log(`  token endpoint ${platform.auth_token_url}`);
  console.log(`  platform JWKS  ${platform.jwks_url}`);
  console.log('');
  console.log('No content is installed. Sign in at /admin to upload it.');
} catch (err) {
  console.error('Registration failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

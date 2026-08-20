import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../src/config/env.js';

/**
 * Generates the tool's RSA-2048 signing keypair.
 *
 * The private key is written to disk with 0600 permissions where the platform
 * supports it and is gitignored. It is loaded only by the backend process -
 * nothing under frontend/ ever imports it.
 */
const privatePath = resolve(process.cwd(), env.privateKeyPath);
const publicPath = resolve(process.cwd(), env.publicKeyPath);

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.log(`Keys already exist at ${privatePath} - pass --force to overwrite.`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(dirname(privatePath), { recursive: true });
mkdirSync(dirname(publicPath), { recursive: true });
writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(publicPath, publicKey, { mode: 0o644 });

console.log(`RSA-2048 keypair generated (kid=${env.keyId})`);
console.log(`  private: ${privatePath}   <- backend only, never served`);
console.log(`  public:  ${publicPath}   <- published at ${env.baseUrl}/.well-known/jwks.json`);

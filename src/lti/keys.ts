import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importPKCS8, importSPKI, exportJWK, type JWK, type KeyObject, type CryptoKey } from 'jose';
import { env } from '../config/env.js';

/**
 * The tool's own RSA keypair.
 *
 * SECURITY: the private key is read from disk by the backend process only.
 * It is never sent to the browser, never referenced from the React app, and
 * `keys/` is gitignored. Only the PUBLIC half is exposed, via /.well-known/jwks.json.
 */
const ALG = 'RS256';

let privateKeyPromise: Promise<CryptoKey | KeyObject> | null = null;
let publicJwkPromise: Promise<JWK> | null = null;

function readPem(path: string): string {
  try {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
  } catch {
    throw new Error(
      `Could not read key file "${path}". Run \`npm run keys:generate\` in lti-content-provider first.`,
    );
  }
}

export function getPrivateKey(): Promise<CryptoKey | KeyObject> {
  privateKeyPromise ??= importPKCS8(readPem(env.privateKeyPath), ALG);
  return privateKeyPromise;
}

export function getPublicJwk(): Promise<JWK> {
  publicJwkPromise ??= (async () => {
    const key = await importSPKI(readPem(env.publicKeyPath), ALG);
    const jwk = await exportJWK(key);
    return { ...jwk, kid: env.keyId, alg: ALG, use: 'sig' };
  })();
  return publicJwkPromise;
}

export async function getPublicJwks(): Promise<{ keys: JWK[] }> {
  return { keys: [await getPublicJwk()] };
}

export const SIGNING_ALG = ALG;

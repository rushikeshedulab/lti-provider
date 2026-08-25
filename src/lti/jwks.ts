import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

/**
 * REMOTE KEY SETS, ONE CACHE
 * --------------------------
 * There were two of these - one in validateLaunch.ts, one in catalog.routes.ts -
 * with different cache settings, so the same platform's keys were fetched and
 * aged on two independent schedules depending on which code path asked.
 *
 * Both keyed on the URL string, which was also a slow leak now that a platform's
 * JWKS URL can be re-read from its discovery document and change: the old entry
 * stayed in the Map forever. Keying on the platform id instead means exactly one
 * live key set per platform, replaced outright when the URL moves.
 *
 * A launch already in flight against the previous key set is harmless - jose
 * refetches whenever it meets a `kid` it does not hold.
 */
const cache = new Map<number, { url: string; set: JWTVerifyGetKey }>();

export function jwksFor(platformId: number, url: string): JWTVerifyGetKey {
  const hit = cache.get(platformId);
  if (hit && hit.url === url) return hit.set;

  const set = createRemoteJWKSet(new URL(url), {
    // Long enough that a launch burst costs one fetch, short enough that a
    // platform rotating its signing key recovers without a restart.
    cacheMaxAge: 5 * 60_000,
    cooldownDuration: 5_000,
  });
  cache.set(platformId, { url, set });
  return set;
}

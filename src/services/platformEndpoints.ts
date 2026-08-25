import { fetchJsonDocument } from './httpProbe.js';
import {
  listPlatforms,
  recordDiscoveryFailure,
  touchDiscoveryFetchedAt,
  updateResolvedEndpoints,
  type PlatformRegistration,
} from '../lti/platformStore.js';
import { env } from '../config/env.js';

/**
 * ENDPOINT RESOLUTION
 * -------------------
 * A connection's authorization, token and JWKS URLs used to be three columns
 * written once and never revisited. If the LMS moved an endpoint, every launch
 * broke until an administrator noticed and re-typed them.
 *
 * They are now derived. A connection remembers the discovery document it was
 * built from, that document is re-read on a timer, and the columns are rewritten
 * when it changes. The columns keep their value as the last-known-good snapshot,
 * so a platform that is briefly unreachable costs nothing.
 *
 * THE HOT PATH NEVER WAITS ON THE NETWORK. handleLoginInitiation calls this on
 * every launch, and putting an 8-second fetch in front of a student's click is
 * exactly the failure this exists to prevent. Reads are served from memory; when
 * the entry is past its TTL it is still returned, marked stale, and a refresh is
 * scheduled behind it. Refresh-ahead, never refresh-and-block.
 */

export interface ResolvedEndpoints {
  authLoginUrl: string;
  authTokenUrl: string | null;
  jwksUrl: string;
  /** 'manual' - typed by hand; 'db' - stored snapshot; 'discovery' - re-read this process. */
  source: 'manual' | 'db' | 'discovery';
  fetchedAt: string | null;
  /** Past the TTL. A refresh is in flight; the values returned are the last good ones. */
  stale: boolean;
  /** The platform now publishes a different issuer. Never applied automatically. */
  issuerWarning: { stored: string; published: string } | null;
  /** Why the last refresh failed, if it did. */
  error: string | null;
}

interface Entry {
  endpoints: { authLoginUrl: string; authTokenUrl: string | null; jwksUrl: string };
  fetchedAt: number;
  source: ResolvedEndpoints['source'];
  issuerWarning: ResolvedEndpoints['issuerWarning'];
  error: string | null;
}

/**
 * Keyed on the surrogate id, not `issuer|client_id`: the issuer is part of the
 * row's identity and an administrator may correct it, which would orphan an
 * entry keyed on it.
 *
 * Bounded by the number of registered platforms - tens, not thousands - so there
 * is deliberately no eviction policy.
 */
const cache = new Map<number, Entry>();

/** One refresh per platform at a time, however many launches arrive at once. */
const inflight = new Map<number, Promise<void>>();

const TTL_MS = env.platformDiscoveryTtlSeconds * 1000;

/**
 * After a failed refresh, pretend the entry is this much fresher than it is, so
 * a discovery URL that black-holes costs one request a minute rather than one
 * per launch.
 */
const RETRY_BACKOFF_MS = 60_000;

function snapshotOf(platform: PlatformRegistration): Entry['endpoints'] {
  return {
    authLoginUrl: platform.auth_login_url,
    authTokenUrl: platform.auth_token_url || null,
    jwksUrl: platform.jwks_url,
  };
}

function seed(platform: PlatformRegistration): Entry {
  const entry: Entry = {
    endpoints: snapshotOf(platform),
    // Treat a row that has never been refreshed as infinitely old, so the first
    // launch after a restart schedules a refresh behind itself.
    fetchedAt: platform.discovery_fetched_at ? Date.parse(platform.discovery_fetched_at) : 0,
    source: platform.discovery_source ? 'db' : 'manual',
    issuerWarning: null,
    error: platform.discovery_error,
  };
  cache.set(platform.id, entry);
  return entry;
}

function present(entry: Entry, stale: boolean): ResolvedEndpoints {
  return {
    ...entry.endpoints,
    source: entry.source,
    fetchedAt: entry.fetchedAt ? new Date(entry.fetchedAt).toISOString() : null,
    stale,
    issuerWarning: entry.issuerWarning,
    error: entry.error,
  };
}

/**
 * The endpoints a launch or a service call should use right now.
 *
 * Returns from memory in every case. `force` is for the admin "Test" button,
 * which is allowed to wait because a human asked it to.
 */
export async function resolvePlatformEndpoints(
  platform: PlatformRegistration,
  options: { force?: boolean } = {},
): Promise<ResolvedEndpoints> {
  // Hand-typed connections are authoritative as they stand; there is nothing to
  // re-read and no reason to touch the network.
  if (!platform.discovery_url) {
    return {
      ...snapshotOf(platform),
      source: 'manual',
      fetchedAt: null,
      stale: false,
      issuerWarning: null,
      error: null,
    };
  }

  const entry = cache.get(platform.id) ?? seed(platform);

  if (!options.force && Date.now() - entry.fetchedAt < TTL_MS) {
    return present(entry, false);
  }

  if (options.force) {
    await refresh(platform);
    return present(cache.get(platform.id) ?? entry, false);
  }

  // Fire and forget. The value below is the previous one, which is correct
  // unless the platform has just moved - and being one refresh interval late is
  // strictly better than making every launch wait for a network round trip.
  void refresh(platform);
  return present(entry, true);
}

function refresh(platform: PlatformRegistration): Promise<void> {
  const running = inflight.get(platform.id);
  if (running) return running;

  const promise = doRefresh(platform).finally(() => inflight.delete(platform.id));
  inflight.set(platform.id, promise);
  return promise;
}

async function doRefresh(platform: PlatformRegistration): Promise<void> {
  const entry = cache.get(platform.id) ?? seed(platform);
  const discoveryUrl = platform.discovery_url!;

  const result = await fetchJsonDocument(discoveryUrl);

  const keep = async (detail: string) => {
    entry.error = detail;
    // Not "stale immediately": back off so a dead URL is not retried per launch.
    entry.fetchedAt = Date.now() - TTL_MS + RETRY_BACKOFF_MS;
    console.warn(`[discovery] platform ${platform.id} refresh failed: ${detail}`);
    await recordDiscoveryFailure(platform.id, detail).catch((err) =>
      console.warn(`[discovery] could not record the failure: ${(err as Error).message}`),
    );
  };

  if (!result.ok) {
    await keep(result.detail);
    return;
  }

  const doc = result.doc!;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const resolve = (value: string | null): string | null => {
    if (!value) return null;
    try {
      return new URL(value, discoveryUrl).toString();
    } catch {
      return null;
    }
  };

  const authLoginUrl = resolve(text(doc.authorization_endpoint));
  const jwksUrl = resolve(text(doc.jwks_uri) ?? text(doc.jwks_url));
  const authTokenUrl = resolve(text(doc.token_endpoint));

  if (!authLoginUrl || !jwksUrl) {
    await keep(
      `${discoveryUrl} no longer names ${!authLoginUrl ? 'an authorization_endpoint' : 'a jwks_uri'}. ` +
        `The previously known endpoints are still in use.`,
    );
    return;
  }

  // The issuer is half of this row's unique key and the only thing findPlatform
  // matches a launch on, and lti_launches records it as history. A document that
  // starts claiming a different one is at least as likely to be a half-finished
  // deployment as a real move, so it is reported and never applied - correcting
  // it stays a deliberate act through PATCH /connections/:id/endpoints.
  const published = text(doc.issuer);
  const issuerWarning =
    published && published !== platform.issuer ? { stored: platform.issuer, published } : null;

  const changed =
    authLoginUrl !== entry.endpoints.authLoginUrl ||
    jwksUrl !== entry.endpoints.jwksUrl ||
    (authTokenUrl ?? null) !== entry.endpoints.authTokenUrl;

  entry.endpoints = { authLoginUrl, authTokenUrl, jwksUrl };
  entry.fetchedAt = Date.now();
  entry.source = 'discovery';
  entry.issuerWarning = issuerWarning;
  entry.error = issuerWarning
    ? `issuer_mismatch: this platform now publishes "${issuerWarning.published}"`
    : null;

  try {
    if (changed) {
      await updateResolvedEndpoints(platform.id, {
        authLoginUrl,
        authTokenUrl,
        jwksUrl,
        discoverySource: platform.discovery_source ?? 'discovery',
      });
      console.log(
        `[discovery] platform ${platform.id} endpoints updated from ${discoveryUrl}: auth=${authLoginUrl} jwks=${jwksUrl}`,
      );
    } else {
      // A no-op refresh must not rewrite the row every interval, but freshness
      // still has to be recorded or the admin UI reports it as permanently stale.
      await touchDiscoveryFetchedAt(platform.id, platform.discovery_source ?? 'discovery');
    }
    if (issuerWarning) {
      console.warn(
        `[discovery] platform ${platform.id} publishes issuer "${issuerWarning.published}" but the ` +
          `registration stores "${issuerWarning.stored}" - not changing it`,
      );
      await recordDiscoveryFailure(platform.id, entry.error!);
    }
  } catch (err) {
    console.warn(`[discovery] platform ${platform.id} could not be written back: ${(err as Error).message}`);
  }
}

/** Drops the cached entry so an administrator's correction takes effect at once. */
export function invalidatePlatformEndpoints(platformId: number): void {
  cache.delete(platformId);
}

/**
 * Re-reads every connection that has a discovery document.
 *
 * Runs on the same interval as the frame-ancestors refresh in index.ts, and for
 * the same reason: the alternative is a connection whose configuration is only
 * as current as the last time somebody opened the admin page.
 */
export async function refreshAllPlatformEndpoints(): Promise<void> {
  try {
    const platforms = await listPlatforms();
    const due = platforms.filter((p) => p.is_active && p.discovery_url);
    for (const platform of due) {
      const entry = cache.get(platform.id);
      if (entry && Date.now() - entry.fetchedAt < TTL_MS) continue;
      await refresh(platform);
    }
  } catch (err) {
    // A database blip must not take the interval down with it.
    console.warn('[discovery] could not sweep platform endpoints:', (err as Error).message);
  }
}

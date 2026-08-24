/**
 * PLATFORM DISCOVERY
 * ------------------
 * Connecting a new LMS should cost an administrator two pasted ids, not a
 * six-field form and a redeploy. Everything else about a platform - its
 * issuer, its authorization and token endpoints, and the JWKS this tool must
 * verify launches against - is published by the platform itself, so we fetch it
 * rather than ask for it.
 *
 * Three documents are tried, in decreasing order of standardisation:
 *
 *   1. /.well-known/openid-configuration        OpenID Connect Discovery
 *   2. /.well-known/lti-platform-configuration  LTI Dynamic Registration
 *   3. /lti/config                              this project's own description
 *
 * If none of them answers, the conventional paths are returned as a best guess
 * and the administrator can correct any field by hand before saving. Discovery
 * is a convenience; nothing here is trusted as proof of anything, because every
 * launch is still verified against the JWKS at validation time.
 */

export interface DiscoveredPlatform {
  name: string | null;
  issuer: string;
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
  /** Which document answered, or 'defaults' when nothing did. */
  source: string;
  /** Populated when the platform also volunteered a client_id / deployment_id. */
  suggestedClientId: string | null;
  suggestedDeploymentId: string | null;
  warning: string | null;
}

const FETCH_TIMEOUT_MS = 8_000;

export class DiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

function cleanUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DiscoveryError('bad_scheme', 'The platform URL must be http or https.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Accepts `example.com`, `https://example.com`, or a URL with a path. */
export function normaliseBaseUrl(raw: string): string {
  return candidateBaseUrls(raw)[0]!;
}

/**
 * The addresses worth trying for one typed value. When the administrator wrote
 * a scheme we use exactly that; when they did not, https is tried first and
 * plain http second, so an LMS on `localhost:4001` is found without anyone
 * having to think about schemes.
 */
export function candidateBaseUrls(raw: string): string[] {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new DiscoveryError('missing_url', 'A platform URL is required.');

  try {
    if (/^https?:\/\//i.test(trimmed)) return [cleanUrl(trimmed)];
    return [cleanUrl(`https://${trimmed}`), cleanUrl(`http://${trimmed}`)];
  } catch (err) {
    if (err instanceof DiscoveryError) throw err;
    throw new DiscoveryError('bad_url', `"${raw}" is not a valid URL.`);
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Resolves a possibly-relative endpoint against the platform's base URL. */
function absolute(value: string | null, baseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

function conventionalDefaults(baseUrl: string): Omit<DiscoveredPlatform, 'source' | 'warning'> {
  return {
    name: null,
    issuer: baseUrl,
    authLoginUrl: `${baseUrl}/lti/authorize`,
    authTokenUrl: `${baseUrl}/lti/token`,
    jwksUrl: `${baseUrl}/.well-known/jwks.json`,
    suggestedClientId: null,
    suggestedDeploymentId: null,
  };
}

export async function discoverPlatform(rawUrl: string): Promise<DiscoveredPlatform> {
  const candidates = candidateBaseUrls(rawUrl);

  for (const candidate of candidates) {
    const found = await discoverAt(candidate);
    if (found) return found;
  }

  // Nothing published a discovery document. Guess the conventional paths, and
  // prefer whichever candidate actually serves a key set, so a scheme-less
  // address still lands on the scheme the LMS really uses.
  for (const candidate of candidates) {
    const defaults = conventionalDefaults(candidate);
    if ((await probeJwks(defaults.jwksUrl)).ok) {
      return {
        ...defaults,
        source: 'defaults',
        warning:
          `No discovery document was published at ${candidate}, but it does serve a key set at the conventional ` +
          `path. Check the endpoints below against the LMS before saving.`,
      };
    }
  }

  const baseUrl = candidates[0]!;
  return {
    ...conventionalDefaults(baseUrl),
    source: 'defaults',
    warning:
      `No discovery document was published at ${baseUrl}. The conventional endpoint paths are filled in below - ` +
      `check them against the LMS before saving.`,
  };
}

/** Tries the three known documents at one address. Null when none answers. */
async function discoverAt(baseUrl: string): Promise<DiscoveredPlatform | null> {
  const defaults = conventionalDefaults(baseUrl);

  // 1 + 2: the two standard discovery documents share a field vocabulary.
  for (const [path, source] of [
    ['/.well-known/openid-configuration', 'openid-configuration'],
    ['/.well-known/lti-platform-configuration', 'lti-platform-configuration'],
  ] as const) {
    const doc = await fetchJson(`${baseUrl}${path}`);
    if (!doc) continue;

    const lti = (doc['https://purl.imsglobal.org/spec/lti-platform-configuration'] ?? {}) as Record<string, unknown>;
    const issuer = str(doc.issuer) ?? str(doc.iss);
    const authLoginUrl = absolute(str(doc.authorization_endpoint), baseUrl);
    const authTokenUrl = absolute(str(doc.token_endpoint), baseUrl);
    const jwksUrl = absolute(str(doc.jwks_uri) ?? str(doc.jwks_url), baseUrl);

    // A document that names none of the endpoints tells us nothing useful.
    if (!issuer && !authLoginUrl && !jwksUrl) continue;

    return {
      name: str(lti.product_family_code) ?? str(doc.platform_name) ?? null,
      issuer: issuer ?? defaults.issuer,
      authLoginUrl: authLoginUrl ?? defaults.authLoginUrl,
      authTokenUrl: authTokenUrl ?? defaults.authTokenUrl,
      jwksUrl: jwksUrl ?? defaults.jwksUrl,
      source,
      suggestedClientId: null,
      suggestedDeploymentId: null,
      warning: null,
    };
  }

  // 3: this project's own platform description, which also volunteers the ids.
  const own = await fetchJson(`${baseUrl}/lti/config`);
  if (own) {
    const issuer = str(own.issuer);
    const authLoginUrl = absolute(str(own.authorization_endpoint), baseUrl);
    const jwksUrl = absolute(str(own.jwks_uri) ?? str(own.jwks_url), baseUrl);

    if (issuer || authLoginUrl || jwksUrl) {
      return {
        name: str(own.platform_name),
        issuer: issuer ?? defaults.issuer,
        authLoginUrl: authLoginUrl ?? defaults.authLoginUrl,
        authTokenUrl: absolute(str(own.token_endpoint), baseUrl) ?? defaults.authTokenUrl,
        jwksUrl: jwksUrl ?? defaults.jwksUrl,
        source: 'lti/config',
        suggestedClientId: str(own.client_id),
        suggestedDeploymentId: str(own.deployment_id),
        warning: null,
      };
    }
  }

  return null;
}

/**
 * Confirms the platform really does publish a usable key set. A registration
 * whose JWKS cannot be read would accept the pasted ids and then fail every
 * launch with a signature error, which is a far worse place to find out.
 */
export async function probeJwks(jwksUrl: string): Promise<{ ok: boolean; keys: number; error?: string }> {
  const doc = await fetchJson(jwksUrl);
  if (!doc) return { ok: false, keys: 0, error: `Could not read a JSON key set from ${jwksUrl}.` };
  const keys = Array.isArray(doc.keys) ? doc.keys.length : 0;
  if (keys === 0) return { ok: false, keys: 0, error: `${jwksUrl} returned no keys.` };
  return { ok: true, keys };
}

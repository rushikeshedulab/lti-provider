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

/**
 * Endpoint layouts seen in the wild. Plenty of platforms publish no discovery
 * document at all, so when none is found we probe these against the address
 * instead of emitting one fixed guess - a guess is wrong for every LMS that
 * does not happen to share this project's own paths.
 *
 * Ordered by how strongly a match identifies the platform. The three paths in a
 * family belong together: a token endpoint almost never answers a GET, so it is
 * taken from whichever family its siblings matched rather than probed.
 */
const ENDPOINT_FAMILIES = [
  { name: 'lti/auth', auth: '/lti/auth', token: '/lti/token', jwks: '/lti/jwks' },
  { name: 'lti/authorize', auth: '/lti/authorize', token: '/lti/token', jwks: '/.well-known/jwks.json' },
  { name: 'moodle', auth: '/mod/lti/auth.php', token: '/mod/lti/token.php', jwks: '/mod/lti/certs.php' },
  {
    name: 'canvas',
    auth: '/api/lti/authorize_redirect',
    token: '/login/oauth2/token',
    jwks: '/api/lti/security/jwks',
  },
] as const;

function familyToDiscovered(
  baseUrl: string,
  family: (typeof ENDPOINT_FAMILIES)[number],
): Omit<DiscoveredPlatform, 'source' | 'warning'> {
  return {
    name: null,
    issuer: baseUrl,
    authLoginUrl: `${baseUrl}${family.auth}`,
    authTokenUrl: `${baseUrl}${family.token}`,
    jwksUrl: `${baseUrl}${family.jwks}`,
    suggestedClientId: null,
    suggestedDeploymentId: null,
  };
}

function conventionalDefaults(baseUrl: string): Omit<DiscoveredPlatform, 'source' | 'warning'> {
  return familyToDiscovered(baseUrl, ENDPOINT_FAMILIES[1]);
}

/**
 * Does something answer here? A 404 or 405 means the path is wrong; anything
 * else - including the 400 an authorization endpoint returns when handed no
 * OIDC parameters, and the redirect it returns when there is no session - means
 * the endpoint is really there.
 */
async function endpointExists(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    return response.status !== 404 && response.status !== 405 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverPlatform(rawUrl: string): Promise<DiscoveredPlatform> {
  const candidates = candidateBaseUrls(rawUrl);

  for (const candidate of candidates) {
    const found = await discoverAt(candidate);
    if (found) return found;
  }

  // No discovery document anywhere. Find the endpoints by probing instead.
  for (const candidate of candidates) {
    const scored = await Promise.all(
      ENDPOINT_FAMILIES.map(async (family) => {
        const [jwks, authOk] = await Promise.all([
          probeJwks(`${candidate}${family.jwks}`),
          endpointExists(`${candidate}${family.auth}`),
        ]);
        // A readable key set is the strongest signal - it is unambiguous JSON
        // in a known shape, where an authorization endpoint only proves that
        // *something* is served at the path.
        return { family, score: (jwks.ok ? 2 : 0) + (authOk ? 1 : 0), keys: jwks.keys };
      }),
    );

    const best = scored.sort((a, b) => b.score - a.score)[0]!;
    if (best.score >= 2) {
      return {
        ...familyToDiscovered(candidate, best.family),
        source: `probed (${best.family.name})`,
        warning:
          best.score === 3
            ? null
            : `No discovery document was published at ${candidate}. These paths were found by probing - ` +
              `check them against the LMS before saving.`,
      };
    }
  }

  const baseUrl = candidates[0]!;
  return {
    ...conventionalDefaults(baseUrl),
    source: 'defaults',
    warning:
      `Nothing was discoverable at ${baseUrl} - no config document, and no endpoints found by probing. ` +
      `The paths below are a guess; fill in the real ones from the LMS before saving.`,
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

export interface EndpointReport {
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

export interface Diagnosis {
  jwks: { ok: boolean; keys: number; error?: string };
  authorization: EndpointReport;
  token: EndpointReport;
  /** Set when the platform's own config disagrees with what was saved. */
  issuerMismatch: { saved: string; published: string } | null;
  notes: string[];
}

/** Reaches an endpoint just far enough to tell "wrong URL" from "works". */
async function probeEndpoint(url: string): Promise<EndpointReport> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // `redirect: manual` matters: an authorization endpoint answering a
    // session-less request with a redirect to its own login page is normal, and
    // following it would hide the fact that the endpoint exists at all.
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    const status = response.status;

    if (status === 404 || status === 405) {
      return { url, ok: false, status, detail: `Nothing is served here (HTTP ${status}). The path is wrong.` };
    }
    if (status >= 500) {
      return { url, ok: false, status, detail: `The platform returned HTTP ${status}.` };
    }
    if (status >= 300 && status < 400) {
      return {
        url,
        ok: true,
        status,
        detail:
          `Answers, and redirects a request with no session - normal for an authorization endpoint. ` +
          `If a user sees a login page during a launch, that redirect is the platform asking them to sign in.`,
      };
    }
    return { url, ok: true, status, detail: `Answers with HTTP ${status}.` };
  } catch (err) {
    return { url, ok: false, status: null, detail: `Unreachable: ${(err as Error).message}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Checks a saved connection against the platform as it is right now. The point
 * is to separate "this tool is pointed at the wrong URL", which is fixable
 * here, from "the platform wants the user to sign in", which is not.
 */
export async function diagnoseConnection(input: {
  issuer: string;
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
}): Promise<Diagnosis> {
  const [jwks, authorization, token] = await Promise.all([
    probeJwks(input.jwksUrl),
    probeEndpoint(input.authLoginUrl),
    probeEndpoint(input.authTokenUrl),
  ]);

  const notes: string[] = [];
  let issuerMismatch: Diagnosis['issuerMismatch'] = null;

  // The `iss` a platform sends at login initiation must equal what is saved
  // here, character for character, or no registration will be found.
  const published = await discoverAt(input.issuer).catch(() => null);
  if (published && published.issuer !== input.issuer) {
    issuerMismatch = { saved: input.issuer, published: published.issuer };
    notes.push(
      `This platform publishes its issuer as "${published.issuer}" but the connection stores "${input.issuer}". ` +
        `Launches will be refused as "unregistered platform" until they match.`,
    );
  }

  if (!jwks.ok) notes.push(`Launch signatures cannot be verified: ${jwks.error}`);
  if (!authorization.ok) notes.push(`The authorization endpoint looks wrong: ${authorization.detail}`);
  if (!token.ok) notes.push(`The token endpoint looks wrong: ${token.detail}`);

  if (!notes.length) {
    notes.push(
      'Every endpoint answers and the key set is readable. A sign-in prompt during a launch is then the ' +
        'platform authenticating its own user, which this tool cannot and should not suppress.',
    );
  }

  return { jwks, authorization, token, issuerMismatch, notes };
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

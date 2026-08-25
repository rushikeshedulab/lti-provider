/**
 * PLATFORM DISCOVERY
 * ------------------
 * Connecting a new LMS should cost an administrator two pasted ids, not a
 * six-field form and a redeploy. Everything else about a platform - its
 * issuer, its authorization and token endpoints, and the JWKS this tool must
 * verify launches against - is published by the platform itself, so we fetch it
 * rather than ask for it.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 *
 * This module used to end with a guess. When no document answered it returned
 * one fixed endpoint layout - `/lti/authorize`, `/lti/token`,
 * `/.well-known/jwks.json` - which happens to be the demo consumer's shape and
 * is wrong for every LMS that does not share it. AI-LMS serves `/api/lti/auth`,
 * `/api/lti/token`, `/api/lti/jwks`, so the guess produced a saved connection
 * that launched into a path that does not exist.
 *
 * The guess was invisible because of how those platforms are deployed: nginx
 * answers any unknown non-API path with the front-end's index.html, at HTTP 200,
 * as text/html. Probing a wrong URL therefore looked exactly like probing a
 * right one. httpProbe.ts now rejects that shape explicitly, and this module no
 * longer invents an endpoint it could not confirm - a failure returns nulls and
 * a list of what every attempted address actually served, which the
 * administrator can act on.
 *
 * Nothing here is trusted as proof of anything, because every launch is still
 * verified against the JWKS at validation time.
 */

import {
  fetchJsonDocument,
  probeEndpoint,
  FETCH_TIMEOUT_MS,
  type EndpointReport,
  type FailureReason,
} from './httpProbe.js';

export type { EndpointReport } from './httpProbe.js';

/** One address that was tried, and what it served. This is what makes a failure actionable. */
export interface DiscoveryAttempt {
  url: string;
  reason: FailureReason;
  detail: string;
}

export interface DiscoveredPlatform {
  name: string | null;
  issuer: string | null;
  /**
   * The document that answered. Stored on the connection so the endpoints can be
   * re-read later instead of being frozen at the moment of saving.
   */
  discoveryUrl: string | null;
  /** Null when nothing could be confirmed. Never a guess. */
  authLoginUrl: string | null;
  authTokenUrl: string | null;
  jwksUrl: string | null;
  /** Which document answered, 'probed (<family>)', or 'none' when nothing did. */
  source: string;
  /** Populated when the platform also volunteered a client_id / deployment_id. */
  suggestedClientId: string | null;
  suggestedDeploymentId: string | null;
  warning: string | null;
  attempts: DiscoveryAttempt[];
}

/**
 * A whole discovery run is one synchronous admin request, and it can try seven
 * paths against two base URLs. Bound the total rather than the individual fetch,
 * so a platform that black-holes every request fails in a usable time.
 */
const DISCOVERY_BUDGET_MS = 20_000;

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
 * Where a platform might publish its configuration, in the order worth trying.
 *
 * The two standard locations come first: a platform that serves them is
 * authoritative about itself. The `/api/lti/...` mirrors come next because that
 * is where a backend-mounted platform can serve the document without any
 * reverse-proxy change - AI-LMS's case, and in practice the copy that answers
 * first. The two vendor-specific "own config" documents come last: they carry a
 * private field vocabulary, but `/lti/config` is also the only one that
 * volunteers a client_id and deployment_id.
 */
const DISCOVERY_PATHS = [
  { path: '/.well-known/openid-configuration', source: 'openid-configuration' },
  { path: '/.well-known/lti-platform-configuration', source: 'lti-platform-configuration' },
  { path: '/api/lti/.well-known/openid-configuration', source: 'openid-configuration (api/lti)' },
  { path: '/api/lti/.well-known/lti-platform-configuration', source: 'lti-platform-configuration (api/lti)' },
  { path: '/api/.well-known/openid-configuration', source: 'openid-configuration (api)' },
  { path: '/lti/config', source: 'lti/config' },
  { path: '/api/lti/config', source: 'api/lti/config' },
] as const;

/**
 * Endpoint layouts seen in the wild, tried only when no document answers.
 *
 * Ordered by how strongly a match identifies the platform. The three paths in a
 * family belong together: a token endpoint answers a GET with 404 (it is
 * registered for POST only), so it is taken from whichever family its siblings
 * matched rather than probed.
 */
const ENDPOINT_FAMILIES = [
  { name: 'api/lti', auth: '/api/lti/auth', token: '/api/lti/token', jwks: '/api/lti/jwks' },
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

/** The fields every discovery document shares, however it names itself. */
function readDocument(doc: Record<string, unknown>, baseUrl: string) {
  const lti = (doc['https://purl.imsglobal.org/spec/lti-platform-configuration'] ?? {}) as Record<string, unknown>;
  return {
    name: str(lti.product_family_code) ?? str(doc.platform_name) ?? null,
    issuer: str(doc.issuer) ?? str(doc.iss),
    authLoginUrl: absolute(str(doc.authorization_endpoint), baseUrl),
    authTokenUrl: absolute(str(doc.token_endpoint), baseUrl),
    jwksUrl: absolute(str(doc.jwks_uri) ?? str(doc.jwks_url), baseUrl),
    // Only this project's own description volunteers these; harmless elsewhere.
    suggestedClientId: str(doc.client_id),
    suggestedDeploymentId: str(doc.deployment_id),
  };
}

/** Tries the known documents at one address. Null when none answers. */
async function discoverAt(
  baseUrl: string,
  attempts: DiscoveryAttempt[],
  deadline: number,
): Promise<DiscoveredPlatform | null> {
  for (const candidate of DISCOVERY_PATHS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const url = `${baseUrl}${candidate.path}`;
    const result = await fetchJsonDocument(url, { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining) });
    if (!result.ok) {
      attempts.push({ url, reason: result.reason!, detail: result.detail });
      continue;
    }

    const read = readDocument(result.doc!, baseUrl);

    // A document must name the two endpoints a launch cannot happen without.
    // Accepting one that only declares an issuer would leave us guessing the
    // rest, which is the failure this module exists to stop. `token_endpoint`
    // may legitimately be absent - only LTI Advantage service calls need it.
    if (!read.authLoginUrl || !read.jwksUrl) {
      attempts.push({
        url,
        reason: 'not_object',
        detail:
          `Answered with a JSON document, but it names ` +
          `${!read.authLoginUrl ? 'no authorization_endpoint' : 'no jwks_uri'}, so it cannot be used to ` +
          `configure a connection.`,
      });
      continue;
    }

    return {
      name: read.name,
      issuer: read.issuer ?? baseUrl,
      discoveryUrl: url,
      authLoginUrl: read.authLoginUrl,
      authTokenUrl: read.authTokenUrl,
      jwksUrl: read.jwksUrl,
      source: candidate.source,
      suggestedClientId: read.suggestedClientId,
      suggestedDeploymentId: read.suggestedDeploymentId,
      warning: read.issuer
        ? null
        : `${url} does not state an issuer, so "${baseUrl}" is assumed. If launches are refused as coming ` +
          `from an unregistered platform, this is the field to correct.`,
      attempts: [],
    };
  }

  return null;
}

export async function discoverPlatform(rawUrl: string): Promise<DiscoveredPlatform> {
  const candidates = candidateBaseUrls(rawUrl);
  const attempts: DiscoveryAttempt[] = [];
  const deadline = Date.now() + DISCOVERY_BUDGET_MS;

  for (const candidate of candidates) {
    const found = await discoverAt(candidate, attempts, deadline);
    if (found) return { ...found, attempts };
  }

  // No discovery document anywhere. Find the endpoints by probing instead - but
  // only accept a layout whose key set we can actually read.
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;

    const scored = await Promise.all(
      ENDPOINT_FAMILIES.map(async (family) => {
        const [jwks, auth] = await Promise.all([
          probeJwks(`${candidate}${family.jwks}`),
          probeEndpoint(`${candidate}${family.auth}`),
        ]);
        return { family, jwksOk: jwks.ok, authOk: auth.ok, score: (jwks.ok ? 2 : 0) + (auth.ok ? 1 : 0) };
      }),
    );

    // Array.prototype.sort is stable, so equal scores keep the declaration order
    // above - which is the intended tie-break. Do not "optimise" this to an
    // unstable sort.
    const best = scored.sort((a, b) => b.score - a.score)[0]!;

    // A readable key set is the only unforgeable signal here. An authorization
    // path that merely answers proves little: a front-end route can return a
    // redirect to a login page and look identical. Without a key set the
    // connection could never verify a launch anyway, so it is not a candidate.
    if (best.jwksOk) {
      return {
        name: null,
        issuer: candidate,
        discoveryUrl: null,
        authLoginUrl: `${candidate}${best.family.auth}`,
        authTokenUrl: `${candidate}${best.family.token}`,
        jwksUrl: `${candidate}${best.family.jwks}`,
        source: `probed (${best.family.name})`,
        suggestedClientId: null,
        suggestedDeploymentId: null,
        warning:
          best.score === 3
            ? `No discovery document was published at ${candidate}, but a readable key set and a live ` +
              `authorization endpoint were found by probing. These endpoints will not be re-read ` +
              `automatically - ask the LMS to publish /.well-known/openid-configuration.`
            : `No discovery document was published at ${candidate}. A key set was found by probing, but the ` +
              `authorization endpoint could not be confirmed - check it against the LMS before saving.`,
        attempts,
      };
    }
  }

  return {
    name: null,
    issuer: null,
    discoveryUrl: null,
    authLoginUrl: null,
    authTokenUrl: null,
    jwksUrl: null,
    source: 'none',
    suggestedClientId: null,
    suggestedDeploymentId: null,
    warning:
      `Nothing at ${candidates[0]} publishes LTI endpoints - no configuration document, and no key set ` +
      `found by probing. The addresses tried and what each one served are listed below. Ask the LMS ` +
      `administrator for its authorization endpoint, token endpoint and JWKS URL, and enter them by hand.`,
    attempts,
  };
}

export interface EndpointValidation {
  ok: boolean;
  jwks: { ok: boolean; keys: number; error?: string };
  authorization: EndpointReport;
  /** Null when the platform publishes no token endpoint. */
  token: EndpointReport | null;
  failures: { field: 'issuer' | 'authLoginUrl' | 'authTokenUrl' | 'jwksUrl'; code: string; message: string }[];
  warnings: string[];
}

/**
 * Checks a set of endpoints against the live platform.
 *
 * The JWKS and the authorization endpoint are blocking: without the first no
 * launch can ever be verified, and without the second no launch can start. The
 * token endpoint is a warning only - it is probed with POST (a GET on a
 * POST-only route answers 404 and would condemn a correct configuration), and it
 * can legitimately sit behind a rate limiter or mTLS that answers anything.
 * Refusing the wrong authorization and JWKS URLs already closes the hole.
 */
export async function validateEndpoints(input: {
  issuer: string | null;
  authLoginUrl: string | null;
  authTokenUrl: string | null;
  jwksUrl: string | null;
}): Promise<EndpointValidation> {
  const failures: EndpointValidation['failures'] = [];
  const warnings: string[] = [];

  const absoluteUrl = (value: string | null): boolean => {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  };

  for (const [field, value] of [
    ['issuer', input.issuer],
    ['authLoginUrl', input.authLoginUrl],
    ['jwksUrl', input.jwksUrl],
  ] as const) {
    if (!absoluteUrl(value)) {
      failures.push({
        field,
        code: 'invalid_endpoint',
        message: value
          ? `"${value}" is not an http(s) URL.`
          : `This value is required and was not supplied.`,
      });
    }
  }
  if (input.authTokenUrl && !absoluteUrl(input.authTokenUrl)) {
    failures.push({ field: 'authTokenUrl', code: 'invalid_endpoint', message: `"${input.authTokenUrl}" is not an http(s) URL.` });
  }

  const [jwks, authorization, token] = await Promise.all([
    input.jwksUrl && absoluteUrl(input.jwksUrl)
      ? probeJwks(input.jwksUrl)
      : Promise.resolve({ ok: false, keys: 0, error: 'No JWKS URL was supplied.' }),
    input.authLoginUrl && absoluteUrl(input.authLoginUrl)
      ? probeEndpoint(input.authLoginUrl)
      : Promise.resolve<EndpointReport>({
          url: input.authLoginUrl ?? '',
          ok: false,
          status: null,
          contentType: null,
          verdict: 'unreachable',
          detail: 'No authorization URL was supplied.',
        }),
    input.authTokenUrl && absoluteUrl(input.authTokenUrl)
      ? probeEndpoint(input.authTokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        })
      : Promise.resolve(null),
  ]);

  if (!jwks.ok) {
    failures.push({ field: 'jwksUrl', code: 'jwks_unreachable', message: jwks.error! });
  }
  if (!authorization.ok && absoluteUrl(input.authLoginUrl)) {
    failures.push({ field: 'authLoginUrl', code: 'endpoint_not_found', message: authorization.detail });
  }
  if (token && !token.ok) {
    warnings.push(`The token endpoint could not be confirmed: ${token.detail} LTI Advantage service calls may fail.`);
  }
  if (!input.authTokenUrl) {
    warnings.push('This platform publishes no token endpoint, so LTI Advantage service calls are unavailable.');
  }

  return { ok: failures.length === 0, jwks, authorization, token, failures, warnings };
}

export interface Diagnosis extends EndpointValidation {
  /** Set when the platform's own config disagrees with what was saved. */
  issuerMismatch: { saved: string; published: string } | null;
  notes: string[];
}

/**
 * Checks a saved connection against the platform as it is right now. The point
 * is to separate "this tool is pointed at the wrong URL", which is fixable
 * here, from "the platform wants the user to sign in", which is not.
 */
export async function diagnoseConnection(input: {
  issuer: string;
  authLoginUrl: string;
  authTokenUrl: string | null;
  jwksUrl: string;
  /** Preferred over re-discovering from the issuer, which is not always a base URL. */
  discoveryUrl?: string | null;
}): Promise<Diagnosis> {
  const validation = await validateEndpoints(input);
  const notes: string[] = [];
  let issuerMismatch: Diagnosis['issuerMismatch'] = null;

  // The `iss` a platform sends at login initiation must equal what is saved
  // here, character for character, or no registration will be found.
  const published = input.discoveryUrl
    ? await fetchJsonDocument(input.discoveryUrl).then((r) => (r.ok ? str(r.doc!.issuer) : null)).catch(() => null)
    : await discoverPlatform(input.issuer)
        .then((d) => d.issuer)
        .catch(() => null);

  if (published && published !== input.issuer) {
    issuerMismatch = { saved: input.issuer, published };
    notes.push(
      `This platform publishes its issuer as "${published}" but the connection stores "${input.issuer}". ` +
        `Launches will be refused as "unregistered platform" until they match.`,
    );
  }

  for (const failure of validation.failures) notes.push(failure.message);
  for (const warning of validation.warnings) notes.push(warning);

  if (!notes.length) {
    notes.push(
      'Every endpoint answers and the key set is readable. A sign-in prompt during a launch is then the ' +
        'platform authenticating its own user, which this tool cannot and should not suppress.',
    );
  }

  return { ...validation, issuerMismatch, notes };
}

/**
 * Confirms the platform really does publish a usable key set. A registration
 * whose JWKS cannot be read would accept the pasted ids and then fail every
 * launch with a signature error, which is a far worse place to find out.
 */
export async function probeJwks(jwksUrl: string): Promise<{ ok: boolean; keys: number; error?: string }> {
  const result = await fetchJsonDocument(jwksUrl);
  if (!result.ok) return { ok: false, keys: 0, error: result.detail };
  const keys = Array.isArray(result.doc!.keys) ? (result.doc!.keys as unknown[]).length : 0;
  if (keys === 0) return { ok: false, keys: 0, error: `${jwksUrl} returned a JSON document with no "keys" array.` };
  return { ok: true, keys };
}

/**
 * OUTBOUND HTTP, WITH THE ANSWERS ACTUALLY CHECKED
 * ------------------------------------------------
 * Every probe this tool makes against a platform used to treat "the server
 * responded" as "the endpoint exists". That is wrong in one specific and very
 * common deployment: a single-page app behind nginx with
 * `try_files $uri $uri/ /index.html` answers EVERY unknown path with the app
 * shell, at HTTP 200, as text/html. So a wrong URL is indistinguishable from a
 * right one - discovery "finds" endpoints that were never there, the admin saves
 * them, and the failure surfaces much later as a launch that redirects into
 * nothing.
 *
 * The rule that fixes it is short: a 200 whose body is HTML proves nothing.
 * Everything here exists to apply that rule consistently, in one place, instead
 * of in three hand-rolled fetches that each got it slightly differently.
 */

export type FailureReason =
  | 'bad_url'
  | 'unreachable'
  | 'timeout'
  | 'http_status'
  /** 2xx text/html - a single-page-app catch-all is answering, not an endpoint. */
  | 'spa_html'
  | 'not_json'
  | 'unparsable'
  | 'not_object'
  | 'too_large';

export const FETCH_TIMEOUT_MS = 8_000;

/** A discovery document that does not fit in this is not a discovery document. */
const MAX_DOCUMENT_BYTES = 1_000_000;

export interface JsonDocumentResult {
  ok: boolean;
  url: string;
  status: number | null;
  contentType: string | null;
  doc: Record<string, unknown> | null;
  reason: FailureReason | null;
  /** One sentence, safe to show an administrator verbatim. */
  detail: string;
}

/** The bare content-type, lower-cased, with any charset parameter dropped. */
function baseContentType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
}

function isJsonType(type: string): boolean {
  // `application/json` and the +json family (application/jwk-set+json, and the
  // LTI NRPS membership container). An absent content-type is tolerated because
  // some minimal JWKS handlers omit it - the parse and shape checks still have
  // to pass, so nothing is accepted on the header's word alone.
  return type === '' || type === 'application/json' || /^application\/[a-z0-9.+-]*\+json$/.test(type);
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T } | { error: 'timeout' | 'unreachable'; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return { value: await run(controller.signal) };
  } catch (err) {
    const error = err as Error;
    // AbortError is our own timer firing; anything else is DNS/TCP/TLS.
    return error.name === 'AbortError'
      ? { error: 'timeout', message: `no answer within ${Math.round(timeoutMs / 1000)}s` }
      : { error: 'unreachable', message: error.message };
  } finally {
    clearTimeout(timer);
  }
}

/** `fetch` with a timeout, for calls whose body is not a document (token grants). */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a JSON document, or explains precisely why there isn't one there.
 *
 * Every check below is a hard failure. In particular a body that parses as JSON
 * is still rejected when the server called it text/html, and an HTML body is
 * reported as `spa_html` rather than as a generic parse error, because "your
 * front-end is answering this path" is a different problem for the administrator
 * than "the document is malformed".
 */
export async function fetchJsonDocument(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<JsonDocumentResult> {
  const fail = (
    reason: FailureReason,
    detail: string,
    status: number | null = null,
    contentType: string | null = null,
  ): JsonDocumentResult => ({ ok: false, url, status, contentType, doc: null, reason, detail });

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fail('bad_url', `"${url}" is not an http(s) URL.`);
    }
  } catch {
    return fail('bad_url', `"${url}" is not a valid URL.`);
  }

  const attempt = await withTimeout(options.timeoutMs ?? FETCH_TIMEOUT_MS, (signal) =>
    fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow', signal }),
  );
  if ('error' in attempt) return fail(attempt.error, `${url} could not be reached: ${attempt.message}.`);

  const response = attempt.value;
  const contentType = baseContentType(response);

  if (!response.ok) {
    return fail('http_status', `${url} answered HTTP ${response.status}.`, response.status, contentType);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_DOCUMENT_BYTES) {
    return fail(
      'too_large',
      `${url} returned ${declaredLength} bytes, far too large to be a configuration document.`,
      response.status,
      contentType,
    );
  }

  if (contentType.startsWith('text/html')) {
    return fail(
      'spa_html',
      `${url} answered HTTP ${response.status} with text/html. That is a single-page app serving its ` +
        `index.html for an unknown path, not a configuration document - this path does not exist on the platform.`,
      response.status,
      contentType,
    );
  }
  if (!isJsonType(contentType)) {
    return fail('not_json', `${url} answered with "${contentType}", which is not JSON.`, response.status, contentType);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return fail(
      'unreachable',
      `${url} closed before the body was read: ${(err as Error).message}`,
      response.status,
      contentType,
    );
  }
  if (text.length > MAX_DOCUMENT_BYTES) {
    return fail(
      'too_large',
      `${url} returned ${text.length} bytes, far too large to be a configuration document.`,
      response.status,
      contentType,
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return fail('unparsable', `${url} claims to serve JSON but the body did not parse.`, response.status, contentType);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return fail('not_object', `${url} returned JSON, but not an object.`, response.status, contentType);
  }

  return {
    ok: true,
    url,
    status: response.status,
    contentType,
    doc: doc as Record<string, unknown>,
    reason: null,
    detail: `Read a JSON document (HTTP ${response.status}).`,
  };
}

export type EndpointVerdict = 'ok' | 'html_catchall' | 'missing' | 'server_error' | 'unreachable';

export interface EndpointReport {
  url: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  verdict: EndpointVerdict;
  detail: string;
}

/**
 * Reaches an endpoint just far enough to tell "wrong URL" from "works".
 *
 * `redirect: 'manual'` matters: an authorization endpoint answering a
 * session-less request with a redirect to its own login page is normal, and
 * following it would hide the fact that the endpoint exists at all.
 *
 * A token endpoint must be probed with `method: 'POST'` - it is registered for
 * POST only, and Express answers a GET on a POST-only path with 404, which reads
 * as "the path is wrong" for a configuration that is in fact correct.
 */
export async function probeEndpoint(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<EndpointReport> {
  const report = (
    verdict: EndpointVerdict,
    ok: boolean,
    detail: string,
    status: number | null = null,
    contentType: string | null = null,
  ): EndpointReport => ({ url, ok, status, contentType, verdict, detail });

  try {
    new URL(url);
  } catch {
    return report('unreachable', false, `"${url}" is not a valid URL.`);
  }

  const attempt = await withTimeout(options.timeoutMs ?? FETCH_TIMEOUT_MS, (signal) =>
    fetch(url, {
      method: options.method ?? 'GET',
      body: options.body,
      headers: options.headers,
      redirect: 'manual',
      signal,
    }),
  );
  if ('error' in attempt) return report('unreachable', false, `Unreachable: ${attempt.message}.`);

  const response = attempt.value;
  const status = response.status;
  const contentType = baseContentType(response);

  if (status === 404 || status === 405) {
    return report('missing', false, `Nothing is served here (HTTP ${status}). The path is wrong.`, status, contentType);
  }
  if (status >= 500) {
    return report('server_error', false, `The platform returned HTTP ${status}.`, status, contentType);
  }
  // Judged before the HTML rule below: a redirect has no meaningful body.
  if (status >= 300 && status < 400) {
    return report(
      'ok',
      true,
      `Answers, and redirects a request with no session - normal for an authorization endpoint. ` +
        `If a user sees a login page during a launch, that redirect is the platform asking them to sign in.`,
      status,
      contentType,
    );
  }
  // Only a SUCCESSFUL HTML response is the catch-all signal. A 4xx HTML page is
  // the opposite - it is an endpoint that exists, read the request, and rejected
  // it, which is exactly what an authorization endpoint does when probed with no
  // OIDC parameters (lti-consumer-lms answers 400 text/html from
  // renderErrorPage). Condemning those would refuse every correct connection.
  if (status < 300 && contentType.startsWith('text/html')) {
    return report(
      'html_catchall',
      false,
      `Answered HTTP ${status} with text/html. That is the platform's single-page app serving index.html ` +
        `for an unknown path, not an LTI endpoint - this path does not exist.`,
      status,
      contentType,
    );
  }
  if (status >= 400) {
    return report(
      'ok',
      true,
      `Answers, and rejects a request carrying no parameters with HTTP ${status} - normal for an endpoint ` +
        `that is really there.`,
      status,
      contentType,
    );
  }
  return report('ok', true, `Answers with HTTP ${status}.`, status, contentType);
}

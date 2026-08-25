/**
 * Exercises discovery against two fake platforms:
 *
 *   1. an SPA catch-all that answers EVERY path with index.html at HTTP 200 -
 *      the deployment shape that made a wrong endpoint indistinguishable from a
 *      right one;
 *   2. an AI-LMS-shaped platform that publishes a real document under
 *      /api/lti/.well-known/openid-configuration.
 *
 * Run with: npx tsx scripts/check-discovery.ts
 */
import { createServer, type Server } from 'node:http';
import { discoverPlatform, validateEndpoints } from '../src/services/platformDiscovery.js';
import { probeEndpoint, fetchJsonDocument } from '../src/services/httpProbe.js';

const SPA = '<!doctype html><html><body><div id="root"></div></body></html>';

function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve) => server.listen(port, () => resolve(`http://127.0.0.1:${port}`)));
}

/** Answers everything with the app shell, exactly like `try_files ... /index.html`. */
const spaOnly = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SPA);
});

/** AI-LMS's real shape: /api/* is the backend, everything else is the SPA. */
const aiLms = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const json = (body: unknown) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  if (url.pathname === '/api/lti/.well-known/openid-configuration') {
    return json({
      issuer: 'http://127.0.0.1:4103',
      authorization_endpoint: 'http://127.0.0.1:4103/api/lti/auth',
      token_endpoint: 'http://127.0.0.1:4103/api/lti/token',
      jwks_uri: 'http://127.0.0.1:4103/api/lti/jwks',
      platform_name: 'Edulab AI LMS',
    });
  }
  if (url.pathname === '/api/lti/jwks') {
    return json({ keys: [{ kty: 'RSA', kid: 'k1', use: 'sig', alg: 'RS256', n: 'x', e: 'AQAB' }] });
  }
  if (url.pathname === '/api/lti/auth') {
    return res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing required OIDC parameters');
  }
  // lti-consumer-lms answers a parameterless probe with an HTML error page.
  if (url.pathname === '/lti/authorize') {
    return res.writeHead(400, { 'content-type': 'text/html' }).end('<h1>Authorization request rejected</h1>');
  }
  if (url.pathname === '/api/lti/token') {
    if (req.method !== 'POST') return res.writeHead(404).end();
    return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"unsupported_grant_type"}');
  }
  if (url.pathname.startsWith('/api/')) return res.writeHead(404).end();
  return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SPA);
});

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

const spaUrl = await listen(spaOnly, 4102);
const lmsUrl = await listen(aiLms, 4103);

console.log('\n--- the SPA catch-all must fool nothing ---------------------------\n');

const spaDoc = await fetchJsonDocument(`${spaUrl}/.well-known/openid-configuration`);
check('a 200 text/html document is rejected', [spaDoc.ok, spaDoc.reason], [false, 'spa_html']);

const spaProbe = await probeEndpoint(`${spaUrl}/lti/authorize`);
check('a 200 text/html endpoint is not proof', [spaProbe.ok, spaProbe.verdict], [false, 'html_catchall']);

const spaDiscovery = await discoverPlatform(spaUrl);
check('discovery gives up instead of guessing', spaDiscovery.source, 'none');
check('no endpoint is invented', [spaDiscovery.authLoginUrl, spaDiscovery.authTokenUrl, spaDiscovery.jwksUrl], [null, null, null]);
console.log(`        (${spaDiscovery.attempts.length} addresses tried, each reported)`);

const spaSave = await validateEndpoints({
  issuer: spaUrl,
  authLoginUrl: `${spaUrl}/lti/authorize`,
  authTokenUrl: `${spaUrl}/lti/token`,
  jwksUrl: `${spaUrl}/.well-known/jwks.json`,
});
check('the old guessed endpoints cannot be saved', spaSave.ok, false);
check(
  'and the failures name the two blocking fields',
  spaSave.failures.map((f) => f.field).sort(),
  ['authLoginUrl', 'jwksUrl'],
);

// A working endpoint that renders an HTML error page for a parameterless GET is
// NOT the catch-all. Only a 2xx text/html is.
const htmlError = await probeEndpoint(`${lmsUrl}/lti/authorize`);
check('a 4xx HTML error page still proves the endpoint exists', [htmlError.ok, htmlError.verdict], [true, 'ok']);

console.log('\n--- the real AI-LMS shape must be found ---------------------------\n');

const found = await discoverPlatform(lmsUrl);
check('the document under /api/lti is found', found.source, 'openid-configuration (api/lti)');
check('the authorization endpoint is the real one', found.authLoginUrl, `${lmsUrl}/api/lti/auth`);
check('the token endpoint is the real one', found.authTokenUrl, `${lmsUrl}/api/lti/token`);
check('the JWKS is the real one', found.jwksUrl, `${lmsUrl}/api/lti/jwks`);
check('the discovery URL is retained for re-reading', found.discoveryUrl, `${lmsUrl}/api/lti/.well-known/openid-configuration`);

const goodSave = await validateEndpoints({
  issuer: found.issuer,
  authLoginUrl: found.authLoginUrl,
  authTokenUrl: found.authTokenUrl,
  jwksUrl: found.jwksUrl,
});
check('a correct connection validates', [goodSave.ok, goodSave.failures.length], [true, 0]);
// The regression the GET probe used to cause: /api/lti/token is POST-only, and a
// GET answers 404, which read as "the path is wrong" on a correct config.
check('the POST-only token endpoint is not condemned', goodSave.token?.ok, true);

spaOnly.close();
aiLms.close();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);

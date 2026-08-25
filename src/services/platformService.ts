import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { env } from '../config/env.js';
import { getPrivateKey, SIGNING_ALG } from '../lti/keys.js';
import { findPlatform, type PlatformRegistration } from '../lti/platformStore.js';
import { getLaunch } from './launchStore.js';
import type { ViewingSessionRow } from './viewingSession.js';
import { resolvePlatformEndpoints } from './platformEndpoints.js';
import { fetchWithTimeout } from './httpProbe.js';

/**
 * LTI ADVANTAGE SERVICE CALLS (tool -> platform)
 * ---------------------------------------------
 * Everything above this line is browser-mediated. This file is the other
 * direction: a plain server-to-server call, authorised with the OAuth 2.0
 * client_credentials grant using a `private_key_jwt` client assertion - exactly
 * the mechanism AGS (grades) and NRPS (rosters) use.
 *
 * The endpoint we call here (`/lti/services/viewing-summary`) is NOT part of the
 * LTI specification; it is a small demo service that lets the consumer LMS
 * display viewing duration without ever storing the content. It exists to prove
 * the token endpoint works end to end.
 */
export const VIEWING_SUMMARY_SCOPE = 'https://edulab.example/lti/scope/viewing.report';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

async function buildClientAssertion(platform: PlatformRegistration, tokenUrl: string): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({})
    .setProtectedHeader({ alg: SIGNING_ALG, kid: env.keyId, typ: 'JWT' })
    .setIssuer(platform.client_id) // the tool identifies itself by its client_id
    .setSubject(platform.client_id)
    .setAudience(tokenUrl)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(key);
}

export async function getAccessToken(platform: PlatformRegistration, scope: string): Promise<string> {
  const endpoints = await resolvePlatformEndpoints(platform);
  const tokenUrl = endpoints.authTokenUrl;
  if (!tokenUrl) {
    throw new Error(
      `Platform "${platform.issuer}" publishes no token endpoint, so LTI Advantage service calls are unavailable.`,
    );
  }

  // The token URL is part of the key: the client assertion is addressed to it,
  // so a token minted for the previous audience would be rejected outright if
  // the platform moved its token endpoint.
  const cacheKey = `${platform.id}:${tokenUrl}:${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5_000) return cached.accessToken;

  const assertion = await buildClientAssertion(platform, tokenUrl);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    scope,
  });

  // Timed: an unresponsive platform token endpoint used to hang this call - and
  // the activity report behind it - indefinitely.
  const response = await fetchWithTimeout(
    tokenUrl,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    10_000,
  );

  if (!response.ok) {
    throw new Error(`Token endpoint returned ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(cacheKey, {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

export async function reportViewingSummary(session: ViewingSessionRow): Promise<void> {
  const platform = await findPlatform(session.platform_issuer);
  if (!platform) return;

  // The consumer keys its own records by ITS launch id, which reached us as the
  // lti_message_hint at login initiation. Without it there is nothing to update.
  const launch = await getLaunch(session.launch_id);
  if (!launch?.platform_launch_id) return;

  const accessToken = await getAccessToken(platform, VIEWING_SUMMARY_SCOPE);

  const response = await fetchWithTimeout(`${platform.issuer}/lti/services/viewing-summary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      launchId: launch.platform_launch_id,
      providerLaunchId: session.launch_id,
      viewingSessionId: session.id,
      userId: session.user_id,
      lectureId: session.lecture_id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      presenceSeconds: session.presence_seconds,
      watchedSeconds: session.watched_seconds,
      endReason: session.end_reason,
    }),
  });

  if (!response.ok) {
    throw new Error(`viewing-summary returned ${response.status}`);
  }
  // A 200 is not enough on its own. This path is not part of the LTI spec, so a
  // platform that does not implement it answers with whatever its front-end
  // serves for an unknown path - typically index.html at HTTP 200 - and we would
  // log a successful push that pushed nothing.
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType.startsWith('text/html')) {
    throw new Error(
      `viewing-summary answered HTTP ${response.status} with text/html - this platform does not implement ` +
        `the viewing-summary service, its front-end is answering the path.`,
    );
  }
  console.log(`[service-call] pushed viewing summary for session ${session.id} to ${platform.issuer}`);
}

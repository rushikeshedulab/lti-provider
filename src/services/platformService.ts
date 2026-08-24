import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { env } from '../config/env.js';
import { getPrivateKey, SIGNING_ALG } from '../lti/keys.js';
import { findPlatform, markActivationReported, type PlatformRegistration } from '../lti/platformStore.js';
import { getLaunch } from './launchStore.js';
import type { ViewingSessionRow } from './viewingSession.js';

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
export const CONNECTION_SCOPE = 'https://edulab.example/lti/scope/connection.report';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

async function buildClientAssertion(platform: PlatformRegistration): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({})
    .setProtectedHeader({ alg: SIGNING_ALG, kid: env.keyId, typ: 'JWT' })
    .setIssuer(platform.client_id) // the tool identifies itself by its client_id
    .setSubject(platform.client_id)
    .setAudience(platform.auth_token_url)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(key);
}

export async function getAccessToken(platform: PlatformRegistration, scope: string): Promise<string> {
  const cacheKey = `${platform.id}:${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5_000) return cached.accessToken;

  const assertion = await buildClientAssertion(platform);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    scope,
  });

  const response = await fetch(platform.auth_token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

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

  const response = await fetch(`${platform.issuer}/lti/services/viewing-summary`, {
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
  console.log(`[service-call] pushed viewing summary for session ${session.id} to ${platform.issuer}`);
}

/**
 * Tells the platform that an instructor has completed the setup launch, so its
 * own screens can stop saying "waiting for your instructor" and let students
 * through. The tool's gate does not depend on this call succeeding - it is the
 * platform's copy of a decision this side has already made and stored.
 */
export async function reportDeploymentActivated(
  platform: PlatformRegistration,
  deploymentId: string,
  by: { userId: string; email?: string | null; name?: string | null; contextId?: string | null },
): Promise<void> {
  const accessToken = await getAccessToken(platform, CONNECTION_SCOPE);

  const response = await fetch(`${platform.issuer}/lti/services/deployment-activated`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      clientId: platform.client_id,
      deploymentId,
      activatedAt: new Date().toISOString(),
      activatedBy: { userId: by.userId, email: by.email ?? null, name: by.name ?? null },
      contextId: by.contextId ?? null,
    }),
  });

  if (!response.ok) {
    throw new Error(`deployment-activated returned ${response.status}`);
  }

  await markActivationReported(platform.id, deploymentId);
  console.log(`[service-call] told ${platform.issuer} that deployment ${deploymentId} is live`);
}

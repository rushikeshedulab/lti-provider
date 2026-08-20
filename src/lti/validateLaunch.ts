import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { env, toolEndpoints } from '../config/env.js';
import { CLAIM, LTI_VERSION, MESSAGE_TYPE, type LtiIdTokenClaims } from './claims.js';
import { findPlatform, type PlatformRegistration } from './platformStore.js';
import { consumeNonce, consumeState, type OidcStateRow } from './stateStore.js';

export class LtiValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LtiValidationError';
  }
}

/** One remote JWKS per platform, cached by jose (respects Cache-Control, refetches on unknown kid). */
const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwksFor(url: string): JWTVerifyGetKey {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 5 * 60_000, cooldownDuration: 5_000 });
    jwksCache.set(url, set);
  }
  return set;
}

export interface ValidatedLaunch {
  claims: LtiIdTokenClaims;
  platform: PlatformRegistration;
  stateRow: OidcStateRow;
  messageType: string;
  deploymentId: string;
  /** Ordered list of the checks that were performed - surfaced in the UI for the demo. */
  checks: { step: string; detail: string }[];
}

/**
 * Full LTI 1.3 / OIDC validation of an incoming launch.
 *
 * Order matters: we must know WHICH platform sent the token before we can pick
 * the key to verify it with, so the untrusted payload is decoded first purely
 * to read `iss`/`aud`. Nothing from that decode is trusted until jwtVerify passes.
 */
export async function validateLaunch(input: {
  idToken: string;
  state: string;
  cookieState?: string;
}): Promise<ValidatedLaunch> {
  const checks: { step: string; detail: string }[] = [];

  if (!input.idToken) throw new LtiValidationError('missing_id_token', 'No id_token in the launch request');
  if (!input.state) throw new LtiValidationError('missing_state', 'No state in the launch request');

  // --- 1. Untrusted peek: who claims to have sent this? -------------------
  let unverified: LtiIdTokenClaims;
  try {
    unverified = decodeJwt(input.idToken) as LtiIdTokenClaims;
  } catch {
    throw new LtiValidationError('malformed_id_token', 'id_token is not a well-formed JWT');
  }

  const audience = Array.isArray(unverified.aud) ? unverified.aud : [unverified.aud];
  const clientId = unverified.azp ?? audience[0];

  // --- 2. Is this issuer/client registered with us? -----------------------
  const platform = await findPlatform(unverified.iss, clientId);
  if (!platform) {
    throw new LtiValidationError(
      'unknown_platform',
      `No active registration for issuer "${unverified.iss}" and client_id "${clientId}"`,
    );
  }
  checks.push({
    step: 'Platform registration',
    detail: `iss=${platform.issuer} client_id=${platform.client_id} matched registration #${platform.id}`,
  });

  // --- 3. state: CSRF protection, single use, server-side -----------------
  const stateRow = await consumeState(input.state);
  if (!stateRow) {
    throw new LtiValidationError('invalid_state', 'state is unknown, expired, or already used');
  }
  if (stateRow.platform_id !== platform.id) {
    throw new LtiValidationError('state_platform_mismatch', 'state was issued for a different platform');
  }
  checks.push({ step: 'State validation', detail: 'state matched a pending, unexpired login initiation' });

  if (input.cookieState) {
    if (input.cookieState !== input.state) {
      throw new LtiValidationError('state_cookie_mismatch', 'state cookie does not match the returned state');
    }
    checks.push({ step: 'State cookie', detail: 'browser-bound state cookie matched' });
  } else {
    checks.push({
      step: 'State cookie',
      detail: 'not present (blocked as a third-party cookie in the iframe) - server-side state store used instead',
    });
  }

  // --- 4. Signature, issuer, audience, expiry ----------------------------
  let claims: LtiIdTokenClaims;
  try {
    const verified = await jwtVerify(input.idToken, jwksFor(platform.jwks_url), {
      issuer: platform.issuer,
      audience: platform.client_id,
      algorithms: ['RS256'],
      clockTolerance: 30,
      maxTokenAge: env.maxTokenAgeSeconds,
    });
    claims = verified.payload as LtiIdTokenClaims;
    checks.push({
      step: 'Signature verification',
      detail: `RS256 verified against ${platform.jwks_url} (kid=${verified.protectedHeader.kid ?? 'n/a'})`,
    });
  } catch (err) {
    throw new LtiValidationError('invalid_signature', `id_token verification failed: ${(err as Error).message}`);
  }
  checks.push({ step: 'Issuer / audience', detail: `iss and aud both matched the registration` });

  // Per LTI spec: when `aud` has multiple values, `azp` is REQUIRED and must be the client_id.
  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audList.length > 1) {
    if (!claims.azp) throw new LtiValidationError('missing_azp', 'aud has multiple values but azp is absent');
    if (claims.azp !== platform.client_id) {
      throw new LtiValidationError('invalid_azp', 'azp does not match the registered client_id');
    }
    checks.push({ step: 'azp', detail: 'multi-valued aud accompanied by a matching azp' });
  }

  // --- 5. nonce: single-use replay protection ----------------------------
  if (!claims.nonce) throw new LtiValidationError('missing_nonce', 'id_token has no nonce claim');
  if (claims.nonce !== stateRow.nonce) {
    throw new LtiValidationError('nonce_mismatch', 'id_token nonce does not match the nonce we issued');
  }
  const nonceFresh = await consumeNonce(claims.nonce, platform.id);
  if (!nonceFresh) throw new LtiValidationError('nonce_replay', 'nonce has already been used');
  checks.push({ step: 'Nonce', detail: 'matched the issued nonce and had not been used before' });

  // --- 6. LTI message shape ----------------------------------------------
  const version = claims[CLAIM.VERSION];
  if (version !== LTI_VERSION) {
    throw new LtiValidationError('bad_version', `Expected LTI version ${LTI_VERSION}, got ${String(version)}`);
  }

  const messageType = claims[CLAIM.MESSAGE_TYPE] as string | undefined;
  const allowed: string[] = [MESSAGE_TYPE.RESOURCE_LINK_REQUEST, MESSAGE_TYPE.DEEP_LINKING_REQUEST];
  if (!messageType || !allowed.includes(messageType)) {
    throw new LtiValidationError('bad_message_type', `Unsupported message_type: ${String(messageType)}`);
  }

  const deploymentId = claims[CLAIM.DEPLOYMENT_ID] as string | undefined;
  if (!deploymentId) throw new LtiValidationError('missing_deployment_id', 'id_token has no deployment_id claim');
  if (!platform.deployment_ids.includes(deploymentId)) {
    throw new LtiValidationError('unknown_deployment_id', `deployment_id "${deploymentId}" is not registered`);
  }
  checks.push({ step: 'Deployment', detail: `deployment_id=${deploymentId} is registered for this platform` });

  const targetLinkUri = claims[CLAIM.TARGET_LINK_URI] as string | undefined;
  if (!targetLinkUri) throw new LtiValidationError('missing_target_link_uri', 'id_token has no target_link_uri claim');
  if (normalise(targetLinkUri) !== normalise(toolEndpoints.targetLinkUri)) {
    throw new LtiValidationError(
      'bad_target_link_uri',
      `target_link_uri "${targetLinkUri}" is not this tool's launch URL`,
    );
  }

  if (!claims.sub) throw new LtiValidationError('missing_sub', 'id_token has no sub claim (no user identity)');

  checks.push({
    step: 'Message validation',
    detail: `${messageType} v${LTI_VERSION}, target_link_uri and sub present`,
  });

  return { claims, platform, stateRow, messageType, deploymentId, checks };
}

function normalise(url: string): string {
  return url.replace(/\/$/, '').toLowerCase();
}

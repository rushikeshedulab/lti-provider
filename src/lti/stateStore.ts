import { randomBytes } from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { env } from '../config/env.js';

/**
 * OIDC state + nonce handling.
 *
 * `state` protects the login-initiation -> launch round trip from CSRF.
 * `nonce` makes each id_token single-use, defeating replay.
 *
 * Both are persisted server-side. The state is ALSO written to a cookie, but
 * cookie validation is treated as a bonus signal rather than a hard requirement
 * because the tool runs inside a cross-site iframe where the browser may drop
 * the cookie entirely (see README - "Third-party cookies and the iframe").
 */

export interface OidcStateRow {
  state: string;
  nonce: string;
  platform_id: number;
  target_link_uri: string;
  lti_message_hint: string | null;
  login_hint: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function createState(input: {
  platformId: number;
  targetLinkUri: string;
  ltiMessageHint?: string | null;
  loginHint?: string | null;
}): Promise<{ state: string; nonce: string }> {
  const state = randomToken();
  const nonce = randomToken();
  await query(
    `INSERT INTO lti_oidc_state (state, nonce, platform_id, target_link_uri, lti_message_hint, login_hint, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
    [
      state,
      nonce,
      input.platformId,
      input.targetLinkUri,
      input.ltiMessageHint ?? null,
      input.loginHint ?? null,
      String(env.stateTtlSeconds),
    ],
  );
  return { state, nonce };
}

/** Atomically consume the state: succeeds exactly once, and only before expiry. */
export async function consumeState(state: string): Promise<OidcStateRow | null> {
  return queryOne<OidcStateRow>(
    `UPDATE lti_oidc_state
        SET consumed_at = now()
      WHERE state = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING *`,
    [state],
  );
}

/** Records a nonce; returns false if it has been seen before (replay). */
export async function consumeNonce(nonce: string, platformId: number): Promise<boolean> {
  const row = await queryOne(
    `INSERT INTO lti_nonces (nonce, platform_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
     ON CONFLICT (nonce) DO NOTHING
     RETURNING nonce`,
    [nonce, platformId, String(env.nonceTtlSeconds)],
  );
  return row !== null;
}

export async function purgeExpired(): Promise<void> {
  await query(`DELETE FROM lti_oidc_state WHERE expires_at < now() - interval '1 hour'`);
  await query(`DELETE FROM lti_nonces WHERE expires_at < now() - interval '1 hour'`);
  await query(`DELETE FROM launch_tokens WHERE expires_at < now() - interval '1 hour'`);
}

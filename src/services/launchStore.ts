import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { randomToken } from '../lti/stateStore.js';

export interface LaunchRow {
  id: string;
  platform_id: number;
  platform_issuer: string;
  platform_client_id: string;
  platform_name: string | null;
  deployment_id: string;
  message_type: string;
  lti_version: string;
  token_jti: string | null;
  nonce: string;
  platform_launch_id: string | null;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  roles: string[];
  context_id: string | null;
  context_title: string | null;
  resource_link_id: string | null;
  resource_link_title: string | null;
  course_id: string | null;
  module_id: string | null;
  lecture_id: string | null;
  launched_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  id_token_claims: Record<string, unknown>;
}

export interface RecordLaunchInput {
  platformId: number;
  platformIssuer: string;
  platformClientId: string;
  platformName?: string | null;
  deploymentId: string;
  messageType: string;
  ltiVersion: string;
  tokenJti?: string | null;
  nonce: string;
  /** The consumer's launch-session id, taken from lti_message_hint. */
  platformLaunchId?: string | null;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  roles: string[];
  contextId?: string | null;
  contextTitle?: string | null;
  resourceLinkId?: string | null;
  resourceLinkTitle?: string | null;
  courseId?: string | null;
  moduleId?: string | null;
  lectureId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  claims: Record<string, unknown>;
}

export async function recordLaunch(input: RecordLaunchInput): Promise<LaunchRow> {
  const id = randomUUID();
  const row = await queryOne<LaunchRow>(
    `INSERT INTO lti_launches (
       id, platform_id, platform_issuer, platform_client_id, platform_name,
       deployment_id, message_type, lti_version, token_jti, nonce, platform_launch_id,
       user_id, user_name, user_email, roles,
       context_id, context_title, resource_link_id, resource_link_title,
       course_id, module_id, lecture_id,
       ip_address, user_agent, id_token_claims
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8,$9,$10,$11,
       $12,$13,$14,$15,
       $16,$17,$18,$19,
       $20,$21,$22,
       $23,$24,$25
     ) RETURNING *`,
    [
      id,
      input.platformId,
      input.platformIssuer,
      input.platformClientId,
      input.platformName ?? null,
      input.deploymentId,
      input.messageType,
      input.ltiVersion,
      input.tokenJti ?? null,
      input.nonce,
      input.platformLaunchId ?? null,
      input.userId,
      input.userName ?? null,
      input.userEmail ?? null,
      JSON.stringify(input.roles),
      input.contextId ?? null,
      input.contextTitle ?? null,
      input.resourceLinkId ?? null,
      input.resourceLinkTitle ?? null,
      input.courseId ?? null,
      input.moduleId ?? null,
      input.lectureId ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      JSON.stringify(input.claims),
    ],
  );
  return row!;
}

export function getLaunch(id: string) {
  return queryOne<LaunchRow>(`SELECT * FROM lti_launches WHERE id = $1`, [id]);
}

/**
 * Opaque one-time handle used to hand a validated launch to the React app via
 * a redirect, instead of relying on a cross-site cookie.
 */
export async function createLaunchToken(launchId: string, purpose: 'player' | 'deep_link'): Promise<string> {
  const token = randomToken(24);
  await query(
    `INSERT INTO launch_tokens (token, launch_id, purpose, expires_at)
     VALUES ($1, $2, $3, now() + interval '5 minutes')`,
    [token, launchId, purpose],
  );
  return token;
}

export async function consumeLaunchToken(
  token: string,
  purpose: 'player' | 'deep_link',
): Promise<LaunchRow | null> {
  const row = await queryOne<{ launch_id: string }>(
    `UPDATE launch_tokens
        SET consumed_at = now()
      WHERE token = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING launch_id`,
    [token, purpose],
  );
  if (!row) return null;
  return getLaunch(row.launch_id);
}

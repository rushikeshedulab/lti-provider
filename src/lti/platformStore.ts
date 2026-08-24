import { query, queryOne } from '../db/pool.js';

export interface PlatformRegistration {
  id: number;
  name: string;
  issuer: string;
  client_id: string;
  deployment_ids: string[];
  auth_login_url: string;
  auth_token_url: string;
  jwks_url: string;
  tool_redirect_uri: string;
  is_active: boolean;
  created_via: string;
  status: string;
  notes: string | null;
  activated_deployments: ActivationMap;
  created_at: string;
  updated_at: string;
}

/**
 * One entry of `lti_platforms.activated_deployments`, keyed by deployment_id.
 * Kept on the registration row itself so a connection and its gate are always
 * read, written and deleted together.
 */
export interface DeploymentActivation {
  activated_at: string;
  user_id: string | null;
  email: string | null;
  name: string | null;
  launch_id: string | null;
  context_id: string | null;
  context_title: string | null;
  reported: boolean;
}

export type ActivationMap = Record<string, DeploymentActivation>;

export function findPlatform(issuer: string, clientId?: string | null) {
  if (clientId) {
    return queryOne<PlatformRegistration>(
      `SELECT * FROM lti_platforms WHERE issuer = $1 AND client_id = $2 AND is_active`,
      [issuer, clientId],
    );
  }
  return queryOne<PlatformRegistration>(
    `SELECT * FROM lti_platforms WHERE issuer = $1 AND is_active ORDER BY id LIMIT 1`,
    [issuer],
  );
}

/**
 * A client_id is generated to be unique by whichever LMS issued it, so it is
 * enough to identify a connection on its own. This is what lets an
 * administrator connect a new platform by pasting two ids and nothing else.
 */
export function findPlatformByClientId(clientId: string) {
  return queryOne<PlatformRegistration>(
    `SELECT * FROM lti_platforms WHERE client_id = $1 ORDER BY id LIMIT 1`,
    [clientId],
  );
}

export function findPlatformById(id: number) {
  return queryOne<PlatformRegistration>(`SELECT * FROM lti_platforms WHERE id = $1`, [id]);
}

export function listPlatforms() {
  return query<PlatformRegistration>(`SELECT * FROM lti_platforms ORDER BY id`);
}

/**
 * Every origin allowed to embed this tool in an iframe, derived from the
 * registrations themselves. Connecting a new LMS therefore does not require
 * editing ALLOWED_FRAME_ANCESTORS and restarting.
 */
export async function listPlatformOrigins(): Promise<string[]> {
  const rows = await query<{ issuer: string; auth_login_url: string }>(
    `SELECT issuer, auth_login_url FROM lti_platforms WHERE is_active`,
  );
  const origins = new Set<string>();
  for (const row of rows) {
    for (const candidate of [row.issuer, row.auth_login_url]) {
      try {
        origins.add(new URL(candidate).origin);
      } catch {
        /* some platforms use a bare identifier as `iss`; there is no origin to allow */
      }
    }
  }
  return [...origins];
}

export async function upsertPlatform(reg: {
  name: string;
  issuer: string;
  clientId: string;
  deploymentIds: string[];
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
  toolRedirectUri: string;
  createdVia?: string;
  notes?: string | null;
}): Promise<PlatformRegistration> {
  const row = await queryOne<PlatformRegistration>(
    `INSERT INTO lti_platforms
       (name, issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_url, tool_redirect_uri,
        created_via, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (issuer, client_id) DO UPDATE SET
       name = EXCLUDED.name,
       -- Deployments are additive: saving the connection again must not orphan
       -- a deployment_id that is already live for a course.
       deployment_ids = (
         SELECT array_agg(DISTINCT d ORDER BY d)
           FROM unnest(lti_platforms.deployment_ids || EXCLUDED.deployment_ids) AS d
       ),
       auth_login_url = EXCLUDED.auth_login_url,
       auth_token_url = EXCLUDED.auth_token_url,
       jwks_url = EXCLUDED.jwks_url,
       tool_redirect_uri = EXCLUDED.tool_redirect_uri,
       notes = EXCLUDED.notes,
       is_active = TRUE,
       updated_at = now()
     RETURNING *`,
    [
      reg.name,
      reg.issuer,
      reg.clientId,
      reg.deploymentIds,
      reg.authLoginUrl,
      reg.authTokenUrl,
      reg.jwksUrl,
      reg.toolRedirectUri,
      reg.createdVia ?? 'env',
      reg.notes ?? null,
    ],
  );
  return row!;
}

/** Adds one more deployment_id to an existing connection. */
export function addDeploymentId(platformId: number, deploymentId: string) {
  return queryOne<PlatformRegistration>(
    `UPDATE lti_platforms
        SET deployment_ids = (
              SELECT array_agg(DISTINCT d ORDER BY d)
                FROM unnest(deployment_ids || ARRAY[$2::text]) AS d
            ),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [platformId, deploymentId],
  );
}

/** Removes a deployment_id, and with it any activation recorded against it. */
export function removeDeploymentId(platformId: number, deploymentId: string) {
  return queryOne<PlatformRegistration>(
    `UPDATE lti_platforms
        SET deployment_ids        = array_remove(deployment_ids, $2::text),
            activated_deployments = activated_deployments - $2::text,
            status = CASE WHEN (activated_deployments - $2::text) = '{}'::jsonb THEN 'pending' ELSE 'active' END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [platformId, deploymentId],
  );
}

export function setPlatformActive(platformId: number, isActive: boolean) {
  return queryOne<PlatformRegistration>(
    `UPDATE lti_platforms SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [platformId, isActive],
  );
}

export function deletePlatform(platformId: number) {
  return queryOne<{ id: number }>(`DELETE FROM lti_platforms WHERE id = $1 RETURNING id`, [platformId]);
}

// ---------------------------------------------------------------------------
// DEPLOYMENT ACTIVATION - the instructor-first gate
//
// A deployment_id is inert until an Instructor or Administrator has launched it
// once. That launch is the only thing that proves both halves of the
// registration really agree, so students are turned away until it has happened.
// ---------------------------------------------------------------------------

export function activationsOf(platform: PlatformRegistration): ActivationMap {
  return platform.activated_deployments ?? {};
}

export function isDeploymentActivated(platform: PlatformRegistration, deploymentId: string): boolean {
  return Boolean(activationsOf(platform)[deploymentId]);
}

export async function getActivation(
  platformId: number,
  deploymentId: string,
): Promise<DeploymentActivation | null> {
  const row = await queryOne<{ activation: DeploymentActivation | null }>(
    `SELECT activated_deployments -> $2 AS activation FROM lti_platforms WHERE id = $1`,
    [platformId, deploymentId],
  );
  return row?.activation ?? null;
}

/**
 * Records the instructor launch that switches a deployment on, and flips the
 * connection itself to 'active'. Launching again as an instructor refreshes the
 * entry rather than adding a second one.
 */
export async function recordActivation(input: {
  platformId: number;
  deploymentId: string;
  userId: string;
  email?: string | null;
  name?: string | null;
  launchId?: string | null;
  contextId?: string | null;
  contextTitle?: string | null;
}): Promise<PlatformRegistration> {
  const entry: DeploymentActivation = {
    activated_at: new Date().toISOString(),
    user_id: input.userId,
    email: input.email ?? null,
    name: input.name ?? null,
    launch_id: input.launchId ?? null,
    context_id: input.contextId ?? null,
    context_title: input.contextTitle ?? null,
    reported: false,
  };

  const row = await queryOne<PlatformRegistration>(
    `UPDATE lti_platforms
        SET activated_deployments = activated_deployments || jsonb_build_object($2::text, $3::jsonb),
            status = 'active',
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [input.platformId, input.deploymentId, JSON.stringify(entry)],
  );
  return row!;
}

/** Notes that the platform was told about the activation over a service call. */
export function markActivationReported(platformId: number, deploymentId: string) {
  return query(
    `UPDATE lti_platforms
        SET activated_deployments =
              jsonb_set(activated_deployments, ARRAY[$2::text, 'reported'], 'true'::jsonb, false)
      WHERE id = $1 AND activated_deployments ? $2::text`,
    [platformId, deploymentId],
  );
}

/** Undo an activation, so the next instructor launch has to set it up again. */
export function clearActivation(platformId: number, deploymentId: string) {
  return queryOne<PlatformRegistration>(
    `UPDATE lti_platforms
        SET activated_deployments = activated_deployments - $2::text,
            status = CASE WHEN (activated_deployments - $2::text) = '{}'::jsonb THEN 'pending' ELSE 'active' END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [platformId, deploymentId],
  );
}

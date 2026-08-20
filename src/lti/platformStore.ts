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
}

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

export function findPlatformById(id: number) {
  return queryOne<PlatformRegistration>(`SELECT * FROM lti_platforms WHERE id = $1`, [id]);
}

export function listPlatforms() {
  return query<PlatformRegistration>(`SELECT * FROM lti_platforms ORDER BY id`);
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
}): Promise<PlatformRegistration> {
  const row = await queryOne<PlatformRegistration>(
    `INSERT INTO lti_platforms
       (name, issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_url, tool_redirect_uri)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (issuer, client_id) DO UPDATE SET
       name = EXCLUDED.name,
       deployment_ids = EXCLUDED.deployment_ids,
       auth_login_url = EXCLUDED.auth_login_url,
       auth_token_url = EXCLUDED.auth_token_url,
       jwks_url = EXCLUDED.jwks_url,
       tool_redirect_uri = EXCLUDED.tool_redirect_uri,
       is_active = TRUE
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
    ],
  );
  return row!;
}

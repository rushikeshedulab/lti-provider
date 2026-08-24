import { Router, type NextFunction, type Request, type Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env, toolEndpoints } from '../config/env.js';
import { query } from '../db/pool.js';
import {
  addDeploymentId,
  clearActivation,
  deletePlatform,
  findPlatformByClientId,
  findPlatformById,
  listPlatforms,
  removeDeploymentId,
  setPlatformActive,
  upsertPlatform,
  type PlatformRegistration,
} from '../lti/platformStore.js';
import { discoverPlatform, DiscoveryError, probeJwks } from '../services/platformDiscovery.js';
import { toolRegistrationDocument } from '../config/registration.js';
import { getLaunch } from '../services/launchStore.js';
import { adminContentRouter } from './adminContent.routes.js';

export const adminRouter = Router();

const adminSecret = new TextEncoder().encode(env.contentSessionSecret + ':admin');

adminRouter.post('/login', async (req, res) => {
  const password = String(req.body?.password ?? '');
  if (password !== env.adminPassword) {
    res.status(401).json({ error: 'invalid_password' });
    return;
  }
  const token = await new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('provider-admin')
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(adminSecret);
  res.json({ token });
});

async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: 'unauthorised' });
    return;
  }
  try {
    await jwtVerify(token, adminSecret, { audience: 'provider-admin', algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'unauthorised' });
  }
}

adminRouter.use(requireAdmin);

// Content management: create/upload everything students will see.
adminRouter.use('/content', adminContentRouter);

/**
 * The activity feed shown on the dashboard. CONTENT_VIEW_* rows are joined to
 * their viewing session so start/end/duration land on a single line.
 */
adminRouter.get('/activity', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
  const event = req.query.event ? String(req.query.event) : null;
  const email = req.query.email ? String(req.query.email) : null;

  const rows = await query(
    `SELECT a.id,
            a.event_type,
            a.occurred_at,
            a.user_id, a.user_email, a.user_name,
            a.platform_issuer, a.platform_client_id, a.platform_name, a.deployment_id,
            a.course_id, a.course_name, a.module_id, a.module_name,
            a.lecture_id, a.lecture_name,
            a.launch_id, a.viewing_session_id, a.session_id,
            a.ip_address, a.user_agent, a.metadata,
            v.started_at        AS session_started_at,
            v.ended_at          AS session_ended_at,
            v.presence_seconds  AS session_presence_seconds,
            v.watched_seconds   AS session_watched_seconds,
            v.end_reason        AS session_end_reason
       FROM content_activity_logs a
       LEFT JOIN viewing_sessions v ON v.id = a.viewing_session_id
      WHERE ($1::text IS NULL OR a.event_type = $1)
        AND ($2::text IS NULL OR a.user_email ILIKE '%' || $2 || '%')
      ORDER BY a.occurred_at DESC
      LIMIT $3`,
    [event, email, limit],
  );
  res.json({ rows });
});

/** One row per viewing session - the "how long did they watch" view. */
adminRouter.get('/sessions', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
  const rows = await query(
    `SELECT v.*,
            c.title AS course_name,
            m.title AS module_name,
            l.title AS lecture_name,
            lp.platform_client_id,
            lp.platform_name
       FROM viewing_sessions v
       LEFT JOIN courses  c ON c.id = v.course_id
       LEFT JOIN modules  m ON m.id = v.module_id
       LEFT JOIN lectures l ON l.id = v.lecture_id
       LEFT JOIN lti_launches lp ON lp.id = v.launch_id
      ORDER BY v.started_at DESC
      LIMIT $1`,
    [limit],
  );
  res.json({ rows });
});

/** Headline numbers + per-student totals for the dashboard summary strip. */
adminRouter.get('/summary', async (_req, res) => {
  const [totals] = await query<{
    launches: string;
    sessions: string;
    open_sessions: string;
    total_presence_seconds: string;
    total_watched_seconds: string;
    distinct_students: string;
    distinct_platforms: string;
  }>(
    `SELECT (SELECT count(*) FROM lti_launches)                              AS launches,
            (SELECT count(*) FROM viewing_sessions)                          AS sessions,
            (SELECT count(*) FROM viewing_sessions WHERE ended_at IS NULL)   AS open_sessions,
            (SELECT COALESCE(sum(presence_seconds),0) FROM viewing_sessions) AS total_presence_seconds,
            (SELECT COALESCE(sum(watched_seconds),0)  FROM viewing_sessions) AS total_watched_seconds,
            (SELECT count(DISTINCT user_id) FROM lti_launches)               AS distinct_students,
            (SELECT count(DISTINCT platform_issuer) FROM lti_launches)       AS distinct_platforms`,
  );

  const perStudent = await query(
    `SELECT v.user_email,
            v.user_name,
            count(*)                          AS sessions,
            COALESCE(sum(v.presence_seconds),0) AS presence_seconds,
            COALESCE(sum(v.watched_seconds),0)  AS watched_seconds,
            max(v.started_at)                 AS last_seen
       FROM viewing_sessions v
      GROUP BY v.user_email, v.user_name
      ORDER BY max(v.started_at) DESC`,
  );

  const perLecture = await query(
    `SELECT l.id, l.title, m.title AS module_title,
            count(v.id)                         AS sessions,
            COALESCE(sum(v.watched_seconds),0)  AS watched_seconds
       FROM lectures l
       JOIN modules m ON m.id = l.module_id
       LEFT JOIN viewing_sessions v ON v.lecture_id = l.id
      GROUP BY l.id, l.title, m.title, m.position, l.position
      ORDER BY m.position, l.position`,
  );

  res.json({ totals, perStudent, perLecture });
});

/** The full decoded id_token of one launch - useful when demonstrating the flow. */
adminRouter.get('/launches/:id', async (req, res) => {
  const launch = await getLaunch(String(req.params.id));
  if (!launch) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ launch });
});

/** Registration details, so the demo can show both halves of the trust setup. */
adminRouter.get('/registrations', async (_req, res) => {
  res.json({
    tool: { ...toolRegistrationDocument, endpoints: toolEndpoints, key_id: env.keyId },
    platforms: await listPlatforms(),
  });
});

// ===========================================================================
// PLATFORM CONNECTIONS
//
// Connecting a new LMS is a two-field job: its administrator generates a
// client_id and a deployment_id, and they get pasted in here. Everything else
// about the platform is discovered from the URL it lives at, so no environment
// variable changes and no restart are involved.
//
// A saved connection is 'pending' until an Instructor completes one launch
// through it. Students are refused until that has happened - see
// routes/lti.routes.ts, which is where the gate is actually enforced.
// ===========================================================================

/** Shape sent to the admin UI: the registration plus its per-deployment gate. */
function connectionView(platform: PlatformRegistration) {
  const activations = platform.activated_deployments ?? {};
  return {
    id: platform.id,
    name: platform.name,
    issuer: platform.issuer,
    clientId: platform.client_id,
    authLoginUrl: platform.auth_login_url,
    authTokenUrl: platform.auth_token_url,
    jwksUrl: platform.jwks_url,
    toolRedirectUri: platform.tool_redirect_uri,
    isActive: platform.is_active,
    createdVia: platform.created_via,
    status: platform.status,
    notes: platform.notes,
    createdAt: platform.created_at,
    updatedAt: platform.updated_at,
    deployments: platform.deployment_ids.map((deploymentId) => {
      const activation = activations[deploymentId];
      return {
        deploymentId,
        activated: Boolean(activation),
        activatedAt: activation?.activated_at ?? null,
        activatedBy: activation?.name ?? activation?.email ?? null,
        activatedByEmail: activation?.email ?? null,
        contextTitle: activation?.context_title ?? null,
        reportedToPlatform: activation?.reported ?? false,
      };
    }),
  };
}

adminRouter.get('/connections', async (_req, res) => {
  const platforms = await listPlatforms();
  res.json({
    connections: platforms.map(connectionView),
    // Everything the LMS administrator needs from us, to paste the other way.
    tool: { ...toolRegistrationDocument, endpoints: toolEndpoints, key_id: env.keyId },
  });
});

/**
 * Reads the platform's own discovery document so the administrator does not
 * have to know its issuer or endpoint URLs. Purely a form-filling aid: nothing
 * is saved, and every launch is still verified against the JWKS at launch time.
 */
adminRouter.post('/connections/discover', async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  try {
    const discovered = await discoverPlatform(url);
    const jwks = await probeJwks(discovered.jwksUrl);
    res.json({ discovered, jwks });
  } catch (err) {
    if (err instanceof DiscoveryError) {
      res.status(400).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Saves a connection. `clientId` and `deploymentId` are the only two values an
 * administrator must supply; the endpoints are discovered from `url` unless
 * they are overridden explicitly in the request.
 */
adminRouter.post('/connections', async (req, res) => {
  const body = req.body ?? {};
  const clientId = String(body.clientId ?? '').trim();
  const deploymentId = String(body.deploymentId ?? '').trim();
  const url = String(body.url ?? '').trim();

  if (!clientId || !deploymentId) {
    res.status(400).json({
      error: 'missing_ids',
      message: 'Both client_id and deployment_id are required - they come from the LMS administrator.',
    });
    return;
  }

  // A client_id must identify exactly one platform, otherwise a launch that
  // arrives with only `azp` set could not be resolved to a registration.
  const clash = await findPlatformByClientId(clientId);

  let issuer = String(body.issuer ?? '').trim();
  let authLoginUrl = String(body.authLoginUrl ?? '').trim();
  let authTokenUrl = String(body.authTokenUrl ?? '').trim();
  let jwksUrl = String(body.jwksUrl ?? '').trim();
  let name = String(body.name ?? '').trim();
  let discoverySource: string | null = null;
  let discoveryWarning: string | null = null;

  const needsDiscovery = !issuer || !authLoginUrl || !authTokenUrl || !jwksUrl;
  if (needsDiscovery) {
    if (!url) {
      res.status(400).json({
        error: 'missing_url',
        message: 'Supply the LMS address so its endpoints can be discovered, or fill in all four URLs by hand.',
      });
      return;
    }
    try {
      const discovered = await discoverPlatform(url);
      issuer ||= discovered.issuer;
      authLoginUrl ||= discovered.authLoginUrl;
      authTokenUrl ||= discovered.authTokenUrl;
      jwksUrl ||= discovered.jwksUrl;
      name ||= discovered.name ?? new URL(discovered.issuer).host;
      discoverySource = discovered.source;
      discoveryWarning = discovered.warning;
    } catch (err) {
      if (err instanceof DiscoveryError) {
        res.status(400).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  }

  if (clash && clash.issuer !== issuer) {
    res.status(409).json({
      error: 'client_id_in_use',
      message: `client_id "${clientId}" is already registered for issuer "${clash.issuer}". Ask the LMS to generate a different one.`,
    });
    return;
  }

  // Fail here rather than at the first launch: a registration whose key set
  // cannot be read would accept the ids and then reject every launch with an
  // opaque signature error.
  const jwks = await probeJwks(jwksUrl);
  if (!jwks.ok && body.ignoreJwksCheck !== true) {
    res.status(400).json({
      error: 'jwks_unreachable',
      message: `${jwks.error} Check the LMS address, or save again with "ignore key check" if it is not reachable yet.`,
    });
    return;
  }

  const platform = await upsertPlatform({
    name: name || issuer,
    issuer,
    clientId,
    deploymentIds: [deploymentId],
    authLoginUrl,
    authTokenUrl,
    jwksUrl,
    toolRedirectUri: toolEndpoints.redirectUri,
    createdVia: 'admin',
    notes: body.notes ? String(body.notes) : null,
  });

  console.log(
    `[admin] connection saved: ${platform.issuer} client_id=${platform.client_id} ` +
      `deployment_ids=${platform.deployment_ids.join(',')}`,
  );

  res.status(201).json({
    connection: connectionView(platform),
    discovery: { source: discoverySource, warning: discoveryWarning },
    jwks,
  });
});

/** Adds a second (third, ...) deployment_id to a connection that already exists. */
adminRouter.post('/connections/:id/deployments', async (req, res) => {
  const deploymentId = String(req.body?.deploymentId ?? '').trim();
  if (!deploymentId) {
    res.status(400).json({ error: 'missing_deployment_id' });
    return;
  }
  const platform = await addDeploymentId(Number(req.params.id), deploymentId);
  if (!platform) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  res.json({ connection: connectionView(platform) });
});

adminRouter.delete('/connections/:id/deployments/:deploymentId', async (req, res) => {
  const platform = await findPlatformById(Number(req.params.id));
  if (!platform) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  if (platform.deployment_ids.length <= 1) {
    res.status(409).json({
      error: 'last_deployment',
      message: 'A connection needs at least one deployment_id. Delete the whole connection instead.',
    });
    return;
  }
  const updated = await removeDeploymentId(platform.id, String(req.params.deploymentId));
  res.json({ connection: connectionView(updated!) });
});

/**
 * Puts a deployment back behind the gate. The next launch must then be an
 * Instructor again - useful when a course is handed to a new teacher, or to
 * demonstrate the gate without recreating the connection.
 */
adminRouter.post('/connections/:id/reset-activation', async (req, res) => {
  const deploymentId = String(req.body?.deploymentId ?? '').trim();
  if (!deploymentId) {
    res.status(400).json({ error: 'missing_deployment_id' });
    return;
  }
  const platform = await clearActivation(Number(req.params.id), deploymentId);
  if (!platform) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  console.log(`[admin] activation reset for deployment ${deploymentId} on platform ${platform.id}`);
  res.json({ connection: connectionView(platform) });
});

/** Suspends or resumes a connection without losing its activation history. */
adminRouter.patch('/connections/:id', async (req, res) => {
  const isActive = Boolean(req.body?.isActive);
  const platform = await setPlatformActive(Number(req.params.id), isActive);
  if (!platform) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  res.json({ connection: connectionView(platform) });
});

/** Re-checks that the platform still publishes a readable key set. */
adminRouter.post('/connections/:id/test', async (req, res) => {
  const platform = await findPlatformById(Number(req.params.id));
  if (!platform) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  res.json({ jwks: await probeJwks(platform.jwks_url) });
});

adminRouter.delete('/connections/:id', async (req, res) => {
  const platformId = Number(req.params.id);

  /**
   * Launches reference the connection they arrived through, and that history is
   * the activity log this whole tool exists to produce. Deleting the connection
   * would either destroy it or fail on the foreign key, so a connection that has
   * ever been used is suspended instead - which already refuses new launches.
   */
  const [used] = await query<{ launches: string }>(
    `SELECT count(*) AS launches FROM lti_launches WHERE platform_id = $1`,
    [platformId],
  );
  if (Number(used?.launches ?? 0) > 0) {
    res.status(409).json({
      error: 'connection_in_use',
      message:
        `This connection has ${used!.launches} recorded launch(es), which the activity log still refers to. ` +
        `Suspend it instead - that refuses every new launch and keeps the history.`,
    });
    return;
  }

  const removed = await deletePlatform(platformId);
  if (!removed) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  console.log(`[admin] connection ${removed.id} deleted`);
  res.json({ ok: true, id: removed.id });
});


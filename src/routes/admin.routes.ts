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
import {
  diagnoseConnection,
  discoverPlatform,
  DiscoveryError,
  probeJwks,
  validateEndpoints,
} from '../services/platformDiscovery.js';
import { invalidatePlatformEndpoints, resolvePlatformEndpoints } from '../services/platformEndpoints.js';
import { fetchJsonDocument } from '../services/httpProbe.js';
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
// A saved connection is usable immediately. 'pending' simply means no launch
// has arrived through it yet; it turns 'active' the first time one does, which
// is how you tell a working connection from a merely saved one.
// ===========================================================================

/** Shape sent to the admin UI: the registration plus per-deployment usage. */
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
    // Where these endpoints came from and how current they are. Without this the
    // resolver is invisible and a connection looks static even when it is not.
    discoveryUrl: platform.discovery_url,
    discoverySource: platform.discovery_source,
    discoveryFetchedAt: platform.discovery_fetched_at,
    discoveryError: platform.discovery_error,
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
    // Nothing was found, so there is no key set to probe. Saying so is the whole
    // point: the form leaves its endpoint fields empty rather than filling them
    // with a layout borrowed from some other LMS.
    const jwks = discovered.jwksUrl
      ? await probeJwks(discovered.jwksUrl)
      : { ok: false, keys: 0, error: 'No JWKS URL was discovered.' };
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

  const trimmed = (value: unknown) => String(value ?? '').trim();
  let issuer = trimmed(body.issuer);
  let authLoginUrl = trimmed(body.authLoginUrl);
  let authTokenUrl = trimmed(body.authTokenUrl);
  let jwksUrl = trimmed(body.jwksUrl);
  let discoveryUrl = trimmed(body.discoveryUrl);
  let name = trimmed(body.name);
  let discoverySource: string | null = null;
  let discoveryWarning: string | null = null;
  let discoveryAttempts: unknown[] = [];

  // `authTokenUrl` is deliberately not part of this test: a platform may publish
  // no token endpoint at all (only LTI Advantage service calls need one), and
  // demanding it would send us discovering over a connection already fully
  // specified by hand.
  const needsDiscovery = !issuer || !authLoginUrl || !jwksUrl;
  const typedByHand = !needsDiscovery && !url;

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

      // Nothing usable is published - and this is exactly where a guess used to
      // be substituted. A guessed endpoint answers HTTP 200 on any LMS whose
      // front-end serves index.html for unknown paths, so it passed every check
      // and failed much later, as a launch redirecting into a path that does not
      // exist. Refusing here, with the evidence, is the fix.
      if (discovered.source === 'none') {
        res.status(400).json({
          error: 'discovery_failed',
          message: discovered.warning,
          attempts: discovered.attempts,
        });
        return;
      }

      issuer ||= discovered.issuer ?? '';
      authLoginUrl ||= discovered.authLoginUrl ?? '';
      authTokenUrl ||= discovered.authTokenUrl ?? '';
      jwksUrl ||= discovered.jwksUrl ?? '';
      discoveryUrl ||= discovered.discoveryUrl ?? '';
      name ||= discovered.name ?? (discovered.issuer ? new URL(discovered.issuer).host : url);
      discoverySource = discovered.source;
      discoveryWarning = discovered.warning;
      discoveryAttempts = discovered.attempts;
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

  // Fail here rather than at the first launch. A registration whose key set
  // cannot be read accepts the ids and then rejects every launch with an opaque
  // signature error; one whose authorization endpoint is really the LMS's
  // front-end redirects the browser to a page that is not an LTI endpoint at all.
  const validation = await validateEndpoints({
    issuer,
    authLoginUrl,
    authTokenUrl: authTokenUrl || null,
    jwksUrl,
  });

  // What used to be here was `ignoreJwksCheck`, and it was the ONLY route by
  // which unverifiable endpoints ever reached the database - with its own error
  // message advertising it. `saveSuspended` is the honest version of the same
  // need ("the LMS is not deployed yet"): the connection is stored and stays
  // suspended, instead of being stored and looking like it works.
  const saveSuspended = body.saveSuspended === true && typedByHand;
  if (!validation.ok && !saveSuspended) {
    res.status(400).json({
      error: 'endpoints_unvalidated',
      message: validation.failures.map((f) => f.message).join(' '),
      validation,
      ...(typedByHand
        ? { hint: 'If the LMS is not reachable yet, save it suspended and resume the connection later.' }
        : {}),
    });
    return;
  }

  const platform = await upsertPlatform({
    name: name || issuer,
    issuer,
    clientId,
    deploymentIds: [deploymentId],
    authLoginUrl,
    authTokenUrl: authTokenUrl || null,
    jwksUrl,
    toolRedirectUri: toolEndpoints.redirectUri,
    createdVia: 'admin',
    notes: body.notes ? String(body.notes) : null,
    discoveryUrl: discoveryUrl || null,
    discoverySource,
    isActive: !saveSuspended,
  });
  invalidatePlatformEndpoints(platform.id);

  console.log(
    `[admin] connection saved: ${platform.issuer} client_id=${platform.client_id} ` +
      `deployment_ids=${platform.deployment_ids.join(',')}` +
      `${discoveryUrl ? ` discovery=${discoveryUrl}` : ''}${saveSuspended ? ' (suspended)' : ''}`,
  );

  res.status(201).json({
    connection: connectionView(platform),
    discovery: { source: discoverySource, warning: discoveryWarning, attempts: discoveryAttempts },
    validation,
    jwks: validation.jwks,
    ...(saveSuspended
      ? { notice: 'Saved, but suspended: its endpoints could not be verified. Resume it once the LMS is reachable.' }
      : {}),
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
 * Forgets that a deployment has been launched. Nothing is blocked either way -
 * it just clears the "first seen" record so a fresh test reads cleanly.
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
  console.log(`[admin] cleared the first-use record for deployment ${deploymentId} on platform ${platform.id}`);
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

/**
 * Checks a saved connection against the live platform: are the endpoints real,
 * is the key set readable, and does the issuer still match what the platform
 * publishes. Answers the question "is my config wrong, or is the LMS simply
 * asking the user to sign in".
 */
adminRouter.post('/connections/:id/test', async (req, res) => {
  const platform = await findPlatformById(Number(req.params.id));
  if (!platform) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  // Force a re-read first, so the test reports on the endpoints a launch would
  // actually use rather than on whatever was cached. This is the one caller
  // allowed to wait for the network: a human asked for it.
  const resolved = await resolvePlatformEndpoints(platform, { force: true });

  const diagnosis = await diagnoseConnection({
    issuer: platform.issuer,
    authLoginUrl: resolved.authLoginUrl,
    authTokenUrl: resolved.authTokenUrl,
    jwksUrl: resolved.jwksUrl,
    discoveryUrl: platform.discovery_url,
  });
  res.json({ diagnosis, jwks: diagnosis.jwks, resolved });
});

/** Corrects the endpoints of an existing connection without recreating it. */
adminRouter.patch('/connections/:id/endpoints', async (req, res) => {
  const platform = await findPlatformById(Number(req.params.id));
  if (!platform) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  const body = req.body ?? {};
  // Merge over what is stored, then validate the WHOLE set. A body naming only
  // one field still has to stand up alongside the three siblings it is keeping -
  // otherwise correcting the JWKS URL silently blesses a stale authorization URL.
  const next = {
    name: String(body.name ?? platform.name).trim() || platform.name,
    issuer: String(body.issuer ?? platform.issuer).trim(),
    clientId: platform.client_id,
    deploymentIds: platform.deployment_ids,
    authLoginUrl: String(body.authLoginUrl ?? platform.auth_login_url).trim(),
    authTokenUrl: String(body.authTokenUrl ?? platform.auth_token_url ?? '').trim() || null,
    jwksUrl: String(body.jwksUrl ?? platform.jwks_url).trim(),
    toolRedirectUri: toolEndpoints.redirectUri,
    createdVia: platform.created_via,
    notes: platform.notes,
    // Clearing this to empty means "these are hand-typed, stop re-reading them".
    discoveryUrl: String(body.discoveryUrl ?? platform.discovery_url ?? '').trim() || null,
    discoverySource: platform.discovery_source,
    isActive: platform.is_active,
  };

  // A discovery URL that does not resolve to a document would silently disable
  // refreshing while looking enabled, so it is checked before it is stored.
  if (next.discoveryUrl && next.discoveryUrl !== platform.discovery_url) {
    const doc = await fetchJsonDocument(next.discoveryUrl);
    if (!doc.ok) {
      res.status(400).json({ error: 'discovery_url_invalid', message: doc.detail });
      return;
    }
  }

  const validation = await validateEndpoints(next);
  if (!validation.ok) {
    res.status(400).json({
      error: 'endpoints_unvalidated',
      message: validation.failures.map((f) => f.message).join(' '),
      validation,
    });
    return;
  }

  // The issuer is part of the row's identity, so changing it cannot be an
  // upsert - it would leave the old row behind and match neither.
  if (next.issuer !== platform.issuer) {
    try {
      await query(`UPDATE lti_platforms SET issuer = $2, updated_at = now() WHERE id = $1`, [platform.id, next.issuer]);
    } catch (err) {
      // (issuer, client_id) is unique, so moving this row onto an issuer that
      // already has a registration for the same client_id is a conflict, not a
      // server error.
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({
          error: 'issuer_in_use',
          message: `A connection for issuer "${next.issuer}" with client_id "${platform.client_id}" already exists.`,
        });
        return;
      }
      throw err;
    }
  }
  const updated = await upsertPlatform(next);
  // Otherwise the correction is ignored until the cached entry expires.
  invalidatePlatformEndpoints(updated.id);

  console.log(`[admin] connection ${updated.id} endpoints updated (issuer=${updated.issuer})`);
  res.json({ connection: connectionView(updated), validation });
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


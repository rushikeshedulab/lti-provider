import { Router, type NextFunction, type Request, type Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env, toolEndpoints } from '../config/env.js';
import { query } from '../db/pool.js';
import { listPlatforms } from '../lti/platformStore.js';
import { toolRegistrationDocument } from '../config/registration.js';
import { getLaunch } from '../services/launchStore.js';

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

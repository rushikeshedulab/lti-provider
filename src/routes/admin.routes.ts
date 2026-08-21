import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env, toolEndpoints } from '../config/env.js';
import { query } from '../db/pool.js';
import { listPlatforms } from '../lti/platformStore.js';
import { toolRegistrationDocument } from '../config/registration.js';
import { getLaunch } from '../services/launchStore.js';
import {
  createCourse,
  createLecture,
  createModule,
  deleteLecture,
  getCourseCatalog,
  isSelfHosted,
  listLecturesForAuthoring,
  type ContentType,
} from '../content/repository.js';
import {
  acceptedUploadTypes,
  classifyUpload,
  deleteMediaFile,
  MEDIA_DIR,
  safeMediaName,
  saveUploadStream,
  UploadError,
} from '../content/uploads.js';

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

// ---------------------------------------------------------------------------
// CONTENT AUTHORING
// Everything below creates or removes the provider's own content. It is behind
// requireAdmin like the rest of this router, and it has no LTI surface at all -
// the consumer only ever sees a lecture that an instructor picked through Deep
// Linking, and only ever as an id plus a title.
// ---------------------------------------------------------------------------

/** Courses, modules and every lecture with its file details. */
adminRouter.get('/content/catalog', async (_req, res) => {
  const [catalog, lectures] = await Promise.all([getCourseCatalog(), listLecturesForAuthoring()]);
  res.json({
    catalog,
    lectures: lectures.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      contentType: l.content_type,
      contentUrl: l.content_url,
      selfHosted: isSelfHosted(l.content_url),
      posterUrl: l.poster_url,
      durationSeconds: l.duration_seconds,
      moduleId: l.module_id,
      moduleTitle: l.module_title,
      courseId: l.course_id,
      courseTitle: l.course_title,
    })),
    limits: { maxUploadMb: env.maxUploadMb, acceptedTypes: acceptedUploadTypes() },
  });
});

/**
 * Raw-body upload. The browser sends the File itself as the request body with
 * `content-type: application/octet-stream`, which the app-level JSON and
 * urlencoded parsers both ignore, so `req` is still an unread stream here and
 * goes straight to disk. The original filename rides along as a query
 * parameter because a stream has nowhere else to put it.
 *
 * This only puts bytes on disk. The lecture row is a separate call, so a file
 * that is uploaded but never described stays invisible to every launch.
 */
adminRouter.post('/content/upload', async (req, res) => {
  const originalName = String(req.query.filename ?? '').trim();
  if (!originalName) {
    res.status(400).json({ error: 'missing_filename', message: 'A ?filename= query parameter is required.' });
    return;
  }

  try {
    const { contentType, mimeType, extension } = classifyUpload(originalName);
    const filename = safeMediaName(originalName, extension);
    const { path, bytes } = await saveUploadStream(req, filename);

    console.log(`[admin] uploaded ${path} (${contentType}, ${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    res.status(201).json({ path, bytes, contentType, mimeType, filename, originalName });
  } catch (err) {
    if (err instanceof UploadError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
});

/** Discards an uploaded file that never became a lecture. */
adminRouter.delete('/content/upload', async (req, res) => {
  const path = String(req.body?.path ?? '');
  if (!path.startsWith('/media/')) {
    res.status(400).json({ error: 'not_a_provider_file' });
    return;
  }
  const inUse = await query(`SELECT 1 FROM lectures WHERE content_url = $1 OR poster_url = $1`, [path]);
  if (inUse.length > 0) {
    res.status(409).json({ error: 'file_in_use', message: 'A lecture still points at this file.' });
    return;
  }
  await deleteMediaFile(path);
  res.json({ ok: true });
});

adminRouter.post('/content/courses', async (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  if (!title) {
    res.status(400).json({ error: 'missing_title' });
    return;
  }
  res.status(201).json({ course: await createCourse({ title, description: String(req.body?.description ?? '') }) });
});

adminRouter.post('/content/modules', async (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  const courseId = String(req.body?.courseId ?? '').trim();
  if (!title || !courseId) {
    res.status(400).json({ error: 'missing_fields', message: 'courseId and title are required.' });
    return;
  }
  const module = await createModule({ courseId, title });
  if (!module) {
    res.status(404).json({ error: 'unknown_course' });
    return;
  }
  res.status(201).json({ module });
});

/**
 * Turns an uploaded file (or an external URL) into a launchable lecture. From
 * this point the lecture appears in the Deep Linking picker, and its id is what
 * will come back on every future LtiResourceLinkRequest as `custom.lecture_id`.
 */
adminRouter.post('/content/lectures', async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title ?? '').trim();
  const moduleId = String(body.moduleId ?? '').trim();
  const contentUrl = String(body.contentUrl ?? '').trim();

  if (!title || !moduleId || !contentUrl) {
    res.status(400).json({ error: 'missing_fields', message: 'moduleId, title and contentUrl are required.' });
    return;
  }

  // Self-hosted files were classified at upload time; an external URL is
  // classified by its extension, and falls back to whatever the caller chose.
  let contentType = String(body.contentType ?? '') as ContentType;
  if (!['video', 'audio', 'pdf', 'image'].includes(contentType)) {
    res.status(400).json({ error: 'bad_content_type', message: 'contentType must be video, audio, pdf or image.' });
    return;
  }

  if (isSelfHosted(contentUrl)) {
    const onDisk = existsSync(join(MEDIA_DIR, basename(contentUrl)));
    if (!onDisk) {
      res.status(400).json({ error: 'file_missing', message: `No uploaded file at ${contentUrl}.` });
      return;
    }
  } else if (!/^https?:\/\//i.test(contentUrl)) {
    res.status(400).json({ error: 'bad_content_url', message: 'contentUrl must be an uploaded /media path or an http(s) URL.' });
    return;
  }

  const lecture = await createLecture({
    moduleId,
    title,
    description: String(body.description ?? ''),
    contentType,
    contentUrl,
    posterUrl: body.posterUrl ? String(body.posterUrl) : null,
    durationSeconds: Number(body.durationSeconds) || 0,
  });

  if (!lecture) {
    res.status(404).json({ error: 'unknown_module' });
    return;
  }

  console.log(`[admin] created lecture ${lecture.id} (${lecture.content_type}) in module ${moduleId}`);
  res.status(201).json({ lecture });
});

/**
 * Removes the lecture and, if the file was provider-hosted, the bytes with it.
 * A poster shared with another lecture is kept.
 */
adminRouter.delete('/content/lectures/:id', async (req, res) => {
  const removed = await deleteLecture(String(req.params.id));
  if (!removed) {
    res.status(404).json({ error: 'unknown_lecture' });
    return;
  }

  const stillUsed = async (path: string | null) =>
    !path ? true : (await query(`SELECT 1 FROM lectures WHERE content_url = $1 OR poster_url = $1`, [path])).length > 0;

  if (!(await stillUsed(removed.content_url))) await deleteMediaFile(removed.content_url);
  if (!(await stillUsed(removed.poster_url))) await deleteMediaFile(removed.poster_url);

  console.log(`[admin] deleted lecture ${removed.id}`);
  res.json({ ok: true, id: removed.id });
});

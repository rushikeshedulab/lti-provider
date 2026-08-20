import { Router } from 'express';
import { requireContentSession } from '../middleware/requireContentSession.js';
import { getLecture } from '../content/repository.js';
import { getLaunch } from '../services/launchStore.js';
import { endViewingSession, heartbeat, startViewingSession } from '../services/viewingSession.js';
import { reportViewingSummary } from '../services/platformService.js';
import { clientIp } from '../utils/http.js';

export const activityRouter = Router();

activityRouter.use(requireContentSession);

/**
 * CONTENT_VIEW_STARTED - called when the provider's player mounts inside the
 * consumer's iframe. This is provider-side instrumentation, not an LTI message:
 * the LTI protocol has no concept of "started watching".
 */
activityRouter.post('/view-start', async (req, res) => {
  const session = req.contentSession!;
  const launch = await getLaunch(session.launchId);
  const lecture = await getLecture(session.lectureId);
  if (!launch || !lecture) {
    res.status(404).json({ error: 'launch_or_lecture_not_found' });
    return;
  }

  const row = await startViewingSession({
    launchId: launch.id,
    platformIssuer: launch.platform_issuer,
    platformClientId: launch.platform_client_id,
    platformName: launch.platform_name,
    deploymentId: launch.deployment_id,
    userId: launch.user_id,
    userEmail: launch.user_email,
    userName: launch.user_name,
    courseId: lecture.course_id,
    courseName: lecture.course_title,
    moduleId: lecture.module_id,
    moduleName: lecture.module_title,
    lectureId: lecture.id,
    lectureName: lecture.title,
    ipAddress: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
  });

  res.json({ viewingSessionId: row.id, startedAt: row.started_at });
});

/** Keeps the session alive and carries the player's measured playback progress. */
activityRouter.post('/heartbeat', async (req, res) => {
  const { viewingSessionId, watchedSeconds = 0, positionSeconds = 0 } = req.body ?? {};
  if (!viewingSessionId) {
    res.status(400).json({ error: 'missing_viewing_session_id' });
    return;
  }
  const row = await heartbeat(String(viewingSessionId), {
    watchedSeconds: Number(watchedSeconds) || 0,
    positionSeconds: Number(positionSeconds) || 0,
  });
  if (!row) {
    res.status(409).json({ error: 'session_closed', message: 'This viewing session has already ended' });
    return;
  }
  res.json({
    ok: true,
    presenceSeconds: row.presence_seconds,
    watchedSeconds: row.watched_seconds,
  });
});

/** CONTENT_VIEW_ENDED - sent on unload via navigator.sendBeacon, or explicitly. */
activityRouter.post('/view-end', async (req, res) => {
  const { viewingSessionId, watchedSeconds = 0, positionSeconds = 0, reason = 'unload' } = req.body ?? {};
  if (!viewingSessionId) {
    res.status(400).json({ error: 'missing_viewing_session_id' });
    return;
  }
  const row = await endViewingSession(String(viewingSessionId), String(reason), {
    watchedSeconds: Number(watchedSeconds) || 0,
    positionSeconds: Number(positionSeconds) || 0,
  });
  if (!row) {
    // Already closed (e.g. the reaper got there first) - not an error.
    res.json({ ok: true, alreadyClosed: true });
    return;
  }

  // Optional courtesy call back to the consumer over the OAuth2 client_credentials
  // grant, so the LMS can show the duration without ever owning the content.
  void reportViewingSummary(row).catch((err) => console.warn('[service-call] summary push failed:', err.message));

  res.json({
    ok: true,
    presenceSeconds: row.presence_seconds,
    watchedSeconds: row.watched_seconds,
    endedAt: row.ended_at,
  });
});

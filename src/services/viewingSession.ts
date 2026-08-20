import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { env } from '../config/env.js';
import { ACTIVITY_EVENT, logActivity } from './activityLog.js';

/**
 * VIEWING SESSIONS - the honest part of the analytics story.
 *
 * LTI 1.3 tells the provider WHO launched WHAT and WHEN. It carries no
 * playback telemetry whatsoever. Everything below is produced by the
 * provider's own player calling the provider's own API:
 *
 *   mount            -> start()      -> CONTENT_VIEW_STARTED
 *   every 15s        -> heartbeat()
 *   unload / hidden  -> end()        -> CONTENT_VIEW_ENDED   (via sendBeacon)
 *   no heartbeat 90s -> reap()       -> CONTENT_VIEW_ENDED   (end_reason='timeout')
 *
 * Two different durations are recorded because they answer different questions:
 *   presence_seconds - wall-clock time the lecture page was open
 *   watched_seconds  - seconds of video actually played (from the <video> element)
 */

export interface ViewingSessionRow {
  id: string;
  launch_id: string;
  platform_issuer: string;
  deployment_id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  course_id: string | null;
  module_id: string | null;
  lecture_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  last_heartbeat_at: Date;
  presence_seconds: number;
  watched_seconds: number;
  furthest_position_seconds: number;
  end_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface StartInput {
  launchId: string;
  platformIssuer: string;
  platformClientId: string;
  platformName?: string | null;
  deploymentId: string;
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  courseId: string;
  courseName: string;
  moduleId: string;
  moduleName: string;
  lectureId: string;
  lectureName: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function startViewingSession(input: StartInput): Promise<ViewingSessionRow> {
  // A refresh inside the iframe creates a new session; close any earlier one
  // for the same launch so we never leave two sessions open at once.
  await closeOpenSessionsForLaunch(input.launchId, 'superseded');

  const id = randomUUID();
  const row = await queryOne<ViewingSessionRow>(
    `INSERT INTO viewing_sessions (
       id, launch_id, platform_issuer, deployment_id,
       user_id, user_email, user_name,
       course_id, module_id, lecture_id,
       ip_address, user_agent
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      id,
      input.launchId,
      input.platformIssuer,
      input.deploymentId,
      input.userId,
      input.userEmail ?? null,
      input.userName ?? null,
      input.courseId,
      input.moduleId,
      input.lectureId,
      input.ipAddress ?? null,
      input.userAgent ?? null,
    ],
  );

  await logActivity({
    eventType: ACTIVITY_EVENT.CONTENT_VIEW_STARTED,
    launchId: input.launchId,
    viewingSessionId: id,
    sessionId: id,
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    platformIssuer: input.platformIssuer,
    platformClientId: input.platformClientId,
    platformName: input.platformName,
    deploymentId: input.deploymentId,
    courseId: input.courseId,
    courseName: input.courseName,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
    lectureId: input.lectureId,
    lectureName: input.lectureName,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: { source: 'provider-player' },
  });

  return row!;
}

export async function heartbeat(
  sessionId: string,
  progress: { watchedSeconds: number; positionSeconds: number },
): Promise<ViewingSessionRow | null> {
  return queryOne<ViewingSessionRow>(
    `UPDATE viewing_sessions
        SET last_heartbeat_at = now(),
            presence_seconds  = GREATEST(presence_seconds, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)))::int),
            watched_seconds   = GREATEST(watched_seconds, $2),
            furthest_position_seconds = GREATEST(furthest_position_seconds, $3)
      WHERE id = $1 AND ended_at IS NULL
      RETURNING *`,
    [sessionId, Math.max(0, Math.floor(progress.watchedSeconds)), Math.max(0, Math.floor(progress.positionSeconds))],
  );
}

export async function endViewingSession(
  sessionId: string,
  reason: string,
  progress?: { watchedSeconds: number; positionSeconds: number },
): Promise<ViewingSessionRow | null> {
  const row = await queryOne<ViewingSessionRow>(
    `UPDATE viewing_sessions
        SET ended_at         = now(),
            last_heartbeat_at = now(),
            end_reason       = $2,
            presence_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - started_at)))::int),
            watched_seconds  = GREATEST(watched_seconds, $3),
            furthest_position_seconds = GREATEST(furthest_position_seconds, $4)
      WHERE id = $1 AND ended_at IS NULL
      RETURNING *`,
    [
      sessionId,
      reason,
      Math.max(0, Math.floor(progress?.watchedSeconds ?? 0)),
      Math.max(0, Math.floor(progress?.positionSeconds ?? 0)),
    ],
  );
  if (row) await logEnd(row, reason);
  return row;
}

async function closeOpenSessionsForLaunch(launchId: string, reason: string): Promise<void> {
  const rows = await query<ViewingSessionRow>(
    `UPDATE viewing_sessions
        SET ended_at = GREATEST(last_heartbeat_at, started_at),
            end_reason = $2,
            presence_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (last_heartbeat_at - started_at)))::int)
      WHERE launch_id = $1 AND ended_at IS NULL
      RETURNING *`,
    [launchId, reason],
  );
  for (const row of rows) await logEnd(row, reason);
}

/**
 * Browsers do not guarantee an unload beacon (tab crash, phone sleep, network
 * drop). Anything that stops sending heartbeats is closed server-side, with the
 * last heartbeat as the end time so the duration is not inflated.
 */
export async function reapStaleSessions(): Promise<number> {
  const rows = await query<ViewingSessionRow>(
    `UPDATE viewing_sessions
        SET ended_at = GREATEST(last_heartbeat_at, started_at),
            end_reason = 'timeout',
            presence_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (last_heartbeat_at - started_at)))::int)
      WHERE ended_at IS NULL
        AND last_heartbeat_at < now() - ($1 || ' seconds')::interval
      RETURNING *`,
    [String(env.viewHeartbeatTimeoutSeconds)],
  );
  for (const row of rows) await logEnd(row, 'timeout');
  return rows.length;
}

/** Emits CONTENT_VIEW_ENDED with the fully denormalised context for the dashboard. */
async function logEnd(session: ViewingSessionRow, reason: string): Promise<void> {
  const ctx = await queryOne<{
    course_name: string | null;
    module_name: string | null;
    lecture_name: string | null;
    platform_client_id: string | null;
    platform_name: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT c.title AS course_name,
            m.title AS module_name,
            l.title AS lecture_name,
            lp.platform_client_id,
            lp.platform_name,
            lp.ip_address,
            lp.user_agent
       FROM lti_launches lp
       LEFT JOIN courses  c ON c.id = lp.course_id
       LEFT JOIN modules  m ON m.id = lp.module_id
       LEFT JOIN lectures l ON l.id = lp.lecture_id
      WHERE lp.id = $1`,
    [session.launch_id],
  );

  const presence = Math.max(
    0,
    session.presence_seconds ||
      Math.floor(((session.ended_at?.getTime() ?? Date.now()) - session.started_at.getTime()) / 1000),
  );

  await logActivity({
    eventType: ACTIVITY_EVENT.CONTENT_VIEW_ENDED,
    launchId: session.launch_id,
    viewingSessionId: session.id,
    sessionId: session.id,
    userId: session.user_id,
    userEmail: session.user_email,
    userName: session.user_name,
    platformIssuer: session.platform_issuer,
    platformClientId: ctx?.platform_client_id ?? null,
    platformName: ctx?.platform_name ?? null,
    deploymentId: session.deployment_id,
    courseId: session.course_id,
    courseName: ctx?.course_name ?? null,
    moduleId: session.module_id,
    moduleName: ctx?.module_name ?? null,
    lectureId: session.lecture_id,
    lectureName: ctx?.lecture_name ?? null,
    ipAddress: session.ip_address ?? ctx?.ip_address ?? null,
    userAgent: session.user_agent ?? ctx?.user_agent ?? null,
    metadata: {
      end_reason: reason,
      presence_seconds: presence,
      watched_seconds: session.watched_seconds,
      furthest_position_seconds: session.furthest_position_seconds,
      started_at: session.started_at,
      ended_at: session.ended_at,
    },
  });
}

export function startReaper(): NodeJS.Timeout {
  const interval = setInterval(() => {
    reapStaleSessions()
      .then((n) => {
        if (n > 0) console.log(`[reaper] closed ${n} stale viewing session(s)`);
      })
      .catch((err) => console.error('[reaper] failed', err));
  }, env.viewReaperIntervalSeconds * 1000);
  interval.unref();
  return interval;
}

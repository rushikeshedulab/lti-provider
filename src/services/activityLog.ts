import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';

export const ACTIVITY_EVENT = {
  CONTENT_LAUNCHED: 'CONTENT_LAUNCHED',
  CONTENT_VIEW_STARTED: 'CONTENT_VIEW_STARTED',
  CONTENT_VIEW_HEARTBEAT: 'CONTENT_VIEW_HEARTBEAT',
  CONTENT_VIEW_ENDED: 'CONTENT_VIEW_ENDED',
  DEEP_LINKING_REQUESTED: 'DEEP_LINKING_REQUESTED',
  DEEP_LINKING_RESPONSE_SENT: 'DEEP_LINKING_RESPONSE_SENT',
  LAUNCH_REJECTED: 'LAUNCH_REJECTED',
  DEPLOYMENT_ACTIVATED: 'DEPLOYMENT_ACTIVATED',
} as const;

export type ActivityEvent = (typeof ACTIVITY_EVENT)[keyof typeof ACTIVITY_EVENT];

export interface ActivityLogInput {
  eventType: ActivityEvent;
  launchId?: string | null;
  viewingSessionId?: string | null;
  sessionId?: string | null;

  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;

  platformIssuer?: string | null;
  platformClientId?: string | null;
  platformName?: string | null;
  deploymentId?: string | null;

  courseId?: string | null;
  courseName?: string | null;
  moduleId?: string | null;
  moduleName?: string | null;
  lectureId?: string | null;
  lectureName?: string | null;

  ipAddress?: string | null;
  userAgent?: string | null;

  metadata?: Record<string, unknown>;
}

/**
 * Append-only activity trail. Every content access by every consumer lands here.
 * Logging must never break a launch, so failures are reported and swallowed.
 */
export async function logActivity(input: ActivityLogInput): Promise<string> {
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO content_activity_logs (
         id, event_type, launch_id, viewing_session_id, session_id,
         user_id, user_email, user_name,
         platform_issuer, platform_client_id, platform_name, deployment_id,
         course_id, course_name, module_id, module_name, lecture_id, lecture_name,
         ip_address, user_agent, metadata
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18,
         $19, $20, $21
       )`,
      [
        id,
        input.eventType,
        input.launchId ?? null,
        input.viewingSessionId ?? null,
        input.sessionId ?? null,
        input.userId ?? null,
        input.userEmail ?? null,
        input.userName ?? null,
        input.platformIssuer ?? null,
        input.platformClientId ?? null,
        input.platformName ?? null,
        input.deploymentId ?? null,
        input.courseId ?? null,
        input.courseName ?? null,
        input.moduleId ?? null,
        input.moduleName ?? null,
        input.lectureId ?? null,
        input.lectureName ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    console.error('[activity-log] failed to write event', input.eventType, err);
  }
  return id;
}

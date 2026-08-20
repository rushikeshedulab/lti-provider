import { Router } from 'express';
import { CLAIM, getCustom, type ContextClaim, type ResourceLinkClaim } from '../lti/claims.js';
import { getLecture, hasPlaybackTimeline, isSelfHosted, toDeliverableUrl } from '../content/repository.js';
import { consumeLaunchToken } from '../services/launchStore.js';
import { issueContentSession, issueMediaToken } from '../services/contentSession.js';
import { query } from '../db/pool.js';

export const contentRouter = Router();

/**
 * Exchanges the one-time launch handle from the redirect for:
 *   - the lecture payload (provider-owned content)
 *   - a content session token for subsequent activity calls
 *   - the identity/context the provider derived from the LTI id_token, so the
 *     demo can show exactly what the provider learned from the launch.
 */
contentRouter.post('/launch/exchange', async (req, res) => {
  const token = (req.body?.lt as string) ?? '';
  if (!token) {
    res.status(400).json({ error: 'missing_launch_token' });
    return;
  }

  const launch = await consumeLaunchToken(token, 'player');
  if (!launch) {
    res.status(401).json({
      error: 'invalid_launch_token',
      message: 'This launch handle is unknown, expired, or already used. Re-launch from the consumer LMS.',
    });
    return;
  }

  const lecture = launch.lecture_id ? await getLecture(launch.lecture_id) : null;
  if (!lecture) {
    res.status(404).json({ error: 'lecture_not_found' });
    return;
  }

  const claims = launch.id_token_claims as Record<string, unknown>;
  const context = claims[CLAIM.CONTEXT] as ContextClaim | undefined;
  const resourceLink = claims[CLAIM.RESOURCE_LINK] as ResourceLinkClaim | undefined;
  const custom = getCustom(claims as never);

  // Self-hosted files get a short-lived signed URL bound to this launch, so the
  // bytes stay unreachable to anyone who did not come through a valid launch.
  const mediaToken = isSelfHosted(lecture.content_url)
    ? await issueMediaToken(lecture.content_url, launch.id)
    : undefined;

  const contentSessionToken = await issueContentSession({
    launchId: launch.id,
    userId: launch.user_id,
    userEmail: launch.user_email ?? undefined,
    userName: launch.user_name ?? undefined,
    lectureId: lecture.id,
    courseId: lecture.course_id,
    moduleId: lecture.module_id,
    platformIssuer: launch.platform_issuer,
    deploymentId: launch.deployment_id,
  });

  const validationChecks = await query<{ metadata: { validation_checks?: unknown } }>(
    `SELECT metadata FROM content_activity_logs
      WHERE launch_id = $1 AND event_type = 'CONTENT_LAUNCHED'
      ORDER BY occurred_at DESC LIMIT 1`,
    [launch.id],
  );

  res.json({
    contentSessionToken,
    lecture: {
      id: lecture.id,
      title: lecture.title,
      description: lecture.description,
      contentType: lecture.content_type,
      contentUrl: toDeliverableUrl(lecture.content_url, mediaToken),
      selfHosted: isSelfHosted(lecture.content_url),
      hasPlaybackTimeline: hasPlaybackTimeline(lecture.content_type),
      posterUrl: lecture.poster_url,
      durationSeconds: lecture.duration_seconds,
      moduleId: lecture.module_id,
      moduleTitle: lecture.module_title,
      courseId: lecture.course_id,
      courseTitle: lecture.course_title,
      courseDescription: lecture.course_description,
    },
    launch: {
      id: launch.id,
      launchedAt: launch.launched_at,
      messageType: launch.message_type,
      ltiVersion: launch.lti_version,
      deploymentId: launch.deployment_id,
      platformIssuer: launch.platform_issuer,
      platformClientId: launch.platform_client_id,
      platformName: launch.platform_name,
      user: {
        id: launch.user_id,
        name: launch.user_name,
        email: launch.user_email,
        roles: launch.roles,
      },
      context: { id: context?.id ?? null, title: context?.title ?? null, label: context?.label ?? null },
      resourceLink: { id: resourceLink?.id ?? null, title: resourceLink?.title ?? null },
      custom,
      validationChecks: validationChecks[0]?.metadata?.validation_checks ?? [],
    },
  });
});

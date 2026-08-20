import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { SignJWT } from 'jose';
import { env, toolEndpoints } from '../config/env.js';
import { CLAIM, LTI_VERSION, MESSAGE_TYPE, type DeepLinkingSettingsClaim } from '../lti/claims.js';
import { getPrivateKey, SIGNING_ALG } from '../lti/keys.js';
import { getCourseCatalog, getLecture } from '../content/repository.js';
import { consumeLaunchToken, getLaunch } from '../services/launchStore.js';
import { issueDeepLinkSession, verifyDeepLinkSession } from '../services/contentSession.js';
import { ACTIVITY_EVENT, logActivity } from '../services/activityLog.js';
import { clientIp } from '../utils/http.js';

export const deepLinkRouter = Router();

/**
 * DEEP LINKING (LTI-DL 2.0)
 * -------------------------
 * This is how the consumer learns what content exists WITHOUT copying the
 * provider's database. An instructor on the consumer launches a
 * LtiDeepLinkingRequest, picks lectures here, and the provider returns a signed
 * LtiDeepLinkingResponse containing `ltiResourceLink` content items. The
 * consumer stores only those links (id + title + custom params) - never the
 * video URLs, never the lecture bodies.
 */

/** Step 1: the picker UI exchanges its one-time handle for the catalog. */
deepLinkRouter.post('/context', async (req, res) => {
  const token = (req.body?.lt as string) ?? '';
  if (!token) {
    res.status(400).json({ error: 'missing_launch_token' });
    return;
  }

  const launch = await consumeLaunchToken(token, 'deep_link');
  if (!launch) {
    res.status(401).json({ error: 'invalid_launch_token', message: 'Handle unknown, expired, or already used.' });
    return;
  }

  const claims = launch.id_token_claims as Record<string, unknown>;
  const settings = claims[CLAIM.DEEP_LINKING_SETTINGS] as DeepLinkingSettingsClaim | undefined;

  res.json({
    deepLinkSessionToken: await issueDeepLinkSession(launch.id),
    catalog: await getCourseCatalog(),
    launch: {
      id: launch.id,
      platformIssuer: launch.platform_issuer,
      platformName: launch.platform_name,
      deploymentId: launch.deployment_id,
      user: { id: launch.user_id, name: launch.user_name, email: launch.user_email, roles: launch.roles },
      acceptMultiple: settings?.accept_multiple ?? false,
      title: settings?.title ?? null,
    },
  });
});

/** Step 2: the picker posts the selection; we return a signed response JWT. */
deepLinkRouter.post('/response', async (req, res) => {
  const { deepLinkSessionToken, lectureIds } = req.body ?? {};
  if (!deepLinkSessionToken || !Array.isArray(lectureIds) || lectureIds.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'deepLinkSessionToken and lectureIds are required' });
    return;
  }

  let launchId: string;
  try {
    ({ launchId } = await verifyDeepLinkSession(String(deepLinkSessionToken)));
  } catch {
    res.status(401).json({ error: 'invalid_deep_link_session' });
    return;
  }

  const launch = await getLaunch(launchId);
  if (!launch || launch.message_type !== MESSAGE_TYPE.DEEP_LINKING_REQUEST) {
    res.status(404).json({ error: 'launch_not_found' });
    return;
  }

  const claims = launch.id_token_claims as Record<string, unknown>;
  const settings = claims[CLAIM.DEEP_LINKING_SETTINGS] as DeepLinkingSettingsClaim | undefined;
  if (!settings?.deep_link_return_url) {
    res.status(400).json({ error: 'missing_return_url' });
    return;
  }

  const contentItems = [];
  for (const id of lectureIds as string[]) {
    const lecture = await getLecture(String(id));
    if (!lecture) continue;
    contentItems.push({
      type: 'ltiResourceLink',
      title: lecture.title,
      text: lecture.description,
      url: toolEndpoints.targetLinkUri,
      presentation: { documentTarget: 'iframe' },
      // The custom parameters travel back on every future launch of this link -
      // this is how the provider knows which lecture was requested.
      custom: {
        lecture_id: lecture.id,
        content_type: lecture.content_type,
        module_id: lecture.module_id,
        module_title: lecture.module_title,
        course_id: lecture.course_id,
        course_title: lecture.course_title,
      },
    });
  }

  if (contentItems.length === 0) {
    res.status(400).json({ error: 'no_valid_lectures' });
    return;
  }

  const key = await getPrivateKey();
  const jwt = await new SignJWT({
    [CLAIM.MESSAGE_TYPE]: MESSAGE_TYPE.DEEP_LINKING_RESPONSE,
    [CLAIM.VERSION]: LTI_VERSION,
    [CLAIM.DEPLOYMENT_ID]: launch.deployment_id,
    [CLAIM.CONTENT_ITEMS]: contentItems,
    ...(settings.data ? { [CLAIM.DEEP_LINKING_DATA]: settings.data } : {}),
    nonce: randomUUID(),
  })
    .setProtectedHeader({ alg: SIGNING_ALG, kid: env.keyId, typ: 'JWT' })
    // Roles reverse for the response: the TOOL is now the issuer.
    .setIssuer(launch.platform_client_id)
    .setAudience(launch.platform_issuer)
    .setSubject(launch.user_id)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

  await logActivity({
    eventType: ACTIVITY_EVENT.DEEP_LINKING_RESPONSE_SENT,
    launchId: launch.id,
    userId: launch.user_id,
    userEmail: launch.user_email,
    userName: launch.user_name,
    platformIssuer: launch.platform_issuer,
    platformClientId: launch.platform_client_id,
    platformName: launch.platform_name,
    deploymentId: launch.deployment_id,
    ipAddress: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
    metadata: { selected: contentItems.map((c) => c.custom.lecture_id) },
  });

  res.json({ jwt, returnUrl: settings.deep_link_return_url, count: contentItems.length });
});

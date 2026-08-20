import { Router, type Request, type Response } from 'express';
import { env, toolEndpoints } from '../config/env.js';
import {
  CLAIM,
  LTI_VERSION,
  MESSAGE_TYPE,
  getCustom,
  getRoles,
  isInstructorOrAdmin,
  type ContextClaim,
  type DeepLinkingSettingsClaim,
  type ResourceLinkClaim,
} from '../lti/claims.js';
import { findPlatform } from '../lti/platformStore.js';
import { createState } from '../lti/stateStore.js';
import { LtiValidationError, validateLaunch } from '../lti/validateLaunch.js';
import { getLecture } from '../content/repository.js';
import { ACTIVITY_EVENT, logActivity } from '../services/activityLog.js';
import { createLaunchToken, recordLaunch } from '../services/launchStore.js';
import { clientIp, renderErrorPage } from '../utils/http.js';

export const ltiRouter = Router();

const STATE_COOKIE = 'lti_state';

/**
 * Cross-site iframe reality check: a SameSite=None cookie requires HTTPS. On
 * plain http://localhost the browser rejects it, so we fall back to Lax - the
 * cookie then simply will not be sent on the cross-site POST back, and
 * validateLaunch() relies on the server-side state store instead.
 */
function stateCookieOptions() {
  const secure = env.baseUrl.startsWith('https://');
  return {
    httpOnly: true,
    secure,
    sameSite: (secure ? 'none' : 'lax') as 'none' | 'lax',
    maxAge: env.stateTtlSeconds * 1000,
    path: '/',
  };
}

// ---------------------------------------------------------------------------
// STEP 1 - THIRD-PARTY INITIATED LOGIN
// The platform sends the browser here first. We answer with a redirect to the
// platform's own authorization endpoint, carrying a state + nonce we generated.
// ---------------------------------------------------------------------------
async function handleLoginInitiation(req: Request, res: Response) {
  const params = { ...(req.query as Record<string, string>), ...(req.body as Record<string, string>) };
  const { iss, login_hint, target_link_uri, lti_message_hint, client_id, lti_deployment_id } = params;

  if (!iss) return renderErrorPage(res, 400, 'Login initiation failed', 'Missing required parameter: iss');
  if (!login_hint) {
    return renderErrorPage(res, 400, 'Login initiation failed', 'Missing required parameter: login_hint');
  }

  const platform = await findPlatform(iss, client_id ?? null);
  if (!platform) {
    return renderErrorPage(
      res,
      401,
      'Unregistered platform',
      `This tool has no active registration for issuer "${iss}"${client_id ? ` and client_id "${client_id}"` : ''}.`,
    );
  }

  if (lti_deployment_id && !platform.deployment_ids.includes(lti_deployment_id)) {
    return renderErrorPage(
      res,
      401,
      'Unknown deployment',
      `deployment_id "${lti_deployment_id}" is not registered for this platform.`,
    );
  }

  const targetLinkUri = target_link_uri ?? toolEndpoints.targetLinkUri;

  const { state, nonce } = await createState({
    platformId: platform.id,
    targetLinkUri,
    ltiMessageHint: lti_message_hint,
    loginHint: login_hint,
  });

  res.cookie(STATE_COOKIE, state, stateCookieOptions());

  const authUrl = new URL(platform.auth_login_url);
  authUrl.searchParams.set('scope', 'openid');
  authUrl.searchParams.set('response_type', 'id_token');
  authUrl.searchParams.set('response_mode', 'form_post');
  authUrl.searchParams.set('prompt', 'none');
  authUrl.searchParams.set('client_id', platform.client_id);
  authUrl.searchParams.set('redirect_uri', platform.tool_redirect_uri);
  authUrl.searchParams.set('login_hint', login_hint);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  if (lti_message_hint) authUrl.searchParams.set('lti_message_hint', lti_message_hint);
  if (lti_deployment_id) authUrl.searchParams.set('lti_deployment_id', lti_deployment_id);

  console.log(`[lti] login initiation from ${iss} -> redirecting to ${platform.auth_login_url}`);
  res.redirect(302, authUrl.toString());
}

ltiRouter.get('/login', handleLoginInitiation);
ltiRouter.post('/login', handleLoginInitiation);

// ---------------------------------------------------------------------------
// STEP 2 - LTI MESSAGE LAUNCH (the platform form-POSTs the signed id_token here)
// ---------------------------------------------------------------------------
ltiRouter.post('/launch', async (req: Request, res: Response) => {
  const idToken = (req.body?.id_token as string) ?? '';
  const state = (req.body?.state as string) ?? '';
  const cookieState = req.cookies?.[STATE_COOKIE] as string | undefined;
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') ?? null;

  let validated;
  try {
    validated = await validateLaunch({ idToken, state, cookieState });
  } catch (err) {
    const e = err as LtiValidationError;
    console.warn('[lti] launch rejected:', e.code, e.message);
    await logActivity({
      eventType: ACTIVITY_EVENT.LAUNCH_REJECTED,
      ipAddress: ip,
      userAgent,
      metadata: { code: e.code ?? 'unknown', message: e.message },
    });
    return renderErrorPage(res, 401, 'LTI launch rejected', e.message, e.code);
  }

  res.clearCookie(STATE_COOKIE, { path: '/' });

  const { claims, platform, messageType, deploymentId, checks, stateRow } = validated;
  const roles = getRoles(claims);
  const custom = getCustom(claims);
  const context = claims[CLAIM.CONTEXT] as ContextClaim | undefined;
  const resourceLink = claims[CLAIM.RESOURCE_LINK] as ResourceLinkClaim | undefined;
  const toolPlatform = claims[CLAIM.TOOL_PLATFORM] as { name?: string; guid?: string } | undefined;

  // -------------------------------------------------------------------------
  // DEEP LINKING REQUEST - the platform is asking "what content do you have?"
  // -------------------------------------------------------------------------
  if (messageType === MESSAGE_TYPE.DEEP_LINKING_REQUEST) {
    if (!isInstructorOrAdmin(claims)) {
      return renderErrorPage(
        res,
        403,
        'Not permitted',
        'Deep Linking content selection requires an Instructor or Administrator role.',
      );
    }
    const settings = claims[CLAIM.DEEP_LINKING_SETTINGS] as DeepLinkingSettingsClaim | undefined;
    if (!settings?.deep_link_return_url) {
      return renderErrorPage(res, 400, 'Invalid Deep Linking request', 'deep_linking_settings claim is missing.');
    }

    const launch = await recordLaunch({
      platformId: platform.id,
      platformIssuer: platform.issuer,
      platformClientId: platform.client_id,
      platformName: toolPlatform?.name ?? platform.name,
      deploymentId,
      messageType,
      ltiVersion: LTI_VERSION,
      tokenJti: claims.jti ?? null,
      nonce: claims.nonce,
      platformLaunchId: stateRow.lti_message_hint,
      userId: claims.sub,
      userName: claims.name ?? null,
      userEmail: claims.email ?? null,
      roles,
      contextId: context?.id ?? null,
      contextTitle: context?.title ?? null,
      ipAddress: ip,
      userAgent,
      claims: claims as Record<string, unknown>,
    });

    await logActivity({
      eventType: ACTIVITY_EVENT.DEEP_LINKING_REQUESTED,
      launchId: launch.id,
      userId: claims.sub,
      userEmail: claims.email ?? null,
      userName: claims.name ?? null,
      platformIssuer: platform.issuer,
      platformClientId: platform.client_id,
      platformName: toolPlatform?.name ?? platform.name,
      deploymentId,
      ipAddress: ip,
      userAgent,
      metadata: { accept_multiple: settings.accept_multiple ?? false },
    });

    const token = await createLaunchToken(launch.id, 'deep_link');
    return res.redirect(303, `/deep-link?lt=${encodeURIComponent(token)}`);
  }

  // -------------------------------------------------------------------------
  // RESOURCE LINK REQUEST - a student is opening a specific lecture
  // -------------------------------------------------------------------------
  const lectureId = custom.lecture_id ?? resourceLink?.id ?? '';
  const lecture = lectureId ? await getLecture(lectureId) : null;

  if (!lecture) {
    return renderErrorPage(
      res,
      404,
      'Content not found',
      `The launch was valid, but this tool has no lecture with id "${lectureId || '(none supplied)'}". ` +
        `Expected a custom claim "lecture_id".`,
      'unknown_lecture',
    );
  }

  const launch = await recordLaunch({
    platformId: platform.id,
    platformIssuer: platform.issuer,
    platformClientId: platform.client_id,
    platformName: toolPlatform?.name ?? platform.name,
    deploymentId,
    messageType,
    ltiVersion: LTI_VERSION,
    tokenJti: claims.jti ?? null,
    nonce: claims.nonce,
    platformLaunchId: stateRow.lti_message_hint,
    userId: claims.sub,
    userName: claims.name ?? null,
    userEmail: claims.email ?? null,
    roles,
    contextId: context?.id ?? null,
    contextTitle: context?.title ?? null,
    resourceLinkId: resourceLink?.id ?? null,
    resourceLinkTitle: resourceLink?.title ?? null,
    courseId: lecture.course_id,
    moduleId: lecture.module_id,
    lectureId: lecture.id,
    ipAddress: ip,
    userAgent,
    claims: claims as Record<string, unknown>,
  });

  await logActivity({
    eventType: ACTIVITY_EVENT.CONTENT_LAUNCHED,
    launchId: launch.id,
    sessionId: launch.id,
    userId: claims.sub,
    userEmail: claims.email ?? null,
    userName: claims.name ?? null,
    platformIssuer: platform.issuer,
    platformClientId: platform.client_id,
    platformName: toolPlatform?.name ?? platform.name,
    deploymentId,
    courseId: lecture.course_id,
    courseName: lecture.course_title,
    moduleId: lecture.module_id,
    moduleName: lecture.module_title,
    lectureId: lecture.id,
    lectureName: lecture.title,
    ipAddress: ip,
    userAgent,
    metadata: {
      roles,
      context_id: context?.id ?? null,
      resource_link_id: resourceLink?.id ?? null,
      validation_checks: checks,
    },
  });

  console.log(
    `[lti] launch OK - ${claims.email ?? claims.sub} from ${platform.issuer} opened lecture ${lecture.id}`,
  );

  const token = await createLaunchToken(launch.id, 'player');
  res.redirect(303, `/player?lt=${encodeURIComponent(token)}`);
});

// A GET here means someone opened the launch URL directly in a browser.
ltiRouter.get('/launch', (_req, res) => {
  renderErrorPage(
    res,
    405,
    'This URL is the LTI launch endpoint',
    'It only accepts a signed LTI 1.3 id_token via HTTP POST from a registered platform. ' +
      'Start the demo from the Consumer LMS instead.',
  );
});

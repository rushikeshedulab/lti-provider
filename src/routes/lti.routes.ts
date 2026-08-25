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
import {
  findPlatform,
  findPlatformByClientId,
  isDeploymentActivated,
  recordActivation,
} from '../lti/platformStore.js';
import { createState } from '../lti/stateStore.js';
import { resolvePlatformEndpoints } from '../services/platformEndpoints.js';
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

  /**
   * The commonest way a hand-entered connection fails is an issuer that does
   * not match to the character - a trailing slash, http vs https, or a host
   * that differs from the address the administrator typed. The client_id is
   * unique, so when it alone matches we can say exactly what is wrong instead
   * of "unregistered platform".
   */
  if (!platform && client_id) {
    const byClientId = await findPlatformByClientId(client_id);
    if (byClientId) {
      console.warn(
        `[lti] issuer mismatch for client_id ${client_id}: launch says "${iss}", registration says "${byClientId.issuer}"`,
      );
      return renderErrorPage(
        res,
        401,
        'This connection has the wrong issuer saved',
        `The LMS identifies itself as "${iss}", but this connection stores "${byClientId.issuer}". ` +
          `Open Admin - LTI connections and set the issuer to "${iss}" exactly.`,
        'issuer_mismatch',
      );
    }
  }

  if (!platform) {
    return renderErrorPage(
      res,
      401,
      'Unregistered platform',
      `This tool has no active registration for issuer "${iss}"${client_id ? ` and client_id "${client_id}"` : ''}. ` +
        `Add it in Admin - LTI connections, using the client_id and deployment_id this LMS generated.`,
      'unknown_platform',
    );
  }

  if (lti_deployment_id && !platform.deployment_ids.includes(lti_deployment_id)) {
    return renderErrorPage(
      res,
      401,
      'Unknown deployment',
      `The LMS launched with deployment_id "${lti_deployment_id}", but this connection knows only ` +
        `${platform.deployment_ids.map((d) => `"${d}"`).join(', ')}. Add it in Admin - LTI connections.`,
      'unknown_deployment',
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

  // Resolved, not read straight off the row: when the platform publishes a
  // discovery document its endpoints are re-read on a timer, so an endpoint that
  // moves is followed without an administrator editing anything. This never waits
  // on the network - see services/platformEndpoints.ts.
  const endpoints = await resolvePlatformEndpoints(platform);
  if (!endpoints.authLoginUrl) {
    renderErrorPage(
      res,
      500,
      'This connection has no authorization endpoint',
      `The registration for "${iss}" stores no authorization endpoint, and its configuration document could ` +
        `not be read. Open Admin -> LTI connections and run Test to see what the LMS is serving.`,
      'no_auth_endpoint',
    );
    return;
  }

  const authUrl = new URL(endpoints.authLoginUrl);
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

  console.log(
    `[lti] login initiation from ${iss} -> redirecting to ${endpoints.authLoginUrl} ` +
      `(${endpoints.source}${endpoints.stale ? ', stale' : ''})`,
  );
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
  // FIRST USE OF A DEPLOYMENT
  //
  // No approval step: a launch that passed validation is served, whoever sent
  // it. The first one seen on a deployment is recorded anyway, so the admin
  // panel can show that a connection is genuinely working rather than merely
  // saved. Recording never blocks the launch.
  // -------------------------------------------------------------------------
  if (!isDeploymentActivated(platform, deploymentId)) {
    await recordActivation({
      platformId: platform.id,
      deploymentId,
      userId: claims.sub,
      email: claims.email ?? null,
      name: claims.name ?? null,
      contextId: context?.id ?? null,
      contextTitle: context?.title ?? null,
    }).catch((err: Error) => console.warn(`[lti] could not record first use: ${err.message}`));

    checks.push({
      step: 'Deployment',
      detail: `first launch seen for deployment_id=${deploymentId}`,
    });
    console.log(`[lti] first launch on deployment ${deploymentId} from ${platform.issuer}`);

    await logActivity({
      eventType: ACTIVITY_EVENT.DEPLOYMENT_ACTIVATED,
      userId: claims.sub,
      userEmail: claims.email ?? null,
      userName: claims.name ?? null,
      platformIssuer: platform.issuer,
      platformClientId: platform.client_id,
      platformName: toolPlatform?.name ?? platform.name,
      deploymentId,
      ipAddress: ip,
      userAgent,
      metadata: { roles, context_id: context?.id ?? null, context_title: context?.title ?? null },
    });
  }

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
    /**
     * Two very different failures land here, and telling them apart is the
     * whole point of this branch.
     *
     * No `lecture_id` custom claim at all means the platform launched the tool
     * itself rather than a piece of its content - there is nothing this tool
     * could have opened, and the fix is on the platform side (embed something
     * via Deep Linking first). A `lecture_id` that simply does not resolve is a
     * stale link: the content existed when it was embedded and has since been
     * removed here.
     */
    const boundToNothing = !custom.lecture_id;
    const instructor = isInstructorOrAdmin(claims);

    await logActivity({
      eventType: ACTIVITY_EVENT.LAUNCH_REJECTED,
      userId: claims.sub,
      userEmail: claims.email ?? null,
      userName: claims.name ?? null,
      platformIssuer: platform.issuer,
      platformClientId: platform.client_id,
      platformName: toolPlatform?.name ?? platform.name,
      deploymentId,
      ipAddress: ip,
      userAgent,
      metadata: {
        code: boundToNothing ? 'no_resource_selected' : 'unknown_lecture',
        resource_link_id: resourceLink?.id ?? null,
        lecture_id: custom.lecture_id ?? null,
        roles,
      },
    }).catch((err: Error) => console.warn(`[lti] could not log rejected launch: ${err.message}`));

    if (boundToNothing) {
      console.warn(
        `[lti] resource-link launch from ${platform.issuer} carried no lecture_id ` +
          `(resource_link_id="${resourceLink?.id ?? '(none)'}")`,
      );
      return renderErrorPage(
        res,
        404,
        'This link is not pointing at any content',
        instructor
          ? 'The launch itself was valid, but it carried no "lecture_id" custom parameter, so there is nothing ' +
              'here to open. A plain tool launch does not select content: go back to the LMS and use Deep Linking ' +
              '("Browse & Embed") to pick a lecture, then launch the link that creates.'
          : 'The launch itself was valid, but this link does not point at a lecture yet. Ask your instructor to ' +
              'add content from this tool to the course.',
        'no_resource_selected',
      );
    }

    return renderErrorPage(
      res,
      404,
      'Content not found',
      `The launch was valid, but this tool has no lecture with id "${lectureId}". The link was probably embedded ` +
        `before that lecture was removed - re-pick it in the LMS via Deep Linking.`,
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

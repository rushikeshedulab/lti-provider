import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';

/**
 * CONTENT SESSION TOKEN
 * ---------------------
 * After a launch is validated the player still needs to call the provider's
 * activity API. A normal session cookie would be a THIRD-PARTY cookie (the
 * player runs in an iframe on the consumer's page) and modern browsers drop
 * those, so instead the provider mints a short-lived bearer token that the
 * player holds in memory and sends as `Authorization: Bearer ...`.
 *
 * It is signed with a server-side secret; the browser only ever holds the
 * signed result, never the key.
 */
const secret = new TextEncoder().encode(env.contentSessionSecret);

export interface ContentSessionPayload {
  launchId: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  lectureId: string;
  courseId: string;
  moduleId: string;
  platformIssuer: string;
  deploymentId: string;
}

export async function issueContentSession(payload: ContentSessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.baseUrl)
    .setAudience('content-player')
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(`${env.contentSessionTtlSeconds}s`)
    .sign(secret);
}

export async function verifyContentSession(token: string): Promise<ContentSessionPayload> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.baseUrl,
    audience: 'content-player',
    algorithms: ['HS256'],
  });
  return payload as unknown as ContentSessionPayload;
}

/**
 * MEDIA TOKEN
 * -----------
 * Self-hosted files under /media must not be readable just because somebody
 * guessed the URL - the whole premise is that content is reachable only through
 * a validated LTI launch.
 *
 * A `<video src>` or a PDF viewer cannot send an Authorization header, and a
 * cookie would be a third-party cookie inside the consumer's iframe. So the
 * capability travels in the URL instead: a short-lived token, bound to one
 * exact path and one launch, minted only after the launch has been validated.
 */
export async function issueMediaToken(path: string, launchId: string): Promise<string> {
  return new SignJWT({ path, launchId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.baseUrl)
    .setAudience('media')
    .setIssuedAt()
    .setExpirationTime(`${env.contentSessionTtlSeconds}s`)
    .sign(secret);
}

export async function verifyMediaToken(token: string): Promise<{ path: string; launchId: string }> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.baseUrl,
    audience: 'media',
    algorithms: ['HS256'],
  });
  return { path: payload.path as string, launchId: payload.launchId as string };
}

/**
 * The same idea for the Deep Linking picker: the content-selection UI needs to
 * prove which validated deep linking launch it belongs to before the provider
 * will sign a DeepLinkingResponse for it.
 */
export async function issueDeepLinkSession(launchId: string): Promise<string> {
  return new SignJWT({ launchId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.baseUrl)
    .setAudience('deep-link-picker')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(secret);
}

export async function verifyDeepLinkSession(token: string): Promise<{ launchId: string }> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.baseUrl,
    audience: 'deep-link-picker',
    algorithms: ['HS256'],
  });
  return { launchId: payload.launchId as string };
}

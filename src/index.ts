import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { env, toolEndpoints } from './config/env.js';
import { toolRegistrationDocument } from './config/registration.js';
import { getPublicJwks } from './lti/keys.js';
import { listPlatformOrigins } from './lti/platformStore.js';
import { verifyMediaToken } from './services/contentSession.js';
import { MEDIA_DIR } from './content/uploads.js';
import { renderErrorPage } from './utils/http.js';
import { runStartupMigrations } from './db/autoMigrate.js';
import { purgeExpired } from './lti/stateStore.js';
import { ltiRouter } from './routes/lti.routes.js';
import { contentRouter } from './routes/content.routes.js';
import { activityRouter } from './routes/activity.routes.js';
import { deepLinkRouter } from './routes/deepLink.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { catalogRouter } from './routes/catalog.routes.js';
import { ensureMediaDir } from './content/manage.js';
import { startReaper } from './services/viewingSession.js';

const app = express();
app.set('trust proxy', true);

// sendBeacon() posts a Blob; allowing text/plain here lets the unload path
// share the JSON parser with every other endpoint.
app.use(express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());

/**
 * The player is designed to be embedded by the consumer LMS, so X-Frame-Options
 * must NOT be set to DENY/SAMEORIGIN. `frame-ancestors` is the modern, granular
 * replacement: only known consumer origins may embed this tool.
 *
 * The list is the origins of the REGISTERED platforms plus anything in
 * ALLOWED_FRAME_ANCESTORS, because a platform connected from /admin has to be
 * able to embed the player immediately - needing an environment change and a
 * restart is exactly what self-service connections exist to avoid. It is
 * refreshed on a short interval rather than per request, so the header costs no
 * database round trip.
 */
let frameAncestors = ["'self'", ...env.allowedFrameAncestors];

async function refreshFrameAncestors(): Promise<void> {
  try {
    const origins = await listPlatformOrigins();
    frameAncestors = [...new Set(["'self'", ...env.allowedFrameAncestors, ...origins])];
  } catch (err) {
    // Keep the previous list: a database blip must not lock every LMS out of
    // its own iframe.
    console.warn('[csp] could not refresh frame-ancestors:', (err as Error).message);
  }
}

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors.join(' ')}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'lti-content-provider' }));

/**
 * PROVIDER-HOSTED CONTENT FILES  (video, audio, PDF, images)
 *
 * Files live in ./media and are streamed from here, so the bytes demonstrably
 * come off the provider's own server rather than a CDN.
 *
 * Access requires a signed media token issued only after a launch has been
 * validated - guessing the filename is not enough. res.sendFile answers HTTP
 * Range requests, which is what lets a video seek and a PDF viewer fetch one
 * page at a time instead of downloading the whole file first.
 */
app.get('/media/:filename', async (req, res) => {
  // basename() strips any path traversal attempt before it reaches the disk.
  const filename = basename(String(req.params.filename));
  const requestedPath = `/media/${filename}`;
  const token = String(req.query.t ?? '');

  if (!token) {
    return renderErrorPage(
      res,
      401,
      'Content is not publicly available',
      'Files on this provider are only served through a validated LTI 1.3 launch. Open the lecture from the consumer LMS.',
      'missing_media_token',
    );
  }

  try {
    const claims = await verifyMediaToken(token);
    if (claims.path !== requestedPath) {
      return renderErrorPage(res, 403, 'Access denied', 'This link was issued for a different file.', 'path_mismatch');
    }
  } catch {
    return renderErrorPage(
      res,
      401,
      'Link expired',
      'This content link is invalid or has expired. Re-launch the lecture from the consumer LMS.',
      'invalid_media_token',
    );
  }

  const filePath = join(MEDIA_DIR, filename);
  if (!existsSync(filePath)) {
    return renderErrorPage(res, 404, 'File not found', `No such file: ${filename}`, 'file_missing');
  }

  res.sendFile(filePath, {
    acceptRanges: true,
    maxAge: '1h',
    headers: {
      // Signed URLs are per-launch, so they must not land in a shared cache.
      'Cache-Control': 'private, max-age=3600',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
});

// --- Public LTI metadata ---------------------------------------------------
app.get('/.well-known/jwks.json', async (_req, res) => {
  res.set('cache-control', 'public, max-age=300').json(await getPublicJwks());
});

app.get('/lti/config', (_req, res) => {
  res.json({ ...toolRegistrationDocument, endpoints: toolEndpoints });
});

// --- LTI + application routes ---------------------------------------------
app.use('/lti', ltiRouter);
app.use('/api', contentRouter);
app.use('/api', catalogRouter);
app.use('/api/activity', activityRouter);
app.use('/api/deep-link', deepLinkRouter);
app.use('/api/admin', adminRouter);

// --- React app (built by `npm run frontend:build` into ./public) -----------
const publicDir = resolve(process.cwd(), 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/lti')) return next();
    res.sendFile(join(publicDir, 'index.html'));
  });
} else {
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/lti')) return next();
    res
      .status(503)
      .type('html')
      .send('<h1>Frontend not built</h1><p>Run <code>npm run frontend:build</code> in lti-content-provider.</p>');
  });
}

// --- Error handler ---------------------------------------------------------
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', message: err.message });
});

// Bring the database up to date before serving, so connecting a new platform
// from /admin works on a database created by an older version of this tool.
await runStartupMigrations().catch((err: Error) => {
  console.error('[migrate] startup migration failed:', err.message);
});
await refreshFrameAncestors();

app.listen(env.port, () => {
  console.log('');
  console.log('  LTI 1.3 CONTENT PROVIDER  (role: Tool)');
  console.log(`  listening on            ${env.baseUrl}`);
  console.log(`  login initiation URL    ${toolEndpoints.loginInitiationUrl}`);
  console.log(`  redirect URI (launch)   ${toolEndpoints.redirectUri}`);
  console.log(`  JWKS                    ${toolEndpoints.jwksUrl}`);
  console.log(`  admin (content + logs)  ${env.baseUrl}/admin`);
  console.log(`  catalog service         ${env.baseUrl}/api/catalog`);
  console.log('');
  ensureMediaDir();
  startReaper();
  // Picks up a platform connected from /admin without a restart.
  setInterval(() => void refreshFrameAncestors(), 60 * 1000).unref();
  purgeExpired().catch(() => {});
  setInterval(() => void purgeExpired().catch(() => {}), 15 * 60 * 1000).unref();
});

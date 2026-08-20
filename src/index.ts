import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { env, toolEndpoints } from './config/env.js';
import { toolRegistrationDocument } from './config/registration.js';
import { getPublicJwks } from './lti/keys.js';
import { verifyMediaToken } from './services/contentSession.js';
import { renderErrorPage } from './utils/http.js';
import { purgeExpired } from './lti/stateStore.js';
import { ltiRouter } from './routes/lti.routes.js';
import { contentRouter } from './routes/content.routes.js';
import { activityRouter } from './routes/activity.routes.js';
import { deepLinkRouter } from './routes/deepLink.routes.js';
import { adminRouter } from './routes/admin.routes.js';
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
 * replacement: only the consumer origins listed in ALLOWED_FRAME_ANCESTORS may
 * embed this tool.
 */
app.use((_req, res, next) => {
  const ancestors = ["'self'", ...env.allowedFrameAncestors].join(' ');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
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
const mediaDir = resolve(process.cwd(), 'media');

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

  const filePath = join(mediaDir, filename);
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

app.listen(env.port, () => {
  console.log('');
  console.log('  LTI 1.3 CONTENT PROVIDER  (role: Tool)');
  console.log(`  listening on            ${env.baseUrl}`);
  console.log(`  login initiation URL    ${toolEndpoints.loginInitiationUrl}`);
  console.log(`  redirect URI (launch)   ${toolEndpoints.redirectUri}`);
  console.log(`  JWKS                    ${toolEndpoints.jwksUrl}`);
  console.log(`  admin dashboard         ${env.baseUrl}/admin`);
  console.log('');
  startReaper();
  purgeExpired().catch(() => {});
  setInterval(() => void purgeExpired().catch(() => {}), 15 * 60 * 1000).unref();
});

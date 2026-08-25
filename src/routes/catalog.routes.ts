import { Router } from 'express';
import { decodeJwt, jwtVerify } from 'jose';
import { env, toolEndpoints } from '../config/env.js';
import { getCourseCatalog } from '../content/repository.js';
import { findPlatform } from '../lti/platformStore.js';
import { jwksFor } from '../lti/jwks.js';
import { resolvePlatformEndpoints } from '../services/platformEndpoints.js';

/**
 * CATALOG SERVICE  (GET /api/catalog)
 * -----------------------------------
 * The list of what exists - ids, titles, module structure, content TYPE and
 * duration. Deliberately NOT the content: no content_url, no bytes, no signed
 * media links. Those are only ever produced by a validated LTI 1.3 launch.
 *
 * A registered platform calls this to keep its own course listing in step with
 * whatever the provider's admin has uploaded, which is what replaces the old
 * "an instructor picks lectures by hand" step.
 *
 * Authentication mirrors the `private_key_jwt` client assertion the tool uses
 * against the platform's token endpoint, with the roles reversed: the PLATFORM
 * signs a short-lived JWT with its own key and we verify it against the JWKS
 * URL in its registration. No shared secret, no new trust material.
 */
export const catalogRouter = Router();

export const CATALOG_AUDIENCE = `${env.baseUrl}/api/catalog`;

catalogRouter.get('/catalog', async (req, res) => {
  const header = req.get('authorization');
  const assertion = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!assertion) {
    res.status(401).json({ error: 'missing_token', message: 'Present a platform-signed JWT as a bearer token.' });
    return;
  }

  let issuer: string;
  try {
    issuer = String(decodeJwt(assertion).iss ?? '');
  } catch {
    res.status(400).json({ error: 'malformed_token' });
    return;
  }

  const platform = await findPlatform(issuer);
  if (!platform) {
    res.status(401).json({ error: 'unknown_platform', message: `No active registration for issuer "${issuer}".` });
    return;
  }

  try {
    const endpoints = await resolvePlatformEndpoints(platform);
    const { payload } = await jwtVerify(assertion, jwksFor(platform.id, endpoints.jwksUrl), {
      issuer: platform.issuer,
      // Addressed to this exact endpoint, so it cannot be replayed elsewhere.
      audience: CATALOG_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: 30,
      maxTokenAge: 300,
    });
    if (payload.client_id && payload.client_id !== platform.client_id) {
      res.status(401).json({ error: 'client_id_mismatch' });
      return;
    }
  } catch (err) {
    res.status(401).json({ error: 'invalid_token', message: (err as Error).message });
    return;
  }

  const courses = await getCourseCatalog();
  res.json({
    provider: { name: 'EduLab Content Provider', baseUrl: env.baseUrl },
    targetLinkUri: toolEndpoints.targetLinkUri,
    generatedAt: new Date().toISOString(),
    courses,
  });
});

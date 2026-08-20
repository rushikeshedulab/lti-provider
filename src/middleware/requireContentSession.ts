import type { NextFunction, Request, Response } from 'express';
import { verifyContentSession, type ContentSessionPayload } from '../services/contentSession.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      contentSession?: ContentSessionPayload;
    }
  }
}

/**
 * Authorises player -> provider API calls.
 *
 * The token normally arrives as `Authorization: Bearer ...`, but
 * navigator.sendBeacon() cannot set headers, so the unload path is allowed to
 * carry the same token in the JSON body instead.
 */
export async function requireContentSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = bearer ?? (req.body?.token as string | undefined);

  if (!token) {
    res.status(401).json({ error: 'missing_content_session', message: 'No content session token supplied' });
    return;
  }

  try {
    req.contentSession = await verifyContentSession(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_content_session', message: 'Content session token is invalid or expired' });
  }
}

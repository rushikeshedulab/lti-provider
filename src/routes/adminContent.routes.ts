import { createWriteStream } from 'node:fs';
import { rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { queryOne } from '../db/pool.js';
import { getCourseCatalog } from '../content/repository.js';
import {
  ContentError,
  SUPPORTED_EXTENSIONS,
  contentTypeForFilename,
  createCourse,
  createLecture,
  createModule,
  deleteCourse,
  deleteLecture,
  deleteMedia,
  deleteModule,
  ensureMediaDir,
  listMedia,
  mediaDir,
  uniqueMediaName,
  updateCourse,
  updateLecture,
  updateModule,
} from '../content/manage.js';

/**
 * ADMIN CONTENT API  (mounted under /api/admin/content, behind requireAdmin)
 * --------------------------------------------------------------------------
 * The single place course content comes into existence. Anything created here
 * is picked up by every registered consumer automatically, because the
 * consumer mirrors /api/catalog - no instructor selection step exists.
 */
export const adminContentRouter = Router();

/** Turns a thrown ContentError into its HTTP response; anything else is a 500. */
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ContentError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      console.error('[admin/content]', err);
      res.status(500).json({ error: 'internal_error', message: (err as Error).message });
    }
  };
}

/** The whole catalog plus the uploaded files, i.e. everything the panel renders. */
adminContentRouter.get(
  '/',
  handler(async (_req, res) => {
    res.json({ courses: await getCourseCatalog(), media: listMedia() });
  }),
);

// --- courses ---------------------------------------------------------------
adminContentRouter.post(
  '/courses',
  handler(async (req, res) => {
    res.status(201).json({ course: await createCourse(req.body ?? {}) });
  }),
);

adminContentRouter.patch(
  '/courses/:id',
  handler(async (req, res) => {
    res.json({ course: await updateCourse(String(req.params.id), req.body ?? {}) });
  }),
);

adminContentRouter.delete(
  '/courses/:id',
  handler(async (req, res) => {
    await deleteCourse(String(req.params.id));
    res.json({ ok: true });
  }),
);

// --- modules ---------------------------------------------------------------
adminContentRouter.post(
  '/modules',
  handler(async (req, res) => {
    res.status(201).json({ module: await createModule(req.body ?? {}) });
  }),
);

adminContentRouter.patch(
  '/modules/:id',
  handler(async (req, res) => {
    res.json({ module: await updateModule(String(req.params.id), req.body ?? {}) });
  }),
);

adminContentRouter.delete(
  '/modules/:id',
  handler(async (req, res) => {
    await deleteModule(String(req.params.id));
    res.json({ ok: true });
  }),
);

// --- content items ---------------------------------------------------------

/** The full row, including content_url - the catalog view deliberately omits it. */
adminContentRouter.get(
  '/lectures/:id',
  handler(async (req, res) => {
    const lecture = await queryOne(`SELECT * FROM lectures WHERE id = $1`, [String(req.params.id)]);
    if (!lecture) {
      res.status(404).json({ error: 'lecture_not_found', message: 'No such content item.' });
      return;
    }
    res.json({ lecture });
  }),
);

adminContentRouter.post(
  '/lectures',
  handler(async (req, res) => {
    res.status(201).json({ lecture: await createLecture(req.body ?? {}) });
  }),
);

adminContentRouter.patch(
  '/lectures/:id',
  handler(async (req, res) => {
    res.json({ lecture: await updateLecture(String(req.params.id), req.body ?? {}) });
  }),
);

adminContentRouter.delete(
  '/lectures/:id',
  handler(async (req, res) => {
    await deleteLecture(String(req.params.id));
    res.json({ ok: true });
  }),
);

// --- media files -----------------------------------------------------------
adminContentRouter.get(
  '/media',
  handler(async (_req, res) => {
    res.json({ media: listMedia(), supportedExtensions: SUPPORTED_EXTENSIONS, maxBytes: env.mediaMaxUploadBytes });
  }),
);

/** Aborts the stream the moment an upload exceeds the configured ceiling. */
function sizeLimiter(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > max) {
        callback(new ContentError(413, 'file_too_large', `Files must be at most ${Math.round(max / 1048576)} MB.`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * UPLOAD  (POST /api/admin/content/media)
 *
 * The raw file is the request body and the name travels in `x-filename`, so no
 * multipart parser is needed: the bytes stream straight to disk and a 2 GB
 * video never has to be buffered in memory. It lands as `<name>.part` and is
 * renamed only after the whole stream arrives, so a cancelled upload can never
 * be attached to a lecture.
 */
adminContentRouter.post(
  '/media',
  handler(async (req, res) => {
    const original = String(req.get('x-filename') ?? '').trim();
    if (!original) {
      throw new ContentError(400, 'missing_filename', 'Send the file name in the x-filename header.');
    }
    if (!contentTypeForFilename(original)) {
      throw new ContentError(
        400,
        'unsupported_file_type',
        `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(' ')}`,
      );
    }

    // The body parsers claim application/json and text/plain. A file sent
    // under one of those would already be consumed here, and streaming it
    // would silently write an empty file - say so instead.
    if (!req.readable) {
      throw new ContentError(
        415,
        'body_already_parsed',
        'Send the file with its own content type (or application/octet-stream), not as JSON or text/plain.',
      );
    }

    const declared = Number(req.get('content-length') ?? 0);
    if (declared > env.mediaMaxUploadBytes) {
      throw new ContentError(
        413,
        'file_too_large',
        `Files must be at most ${Math.round(env.mediaMaxUploadBytes / 1048576)} MB.`,
      );
    }

    ensureMediaDir();
    const filename = uniqueMediaName(original);
    const target = join(mediaDir, filename);
    const partial = `${target}.part`;

    try {
      await pipeline(req, sizeLimiter(env.mediaMaxUploadBytes), createWriteStream(partial));
      await rename(partial, target);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }

    const [file] = listMedia().filter((m) => m.filename === filename);
    console.log(`[admin] uploaded ${filename} (${file?.sizeBytes ?? 0} bytes)`);
    res.status(201).json({ file });
  }),
);

adminContentRouter.delete(
  '/media/:filename',
  handler(async (req, res) => {
    await deleteMedia(String(req.params.filename));
    res.json({ ok: true });
  }),
);

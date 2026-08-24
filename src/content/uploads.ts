import { createWriteStream, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import { env } from '../config/env.js';
import type { ContentType } from './repository.js';

/**
 * PROVIDER-SIDE FILE UPLOADS
 * --------------------------
 * Uploaded bytes land in ./media, exactly where the seeded files live, so they
 * are served by the same signed-URL route (`/media/:filename`) and stay
 * unreachable without a validated LTI launch.
 *
 * There is no multipart parser here on purpose: the browser POSTs the File
 * object as the raw request body with `content-type: application/octet-stream`,
 * which the global express.json/urlencoded middleware ignores, so the request
 * stream arrives untouched and can be piped straight to disk. That keeps large
 * videos off the heap and keeps the dependency list unchanged.
 */
export const MEDIA_DIR = resolve(process.cwd(), 'media');

// A fresh checkout has no ./media until something is seeded into it, and
// createWriteStream will not create the parent for us.
mkdirSync(MEDIA_DIR, { recursive: true });

/** Extension -> how the player should treat it, and what to serve it as. */
const KNOWN_EXTENSIONS: Record<string, { contentType: ContentType; mimeType: string }> = {
  // video
  '.mp4': { contentType: 'video', mimeType: 'video/mp4' },
  '.m4v': { contentType: 'video', mimeType: 'video/x-m4v' },
  '.webm': { contentType: 'video', mimeType: 'video/webm' },
  '.ogv': { contentType: 'video', mimeType: 'video/ogg' },
  '.mov': { contentType: 'video', mimeType: 'video/quicktime' },
  // audio
  '.mp3': { contentType: 'audio', mimeType: 'audio/mpeg' },
  '.m4a': { contentType: 'audio', mimeType: 'audio/mp4' },
  '.aac': { contentType: 'audio', mimeType: 'audio/aac' },
  '.wav': { contentType: 'audio', mimeType: 'audio/wav' },
  '.ogg': { contentType: 'audio', mimeType: 'audio/ogg' },
  '.oga': { contentType: 'audio', mimeType: 'audio/ogg' },
  '.flac': { contentType: 'audio', mimeType: 'audio/flac' },
  // documents
  '.pdf': { contentType: 'pdf', mimeType: 'application/pdf' },
  // images (posters, diagrams). SVG is deliberately absent: it is an active
  // document, and this server hands files back on its own origin.
  '.png': { contentType: 'image', mimeType: 'image/png' },
  '.jpg': { contentType: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { contentType: 'image', mimeType: 'image/jpeg' },
  '.gif': { contentType: 'image', mimeType: 'image/gif' },
  '.webp': { contentType: 'image', mimeType: 'image/webp' },
};

export class UploadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export function acceptedUploadTypes(): { contentType: ContentType; extensions: string[] }[] {
  const grouped = new Map<ContentType, string[]>();
  for (const [ext, info] of Object.entries(KNOWN_EXTENSIONS)) {
    const list = grouped.get(info.contentType) ?? [];
    list.push(ext);
    grouped.set(info.contentType, list);
  }
  return [...grouped].map(([contentType, extensions]) => ({ contentType, extensions }));
}

/**
 * The extension decides the content type, not the browser-supplied MIME - a
 * client can claim anything, and `res.sendFile` will serve by extension anyway,
 * so the extension is the value that actually has consequences.
 */
export function classifyUpload(originalName: string): { contentType: ContentType; mimeType: string; extension: string } {
  const extension = extname(basename(originalName)).toLowerCase();
  const known = KNOWN_EXTENSIONS[extension];
  if (!known) {
    throw new UploadError(
      'unsupported_file_type',
      `"${extension || originalName}" is not an accepted file type. Allowed: ${Object.keys(KNOWN_EXTENSIONS).join(', ')}`,
    );
  }
  return { ...known, extension };
}

/** What the player should put in a <source type="..."> for an existing lecture. */
export function mimeTypeForPath(contentUrl: string): string | null {
  return KNOWN_EXTENSIONS[extname(contentUrl).toLowerCase()]?.mimeType ?? null;
}

/**
 * A readable, collision-proof name. The random suffix matters: two instructors
 * uploading "lecture-1.mp4" must not overwrite each other, and a predictable
 * name would let someone probe for files by guessing.
 */
export function safeMediaName(originalName: string, extension: string): string {
  const stem = basename(originalName, extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || 'upload'}-${randomBytes(4).toString('hex')}${extension}`;
}

/**
 * Streams the request body to ./media, aborting the moment it exceeds the
 * limit rather than buffering the whole thing first. A partial file left by a
 * failed upload is removed, so the directory only ever holds complete objects.
 */
export async function saveUploadStream(req: Request, filename: string): Promise<{ path: string; bytes: number }> {
  const maxBytes = env.mediaMaxUploadBytes;
  const maxMb = Math.round(maxBytes / 1024 / 1024);
  const declared = Number(req.get('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new UploadError('file_too_large', `File is larger than the ${maxMb} MB limit.`, 413);
  }

  const destination = join(MEDIA_DIR, filename);
  let bytes = 0;
  let overflowed = false;

  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          bytes += (chunk as Buffer).length;
          if (bytes > maxBytes) {
            overflowed = true;
            throw new UploadError('file_too_large', `File is larger than the ${maxMb} MB limit.`, 413);
          }
          yield chunk;
        }
      },
      createWriteStream(destination),
    );
  } catch (err) {
    await rm(destination, { force: true }).catch(() => undefined);
    if (overflowed || err instanceof UploadError) throw err;
    throw new UploadError('upload_failed', `Upload did not complete: ${(err as Error).message}`, 500);
  }

  if (bytes === 0) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw new UploadError('empty_file', 'The uploaded file was empty.');
  }

  return { path: `/media/${filename}`, bytes };
}

/**
 * Removes a provider-hosted file. External URLs are left alone - the provider
 * does not own them, it only points at them.
 */
export async function deleteMediaFile(contentUrl: string | null | undefined): Promise<void> {
  if (!contentUrl?.startsWith('/media/')) return;
  // basename() again: the value came out of the database, but the database is
  // not a trust boundary for a path that is about to be handed to the fs.
  await rm(join(MEDIA_DIR, basename(contentUrl)), { force: true }).catch(() => undefined);
}

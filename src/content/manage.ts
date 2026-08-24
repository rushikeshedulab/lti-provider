import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { query, queryOne } from '../db/pool.js';
import type { ContentType } from './repository.js';

/**
 * ADMIN CONTENT MANAGEMENT
 * ------------------------
 * Everything a student can ever reach is created here, by the provider's own
 * administrator. Nothing is seeded and nothing is picked on the consumer side:
 * the consumer mirrors this catalog automatically (see /api/catalog).
 */

export const mediaDir = resolve(process.cwd(), 'media');

/** Extension -> how the player must render the file. */
const EXTENSION_CONTENT_TYPE: Record<string, ContentType> = {
  '.mp4': 'video', '.m4v': 'video', '.webm': 'video', '.ogv': 'video', '.mov': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.aac': 'audio', '.oga': 'audio', '.ogg': 'audio',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_CONTENT_TYPE);

export function contentTypeForFilename(filename: string): ContentType | null {
  return EXTENSION_CONTENT_TYPE[extname(filename).toLowerCase()] ?? null;
}

export class ContentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function fail(status: number, code: string, message: string): never {
  throw new ContentError(status, code, message);
}

// ---------------------------------------------------------------------------
// Identifiers and field validation
// ---------------------------------------------------------------------------

/** Human-readable, URL-safe, collision-proof: "module-introduction-4f2a1c". */
export function slugId(prefix: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${prefix}-${slug || 'item'}-${randomBytes(3).toString('hex')}`;
}

function text(value: unknown, field: string, options: { required?: boolean; max?: number } = {}): string {
  const { required = false, max = 500 } = options;
  const str = String(value ?? '').trim();
  if (!str && required) fail(400, 'missing_field', `${field} is required.`);
  if (str.length > max) fail(400, 'field_too_long', `${field} must be at most ${max} characters.`);
  return str;
}

function int(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

// ---------------------------------------------------------------------------
// Media files (provider-hosted bytes under ./media)
// ---------------------------------------------------------------------------

export interface MediaFile {
  filename: string;
  path: string;
  contentType: ContentType | null;
  sizeBytes: number;
  modifiedAt: string;
}

export function ensureMediaDir(): void {
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
}

export function listMedia(): MediaFile[] {
  ensureMediaDir();
  return readdirSync(mediaDir)
    .filter((name) => !name.startsWith('.') && !name.endsWith('.part'))
    .map((filename) => {
      const stats = statSync(join(mediaDir, filename));
      return {
        filename,
        path: `/media/${filename}`,
        contentType: contentTypeForFilename(filename),
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Turn whatever the browser sent into a name that is safe on disk and unique
 * in ./media, so uploading two files called "lecture.mp4" never silently
 * overwrites the first one.
 */
export function uniqueMediaName(original: string): string {
  const raw = basename(original);
  const ext = extname(raw).toLowerCase();
  const stem =
    raw
      .slice(0, raw.length - ext.length)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'upload';

  ensureMediaDir();
  let candidate = `${stem}${ext}`;
  let counter = 2;
  while (existsSync(join(mediaDir, candidate))) {
    candidate = `${stem}-${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

export async function deleteMedia(filename: string): Promise<void> {
  const safe = basename(filename);
  const target = join(mediaDir, safe);
  if (!existsSync(target)) fail(404, 'file_not_found', `No such file: ${safe}`);

  const users = await query<{ id: string; title: string }>(
    `SELECT id, title FROM lectures WHERE content_url = $1 OR poster_url = $1`,
    [`/media/${safe}`],
  );
  if (users.length > 0) {
    fail(409, 'file_in_use', `Still used by: ${users.map((l) => l.title).join(', ')}. Delete those items first.`);
  }
  await rm(target);
}

// ---------------------------------------------------------------------------
// Content URLs
// ---------------------------------------------------------------------------

/**
 * Two forms are accepted: a provider-hosted file uploaded through the admin
 * panel ("/media/...", which must actually exist on disk) or an external
 * http(s) URL.
 */
function validateContentUrl(value: unknown, field: string, options: { required?: boolean } = {}): string {
  const { required = true } = options;
  const url = text(value, field, { required, max: 2000 });
  if (!url) return '';
  if (url.startsWith('/media/')) {
    const filename = basename(url);
    if (!existsSync(join(mediaDir, filename))) {
      fail(400, 'media_missing', `${field} points at /media/${filename}, which is not uploaded.`);
    }
    return `/media/${filename}`;
  }
  if (/^https?:\/\//i.test(url)) return url;
  fail(400, 'bad_content_url', `${field} must be an uploaded file (/media/...) or an http(s) URL.`);
}

function validateContentType(value: unknown, contentUrl: string): ContentType {
  const explicit = String(value ?? '').trim().toLowerCase();
  if (explicit) {
    if (!['video', 'audio', 'pdf', 'image'].includes(explicit)) {
      fail(400, 'bad_content_type', 'contentType must be video, audio, pdf or image.');
    }
    return explicit as ContentType;
  }
  const inferred = contentTypeForFilename(contentUrl);
  if (!inferred) fail(400, 'bad_content_type', 'contentType is required when it cannot be inferred from the URL.');
  return inferred;
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

export interface CourseRow {
  id: string;
  title: string;
  description: string;
  created_at: string;
}

export async function createCourse(input: Record<string, unknown>): Promise<CourseRow> {
  const title = text(input.title, 'title', { required: true, max: 200 });
  const description = text(input.description, 'description', { max: 2000 });
  const id = text(input.id, 'id', { max: 80 }) || slugId('course', title);

  if (await queryOne(`SELECT 1 FROM courses WHERE id = $1`, [id])) {
    fail(409, 'duplicate_id', `A course with id "${id}" already exists.`);
  }

  return (await queryOne<CourseRow>(
    `INSERT INTO courses (id, title, description) VALUES ($1,$2,$3) RETURNING *`,
    [id, title, description],
  ))!;
}

export async function updateCourse(id: string, input: Record<string, unknown>): Promise<CourseRow> {
  const existing = await queryOne<CourseRow>(`SELECT * FROM courses WHERE id = $1`, [id]);
  if (!existing) fail(404, 'course_not_found', `No course with id "${id}".`);

  const title = input.title === undefined ? existing.title : text(input.title, 'title', { required: true, max: 200 });
  const description =
    input.description === undefined ? existing.description : text(input.description, 'description', { max: 2000 });

  return (await queryOne<CourseRow>(
    `UPDATE courses SET title = $2, description = $3 WHERE id = $1 RETURNING *`,
    [id, title, description],
  ))!;
}

export async function deleteCourse(id: string): Promise<void> {
  const deleted = await query(`DELETE FROM courses WHERE id = $1 RETURNING id`, [id]);
  if (deleted.length === 0) fail(404, 'course_not_found', `No course with id "${id}".`);
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export interface ModuleRow {
  id: string;
  course_id: string;
  title: string;
  position: number;
  created_at: string;
}

async function nextPosition(table: 'modules' | 'lectures', parentColumn: string, parentId: string): Promise<number> {
  const row = await queryOne<{ next: number }>(
    `SELECT COALESCE(max(position), 0) + 1 AS next FROM ${table} WHERE ${parentColumn} = $1`,
    [parentId],
  );
  return row?.next ?? 1;
}

export async function createModule(input: Record<string, unknown>): Promise<ModuleRow> {
  const courseId = text(input.courseId, 'courseId', { required: true, max: 80 });
  if (!(await queryOne(`SELECT 1 FROM courses WHERE id = $1`, [courseId]))) {
    fail(404, 'course_not_found', `No course with id "${courseId}".`);
  }
  const title = text(input.title, 'title', { required: true, max: 200 });
  const id = text(input.id, 'id', { max: 80 }) || slugId('module', title);
  if (await queryOne(`SELECT 1 FROM modules WHERE id = $1`, [id])) {
    fail(409, 'duplicate_id', `A module with id "${id}" already exists.`);
  }
  const position =
    input.position === undefined ? await nextPosition('modules', 'course_id', courseId) : int(input.position);

  return (await queryOne<ModuleRow>(
    `INSERT INTO modules (id, course_id, title, position) VALUES ($1,$2,$3,$4) RETURNING *`,
    [id, courseId, title, position],
  ))!;
}

export async function updateModule(id: string, input: Record<string, unknown>): Promise<ModuleRow> {
  const existing = await queryOne<ModuleRow>(`SELECT * FROM modules WHERE id = $1`, [id]);
  if (!existing) fail(404, 'module_not_found', `No module with id "${id}".`);

  const title = input.title === undefined ? existing.title : text(input.title, 'title', { required: true, max: 200 });
  const position = input.position === undefined ? existing.position : int(input.position);
  let courseId = existing.course_id;
  if (input.courseId !== undefined) {
    courseId = text(input.courseId, 'courseId', { required: true, max: 80 });
    if (!(await queryOne(`SELECT 1 FROM courses WHERE id = $1`, [courseId]))) {
      fail(404, 'course_not_found', `No course with id "${courseId}".`);
    }
  }

  return (await queryOne<ModuleRow>(
    `UPDATE modules SET title = $2, position = $3, course_id = $4 WHERE id = $1 RETURNING *`,
    [id, title, position, courseId],
  ))!;
}

export async function deleteModule(id: string): Promise<void> {
  const deleted = await query(`DELETE FROM modules WHERE id = $1 RETURNING id`, [id]);
  if (deleted.length === 0) fail(404, 'module_not_found', `No module with id "${id}".`);
}

// ---------------------------------------------------------------------------
// Content items (rows in `lectures`, whatever the media type)
// ---------------------------------------------------------------------------

export interface LectureAdminRow {
  id: string;
  module_id: string;
  title: string;
  description: string;
  content_type: ContentType;
  content_url: string;
  poster_url: string | null;
  duration_seconds: number;
  position: number;
  created_at: string;
}

export async function createLecture(input: Record<string, unknown>): Promise<LectureAdminRow> {
  const moduleId = text(input.moduleId, 'moduleId', { required: true, max: 80 });
  if (!(await queryOne(`SELECT 1 FROM modules WHERE id = $1`, [moduleId]))) {
    fail(404, 'module_not_found', `No module with id "${moduleId}".`);
  }
  const title = text(input.title, 'title', { required: true, max: 200 });
  const description = text(input.description, 'description', { max: 2000 });
  const contentUrl = validateContentUrl(input.contentUrl, 'contentUrl');
  const contentType = validateContentType(input.contentType, contentUrl);
  const posterUrl = input.posterUrl ? validateContentUrl(input.posterUrl, 'posterUrl', { required: false }) : null;
  const id = text(input.id, 'id', { max: 80 }) || slugId('item', title);
  if (await queryOne(`SELECT 1 FROM lectures WHERE id = $1`, [id])) {
    fail(409, 'duplicate_id', `A content item with id "${id}" already exists.`);
  }
  const position =
    input.position === undefined ? await nextPosition('lectures', 'module_id', moduleId) : int(input.position);

  return (await queryOne<LectureAdminRow>(
    `INSERT INTO lectures (id, module_id, title, description, content_type, content_url, poster_url, duration_seconds, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, moduleId, title, description, contentType, contentUrl, posterUrl || null, int(input.durationSeconds), position],
  ))!;
}

export async function updateLecture(id: string, input: Record<string, unknown>): Promise<LectureAdminRow> {
  const existing = await queryOne<LectureAdminRow>(`SELECT * FROM lectures WHERE id = $1`, [id]);
  if (!existing) fail(404, 'lecture_not_found', `No content item with id "${id}".`);

  let moduleId = existing.module_id;
  if (input.moduleId !== undefined) {
    moduleId = text(input.moduleId, 'moduleId', { required: true, max: 80 });
    if (!(await queryOne(`SELECT 1 FROM modules WHERE id = $1`, [moduleId]))) {
      fail(404, 'module_not_found', `No module with id "${moduleId}".`);
    }
  }
  const title = input.title === undefined ? existing.title : text(input.title, 'title', { required: true, max: 200 });
  const description =
    input.description === undefined ? existing.description : text(input.description, 'description', { max: 2000 });
  const contentUrl =
    input.contentUrl === undefined ? existing.content_url : validateContentUrl(input.contentUrl, 'contentUrl');
  const contentType =
    input.contentType === undefined && input.contentUrl === undefined
      ? existing.content_type
      : validateContentType(input.contentType ?? existing.content_type, contentUrl);
  const posterUrl =
    input.posterUrl === undefined
      ? existing.poster_url
      : input.posterUrl
        ? validateContentUrl(input.posterUrl, 'posterUrl', { required: false })
        : null;
  const durationSeconds = input.durationSeconds === undefined ? existing.duration_seconds : int(input.durationSeconds);
  const position = input.position === undefined ? existing.position : int(input.position);

  return (await queryOne<LectureAdminRow>(
    `UPDATE lectures
        SET module_id = $2, title = $3, description = $4, content_type = $5,
            content_url = $6, poster_url = $7, duration_seconds = $8, position = $9
      WHERE id = $1 RETURNING *`,
    [id, moduleId, title, description, contentType, contentUrl, posterUrl || null, durationSeconds, position],
  ))!;
}

export async function deleteLecture(id: string): Promise<void> {
  const deleted = await query(`DELETE FROM lectures WHERE id = $1 RETURNING id`, [id]);
  if (deleted.length === 0) fail(404, 'lecture_not_found', `No content item with id "${id}".`);
}

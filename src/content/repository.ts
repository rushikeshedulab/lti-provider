import { query, queryOne } from '../db/pool.js';
import { env } from '../config/env.js';

/** What the provider's player knows how to render. */
export type ContentType = 'video' | 'audio' | 'pdf' | 'image';

/**
 * Only video and audio expose a playback timeline, so only they can report how
 * much was actually consumed. For a PDF or an image the provider can honestly
 * report presence (how long it was open) and nothing more.
 */
export function hasPlaybackTimeline(contentType: string): boolean {
  return contentType === 'video' || contentType === 'audio';
}

/** True for provider-hosted files under ./media, which need a signed URL. */
export function isSelfHosted(contentUrl: string): boolean {
  return contentUrl.startsWith('/media/');
}

/**
 * Self-hosted content is stored as a relative path so the database stays
 * portable across hosts; it is expanded against the provider's base URL, with a
 * short-lived signed token appended, only when the API hands it to a player.
 * External URLs are returned untouched.
 */
export function toDeliverableUrl(contentUrl: string, mediaToken?: string): string {
  if (!isSelfHosted(contentUrl)) return contentUrl;
  const absolute = `${env.baseUrl}${contentUrl}`;
  return mediaToken ? `${absolute}?t=${encodeURIComponent(mediaToken)}` : absolute;
}

export interface LectureRow {
  id: string;
  module_id: string;
  title: string;
  description: string;
  content_type: ContentType;
  content_url: string;
  poster_url: string | null;
  duration_seconds: number;
  position: number;
}

export interface LectureWithContext extends LectureRow {
  module_title: string;
  module_position: number;
  course_id: string;
  course_title: string;
  course_description: string;
}

const LECTURE_WITH_CONTEXT = `
  SELECT l.*,
         m.title    AS module_title,
         m.position AS module_position,
         c.id       AS course_id,
         c.title    AS course_title,
         c.description AS course_description
    FROM lectures l
    JOIN modules m ON m.id = l.module_id
    JOIN courses c ON c.id = m.course_id
`;

export function getLecture(lectureId: string) {
  return queryOne<LectureWithContext>(`${LECTURE_WITH_CONTEXT} WHERE l.id = $1`, [lectureId]);
}

export function listLectures() {
  return query<LectureWithContext>(`${LECTURE_WITH_CONTEXT} ORDER BY m.position, l.position`);
}

export interface CourseTree {
  id: string;
  title: string;
  description: string;
  modules: {
    id: string;
    title: string;
    position: number;
    lectures: {
      id: string;
      title: string;
      description: string;
      content_type: ContentType;
      duration_seconds: number;
      position: number;
    }[];
  }[];
}

/** Full catalog, used by the Deep Linking picker and the admin screens. */
export async function getCourseCatalog(): Promise<CourseTree[]> {
  const courses = await query<{ id: string; title: string; description: string }>(
    `SELECT id, title, description FROM courses ORDER BY title`,
  );
  const modules = await query<{ id: string; course_id: string; title: string; position: number }>(
    `SELECT id, course_id, title, position FROM modules ORDER BY position`,
  );
  const lectures = await query<LectureRow>(`SELECT * FROM lectures ORDER BY position`);

  return courses.map((course) => ({
    ...course,
    modules: modules
      .filter((m) => m.course_id === course.id)
      .map((m) => ({
        id: m.id,
        title: m.title,
        position: m.position,
        lectures: lectures
          .filter((l) => l.module_id === m.id)
          .map((l) => ({
            id: l.id,
            title: l.title,
            description: l.description,
            content_type: l.content_type,
            duration_seconds: l.duration_seconds,
            position: l.position,
          })),
      })),
  }));
}

// ---------------------------------------------------------------------------
// AUTHORING
// The provider owns its content, so it is also the only side that can create
// or remove it. Nothing here has an LTI counterpart: the consumer never learns
// about a lecture until an instructor picks it through Deep Linking.
// ---------------------------------------------------------------------------

/**
 * Human-readable ids, because they travel to the consumer as `custom.lecture_id`
 * and show up in its resource_links table - an opaque UUID there would make the
 * whole exchange much harder to follow.
 */
function slugId(prefix: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || 'item'}`;
}

/** Appends a numeric suffix until the id is free, so titles may repeat. */
async function uniqueId(table: 'courses' | 'modules' | 'lectures', candidate: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const id = attempt === 0 ? candidate : `${candidate}-${attempt + 1}`;
    const clash = await queryOne(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (!clash) return id;
  }
}

/** Next free position within a parent, so new items land at the end of the list. */
async function nextPosition(table: 'modules' | 'lectures', parentColumn: string, parentId: string): Promise<number> {
  const row = await queryOne<{ next: number }>(
    `SELECT COALESCE(max(position), 0) + 1 AS next FROM ${table} WHERE ${parentColumn} = $1`,
    [parentId],
  );
  return row?.next ?? 1;
}

export async function createCourse(input: { title: string; description?: string }) {
  const id = await uniqueId('courses', slugId('course', input.title));
  return queryOne<{ id: string; title: string; description: string }>(
    `INSERT INTO courses (id, title, description) VALUES ($1, $2, $3)
     RETURNING id, title, description`,
    [id, input.title, input.description ?? ''],
  );
}

export async function createModule(input: { courseId: string; title: string }) {
  const course = await queryOne(`SELECT 1 FROM courses WHERE id = $1`, [input.courseId]);
  if (!course) return null;

  const id = await uniqueId('modules', slugId('mod', input.title));
  const position = await nextPosition('modules', 'course_id', input.courseId);
  return queryOne<{ id: string; course_id: string; title: string; position: number }>(
    `INSERT INTO modules (id, course_id, title, position) VALUES ($1, $2, $3, $4)
     RETURNING id, course_id, title, position`,
    [id, input.courseId, input.title, position],
  );
}

export interface NewLecture {
  moduleId: string;
  title: string;
  description?: string;
  contentType: ContentType;
  contentUrl: string;
  posterUrl?: string | null;
  durationSeconds?: number;
}

export async function createLecture(input: NewLecture) {
  const module = await queryOne(`SELECT 1 FROM modules WHERE id = $1`, [input.moduleId]);
  if (!module) return null;

  const id = await uniqueId('lectures', slugId('lec', input.title));
  const position = await nextPosition('lectures', 'module_id', input.moduleId);
  await queryOne(
    `INSERT INTO lectures (id, module_id, title, description, content_type, content_url,
                           poster_url, duration_seconds, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.moduleId,
      input.title,
      input.description ?? '',
      input.contentType,
      input.contentUrl,
      input.posterUrl || null,
      Math.max(0, Math.round(input.durationSeconds ?? 0)),
      position,
    ],
  );
  return getLecture(id);
}

/**
 * Deleting only removes the provider's copy. Any resource link the consumer
 * already stored keeps pointing at this lecture_id and will fail its next
 * launch with `unknown_lecture` - which is the honest outcome, and exactly what
 * the launch route is written to report.
 */
export async function deleteLecture(lectureId: string) {
  return queryOne<{ id: string; content_url: string; poster_url: string | null }>(
    `DELETE FROM lectures WHERE id = $1 RETURNING id, content_url, poster_url`,
    [lectureId],
  );
}

/** Every lecture with its file details - the authoring view, not the catalog. */
export function listLecturesForAuthoring() {
  return query<LectureWithContext>(`${LECTURE_WITH_CONTEXT} ORDER BY l.created_at DESC`);
}

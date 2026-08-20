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

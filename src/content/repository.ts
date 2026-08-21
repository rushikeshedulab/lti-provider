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

/**
 * ADMIN CATALOG
 * -------------
 * The same course/module/lecture tree as `getCourseCatalog`, plus the two
 * things an operator actually wants when asking "what am I serving to the
 * consumers?": where each item's bytes come from (self-hosted vs external) and
 * how much of it has actually been delivered so far.
 *
 * Delivery counts come from the provider's own records - CONTENT_LAUNCHED rows
 * and viewing sessions - never from the consumer.
 */
export interface CatalogLectureDelivery {
  id: string;
  title: string;
  description: string;
  content_type: ContentType;
  content_url: string;
  poster_url: string | null;
  duration_seconds: number;
  position: number;
  self_hosted: boolean;
  has_playback_timeline: boolean;
  launches: number;
  students: number;
  deep_link_selections: number;
  sessions: number;
  watched_seconds: number;
  presence_seconds: number;
  last_delivered_at: string | null;
  consumers: string[];
}

export interface CatalogCourseDelivery {
  id: string;
  title: string;
  description: string;
  modules: {
    id: string;
    title: string;
    position: number;
    lectures: CatalogLectureDelivery[];
  }[];
}

interface LectureDeliveryRow extends LectureRow {
  course_id: string;
  launches: number;
  students: number;
  deep_link_selections: number;
  sessions: number;
  watched_seconds: number;
  presence_seconds: number;
  last_delivered_at: string | null;
  consumers: string[] | null;
}

const LECTURE_DELIVERY = `
  WITH launched AS (
    SELECT lecture_id,
           count(*)::int                AS launches,
           count(DISTINCT user_id)::int AS students,
           max(occurred_at)             AS last_delivered_at,
           array_agg(DISTINCT COALESCE(platform_name, platform_issuer))
             FILTER (WHERE COALESCE(platform_name, platform_issuer) IS NOT NULL) AS consumers
      FROM content_activity_logs
     WHERE event_type = 'CONTENT_LAUNCHED' AND lecture_id IS NOT NULL
     GROUP BY lecture_id
  ),
  watched AS (
    SELECT lecture_id,
           count(*)::int                         AS sessions,
           COALESCE(sum(watched_seconds), 0)::int  AS watched_seconds,
           COALESCE(sum(presence_seconds), 0)::int AS presence_seconds
      FROM viewing_sessions
     WHERE lecture_id IS NOT NULL
     GROUP BY lecture_id
  ),
  picked AS (
    SELECT sel AS lecture_id, count(*)::int AS deep_link_selections
      FROM content_activity_logs a,
           LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(a.metadata -> 'selected') = 'array'
                  THEN a.metadata -> 'selected'
                  ELSE '[]'::jsonb END) AS sel
     WHERE a.event_type = 'DEEP_LINKING_RESPONSE_SENT'
     GROUP BY sel
  )
  SELECT l.*,
         m.course_id,
         COALESCE(la.launches, 0)             AS launches,
         COALESCE(la.students, 0)             AS students,
         COALESCE(p.deep_link_selections, 0)  AS deep_link_selections,
         COALESCE(w.sessions, 0)              AS sessions,
         COALESCE(w.watched_seconds, 0)       AS watched_seconds,
         COALESCE(w.presence_seconds, 0)      AS presence_seconds,
         la.last_delivered_at,
         la.consumers
    FROM lectures l
    JOIN modules m  ON m.id = l.module_id
    LEFT JOIN launched la ON la.lecture_id = l.id
    LEFT JOIN watched  w  ON w.lecture_id  = l.id
    LEFT JOIN picked   p  ON p.lecture_id  = l.id
   ORDER BY m.position, l.position
`;

export async function getCatalogWithDelivery(): Promise<CatalogCourseDelivery[]> {
  const courses = await query<{ id: string; title: string; description: string }>(
    `SELECT id, title, description FROM courses ORDER BY title`,
  );
  const modules = await query<{ id: string; course_id: string; title: string; position: number }>(
    `SELECT id, course_id, title, position FROM modules ORDER BY position`,
  );
  const lectures = await query<LectureDeliveryRow>(LECTURE_DELIVERY);

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
            content_url: l.content_url,
            poster_url: l.poster_url,
            duration_seconds: l.duration_seconds,
            position: l.position,
            self_hosted: isSelfHosted(l.content_url),
            has_playback_timeline: hasPlaybackTimeline(l.content_type),
            launches: Number(l.launches),
            students: Number(l.students),
            deep_link_selections: Number(l.deep_link_selections),
            sessions: Number(l.sessions),
            watched_seconds: Number(l.watched_seconds),
            presence_seconds: Number(l.presence_seconds),
            last_delivered_at: l.last_delivered_at,
            consumers: l.consumers ?? [],
          })),
      })),
  }));
}

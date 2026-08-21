import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatBytes, formatDuration, readMediaDuration, uploadFile } from '../lib/api';

/**
 * CONTENT AUTHORING (provider side only)
 * --------------------------------------
 * Nothing on this screen touches LTI. It fills the provider's own catalog; the
 * consumer LMS learns a lecture exists only when an instructor picks it in the
 * Deep Linking picker, and even then it receives an id and a title, never the
 * file. The upload therefore ends at ./media on this server, behind the same
 * signed-URL route that every seeded file already uses.
 */

type ContentType = 'video' | 'audio' | 'pdf' | 'image';

interface CatalogCourse {
  id: string;
  title: string;
  description: string;
  modules: { id: string; title: string; position: number; lectures: { id: string }[] }[];
}

interface AuthoredLecture {
  id: string;
  title: string;
  description: string;
  contentType: ContentType;
  contentUrl: string;
  selfHosted: boolean;
  posterUrl: string | null;
  durationSeconds: number;
  moduleId: string;
  moduleTitle: string;
  courseId: string;
  courseTitle: string;
}

interface CatalogResponse {
  catalog: CatalogCourse[];
  lectures: AuthoredLecture[];
  limits: { maxUploadMb: number; acceptedTypes: { contentType: ContentType; extensions: string[] }[] };
}

const NEW = '__new__';

const TYPE_BADGE: Record<ContentType, string> = {
  video: 'badge accent',
  audio: 'badge good',
  pdf: 'badge warn',
  image: 'badge',
};

/** "understanding-stock-markets.mp4" -> "Understanding Stock Markets" */
function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function typeFromUrl(url: string): ContentType {
  const ext = (url.split('?')[0].match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
  if (['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.flac'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  return 'video';
}

export default function ContentManager({ token }: { token: string }) {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [source, setSource] = useState<'upload' | 'url'>('upload');

  const [file, setFile] = useState<File | null>(null);
  const [poster, setPoster] = useState<File | null>(null);
  const [externalUrl, setExternalUrl] = useState('');
  const [externalType, setExternalType] = useState<ContentType>('video');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(0);

  const [courseId, setCourseId] = useState('');
  const [moduleId, setModuleId] = useState('');
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newModuleTitle, setNewModuleTitle] = useState('');

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const posterInput = useRef<HTMLInputElement>(null);

  const authed = useCallback(
    <T,>(path: string, options: RequestInit = {}) =>
      api<T>(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) } }),
    [token],
  );

  const load = useCallback(async () => {
    try {
      setData(await authed<CatalogResponse>('/api/admin/content/catalog'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [authed]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = useMemo(
    () => (data?.limits.acceptedTypes ?? []).flatMap((t) => t.extensions).join(','),
    [data],
  );
  const course = data?.catalog.find((c) => c.id === courseId);
  const contentType: ContentType = source === 'upload' ? (file ? typeFromUrl(file.name) : 'video') : externalType;

  // Selecting a course that has exactly one module is almost always a choice of
  // that module too, so make it rather than leaving the form half-filled.
  useEffect(() => {
    if (courseId === NEW) return setModuleId(NEW);
    setModuleId(course?.modules.length === 1 ? course.modules[0].id : '');
  }, [courseId, course]);

  const pickFile = async (chosen: File | null) => {
    setFile(chosen);
    setError(null);
    if (!chosen) return setDurationSeconds(0);
    if (!title.trim()) setTitle(titleFromFilename(chosen.name));
    const maxBytes = (data?.limits.maxUploadMb ?? 512) * 1024 * 1024;
    if (chosen.size > maxBytes) {
      setError(`${chosen.name} is ${formatBytes(chosen.size)} - the limit is ${data?.limits.maxUploadMb} MB.`);
    }
    setDurationSeconds(await readMediaDuration(chosen));
  };

  const reset = () => {
    setFile(null);
    setPoster(null);
    setExternalUrl('');
    setTitle('');
    setDescription('');
    setDurationSeconds(0);
    setNewCourseTitle('');
    setNewModuleTitle('');
    setProgress(0);
    setStage('');
    if (fileInput.current) fileInput.current.value = '';
    if (posterInput.current) posterInput.current.value = '';
  };

  const publish = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setDone(null);

    if (!title.trim()) return setError('Give the lecture a title.');
    if (source === 'upload' && !file) return setError('Choose a file to upload.');
    if (source === 'url' && !/^https?:\/\//i.test(externalUrl.trim())) {
      return setError('An external link must start with http:// or https://');
    }
    if (!courseId) return setError('Choose a course.');
    if (courseId === NEW && !newCourseTitle.trim()) return setError('Name the new course.');
    if (!moduleId) return setError('Choose a module.');
    if (moduleId === NEW && !newModuleTitle.trim()) return setError('Name the new module.');

    setBusy(true);
    let uploadedPath: string | null = null;
    let uploadedPoster: string | null = null;

    try {
      // 1. Container first, so a successful upload always has somewhere to go.
      let targetCourseId = courseId;
      if (courseId === NEW) {
        setStage('Creating course…');
        const created = await authed<{ course: { id: string } }>('/api/admin/content/courses', {
          method: 'POST',
          body: JSON.stringify({ title: newCourseTitle.trim() }),
        });
        targetCourseId = created.course.id;
      }

      let targetModuleId = moduleId;
      if (moduleId === NEW) {
        setStage('Creating module…');
        const created = await authed<{ module: { id: string } }>('/api/admin/content/modules', {
          method: 'POST',
          body: JSON.stringify({ courseId: targetCourseId, title: newModuleTitle.trim() }),
        });
        targetModuleId = created.module.id;
      }

      // 2. Bytes.
      let contentUrl = externalUrl.trim();
      let resolvedType: ContentType = externalType;

      if (source === 'upload' && file) {
        setStage(`Uploading ${file.name}…`);
        const uploaded = await uploadFile(file, token, setProgress);
        uploadedPath = uploaded.path;
        contentUrl = uploaded.path;
        resolvedType = uploaded.contentType;
      }

      if (poster) {
        setStage('Uploading poster…');
        setProgress(0);
        const uploaded = await uploadFile(poster, token, setProgress);
        uploadedPoster = uploaded.path;
      }

      // 3. The row that makes it launchable.
      setStage('Publishing lecture…');
      const created = await authed<{ lecture: { id: string; title: string } }>('/api/admin/content/lectures', {
        method: 'POST',
        body: JSON.stringify({
          moduleId: targetModuleId,
          title: title.trim(),
          description: description.trim(),
          contentType: resolvedType,
          contentUrl,
          posterUrl: uploadedPoster,
          durationSeconds,
        }),
      });

      setDone(`"${created.lecture.title}" is live as ${created.lecture.id}. Instructors can now add it via Deep Linking.`);
      reset();
      await load();
    } catch (err) {
      setError((err as Error).message);
      // A file with no lecture row is invisible but still occupies disk, so put
      // it back rather than leaving it orphaned.
      for (const orphan of [uploadedPath, uploadedPoster].filter(Boolean)) {
        await authed('/api/admin/content/upload', {
          method: 'DELETE',
          body: JSON.stringify({ path: orphan }),
        }).catch(() => undefined);
      }
    } finally {
      setBusy(false);
      setStage('');
      setProgress(0);
    }
  };

  const remove = async (lecture: AuthoredLecture) => {
    const warning =
      `Delete "${lecture.title}"?\n\n` +
      (lecture.selfHosted ? 'The uploaded file will be deleted from the provider too.\n\n' : '') +
      'Any resource link a consumer already stored will start failing with "unknown_lecture".';
    if (!window.confirm(warning)) return;
    try {
      await authed(`/api/admin/content/lectures/${encodeURIComponent(lecture.id)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) {
    return (
      <div className="card">
        <div className="empty">Loading catalog…</div>
      </div>
    );
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>Add content</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Files are stored on this provider and served only through a validated LTI launch. The consumer LMS
          never receives the file - only the lecture id, once an instructor selects it via Deep Linking.
        </p>

        <form onSubmit={publish}>
          <div className="row" style={{ marginBottom: 14, gap: 6 }}>
            <button
              type="button"
              className={source === 'upload' ? 'small' : 'secondary small'}
              onClick={() => setSource('upload')}
            >
              Upload a file
            </button>
            <button
              type="button"
              className={source === 'url' ? 'small' : 'secondary small'}
              onClick={() => setSource('url')}
            >
              Link an external URL
            </button>
          </div>

          {source === 'upload' ? (
            <div className="field">
              <label htmlFor="file">
                Video, audio, PDF or image &middot; up to {data.limits.maxUploadMb} MB
              </label>
              <input
                id="file"
                ref={fileInput}
                type="file"
                accept={accept}
                disabled={busy}
                onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
              />
              {file && (
                <p className="muted small" style={{ margin: '8px 0 0' }}>
                  <span className={TYPE_BADGE[contentType]}>{contentType}</span> {formatBytes(file.size)}
                  {durationSeconds > 0 && <> &middot; {formatDuration(durationSeconds)}</>}
                </p>
              )}
              <p className="muted small" style={{ margin: '8px 0 0' }}>
                Accepted: {accept.replace(/,/g, ' ')}
              </p>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="url">Content URL</label>
                <input
                  id="url"
                  value={externalUrl}
                  disabled={busy}
                  placeholder="https://cdn.example.com/lecture.mp4"
                  onChange={(e) => {
                    setExternalUrl(e.target.value);
                    setExternalType(typeFromUrl(e.target.value));
                    if (!title.trim()) {
                      const last = e.target.value.split('/').pop();
                      if (last) setTitle(titleFromFilename(last));
                    }
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor="ext-type">Content type</label>
                <select
                  id="ext-type"
                  value={externalType}
                  disabled={busy}
                  onChange={(e) => setExternalType(e.target.value as ContentType)}
                >
                  <option value="video">Video</option>
                  <option value="audio">Audio</option>
                  <option value="pdf">PDF document</option>
                  <option value="image">Image</option>
                </select>
              </div>
              <div className="notice warn" style={{ marginBottom: 14 }}>
                An external URL is served by whoever hosts it, so it is reachable without an LTI launch and the
                provider cannot enforce access on it. Uploaded files get a signed, per-launch URL instead.
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="title">Lecture title</label>
            <input id="title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="description">Description</label>
            <input
              id="description"
              value={description}
              disabled={busy}
              placeholder="Shown in the Deep Linking picker and in the player"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid two">
            <div className="field">
              <label htmlFor="course">Course</label>
              <select id="course" value={courseId} disabled={busy} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">Choose a course…</option>
                {data.catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
                <option value={NEW}>+ New course…</option>
              </select>
              {courseId === NEW && (
                <input
                  style={{ marginTop: 8 }}
                  value={newCourseTitle}
                  disabled={busy}
                  placeholder="New course title"
                  onChange={(e) => setNewCourseTitle(e.target.value)}
                />
              )}
            </div>

            <div className="field">
              <label htmlFor="module">Module</label>
              <select
                id="module"
                value={moduleId}
                disabled={busy || !courseId}
                onChange={(e) => setModuleId(e.target.value)}
              >
                <option value="">{courseId ? 'Choose a module…' : 'Choose a course first'}</option>
                {(course?.modules ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
                {courseId && <option value={NEW}>+ New module…</option>}
              </select>
              {moduleId === NEW && (
                <input
                  style={{ marginTop: 8 }}
                  value={newModuleTitle}
                  disabled={busy}
                  placeholder="New module title"
                  onChange={(e) => setNewModuleTitle(e.target.value)}
                />
              )}
            </div>
          </div>

          {contentType === 'video' && (
            <div className="field">
              <label htmlFor="poster">Poster image (optional)</label>
              <input
                id="poster"
                ref={posterInput}
                type="file"
                accept=".png,.jpg,.jpeg,.gif,.webp"
                disabled={busy}
                onChange={(e) => setPoster(e.target.files?.[0] ?? null)}
              />
            </div>
          )}

          {error && <div className="notice bad" style={{ marginBottom: 12 }}>{error}</div>}
          {done && <div className="notice good" style={{ marginBottom: 12 }}>{done}</div>}

          {busy && (
            <div style={{ marginBottom: 12 }}>
              <p className="muted small" style={{ margin: '0 0 6px' }}>
                {stage} {progress > 0 && `${progress}%`}
              </p>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${progress}%`,
                    background: 'var(--accent)',
                    transition: 'width .15s linear',
                  }}
                />
              </div>
            </div>
          )}

          <div className="row">
            <button type="submit" disabled={busy}>
              {busy ? 'Working…' : 'Publish lecture'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={reset}>
              Clear
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Catalog</h2>
          <span className="muted small">{data.lectures.length} lectures</span>
          <button className="secondary small" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
            Refresh
          </button>
        </div>

        {data.lectures.length === 0 ? (
          <div className="empty">No lectures yet. Upload one above.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lecture</th>
                  <th>Course / module</th>
                  <th>Type</th>
                  <th>Duration</th>
                  <th>Source</th>
                  <th>lecture_id</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.lectures.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <div>{l.title}</div>
                      {l.description && (
                        <div className="muted small" style={{ marginTop: 2 }}>
                          {l.description}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {l.courseTitle}
                      <div className="muted">{l.moduleTitle}</div>
                    </td>
                    <td>
                      <span className={TYPE_BADGE[l.contentType]}>{l.contentType}</span>
                    </td>
                    <td className="small">{l.durationSeconds ? formatDuration(l.durationSeconds) : '-'}</td>
                    <td className="small">
                      <span className={l.selfHosted ? 'badge good' : 'badge'}>
                        {l.selfHosted ? 'self-hosted' : 'external'}
                      </span>
                      <div className="mono muted" style={{ marginTop: 3, maxWidth: 260, wordBreak: 'break-all' }}>
                        {l.contentUrl}
                      </div>
                    </td>
                    <td className="mono">{l.id}</td>
                    <td>
                      <button className="secondary small" onClick={() => void remove(l)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
          <code>lecture_id</code> is the only part of a row the consumer ever stores. It travels back on every
          launch inside the <code>custom</code> claim, which is how a launch resolves to this content.
        </p>
      </div>
    </>
  );
}

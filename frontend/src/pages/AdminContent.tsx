import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatDuration, formatTime } from '../lib/api';

/**
 * ADMIN CONTENT PANEL
 * -------------------
 * The one place course content is created. Everything saved here is published
 * to every registered consumer automatically - no instructor picks anything on
 * the LMS side, so an upload here is a lecture there.
 */

export type ContentType = 'video' | 'audio' | 'pdf' | 'image';

interface Item {
  id: string;
  title: string;
  description: string;
  content_type: ContentType;
  duration_seconds: number;
  position: number;
}
interface Module {
  id: string;
  title: string;
  position: number;
  lectures: Item[];
}
interface Course {
  id: string;
  title: string;
  description: string;
  modules: Module[];
}
interface MediaFile {
  filename: string;
  path: string;
  contentType: ContentType | null;
  sizeBytes: number;
  modifiedAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Raw-body upload with progress. XHR, because fetch cannot report it. */
function uploadMedia(token: string, file: File, onProgress: (percent: number) => void): Promise<MediaFile> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/admin/content/media');
    request.setRequestHeader('authorization', `Bearer ${token}`);
    request.setRequestHeader('x-filename', encodeURIComponent(file.name).replace(/%20/g, ' '));
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let body: { file?: MediaFile; message?: string; error?: string } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        /* keep the empty object; the status code below is what matters */
      }
      if (request.status >= 200 && request.status < 300 && body.file) resolve(body.file);
      else reject(new Error(body.message ?? body.error ?? `Upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error('Upload failed: the connection dropped.'));
    request.send(file);
  });
}

const EMPTY_ITEM = {
  id: '',
  title: '',
  description: '',
  contentType: '' as ContentType | '',
  contentUrl: '',
  posterUrl: '',
  durationSeconds: '',
};
type ItemDraft = typeof EMPTY_ITEM;

export default function AdminContent({ token }: { token: string }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newCourse, setNewCourse] = useState({ title: '', description: '' });
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [newModuleFor, setNewModuleFor] = useState<string | null>(null);
  const [newModuleTitle, setNewModuleTitle] = useState('');
  const [itemFormFor, setItemFormFor] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState<ItemDraft>(EMPTY_ITEM);
  const [saving, setSaving] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const authed = useCallback(
    <T,>(path: string, options: RequestInit = {}) =>
      api<T>(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) } }),
    [token],
  );

  const load = useCallback(async () => {
    try {
      const data = await authed<{ courses: Course[]; media: MediaFile[] }>('/api/admin/content');
      setCourses(data.courses);
      setMedia(data.media);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [authed]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 4000);
  };

  const run = async (action: () => Promise<unknown>, message: string) => {
    setSaving(true);
    setError(null);
    try {
      await action();
      await load();
      flash(message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // --- courses -------------------------------------------------------------
  const createCourse = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await authed('/api/admin/content/courses', { method: 'POST', body: JSON.stringify(newCourse) });
      setNewCourse({ title: '', description: '' });
      setShowCourseForm(false);
    }, 'Course created. It is already live on the consumer LMS.');
  };

  const renameCourse = (course: Course) => {
    const title = window.prompt('Course title', course.title);
    if (title === null || title.trim() === course.title) return;
    void run(
      () =>
        authed(`/api/admin/content/courses/${encodeURIComponent(course.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        }),
      'Course renamed.',
    );
  };

  const removeCourse = (course: Course) => {
    const items = course.modules.reduce((total, m) => total + m.lectures.length, 0);
    if (
      !window.confirm(
        `Delete "${course.title}" with ${course.modules.length} module(s) and ${items} item(s)?\n\n` +
          'It disappears from every consumer LMS on their next sync. Uploaded files are kept.',
      )
    ) {
      return;
    }
    void run(
      () => authed(`/api/admin/content/courses/${encodeURIComponent(course.id)}`, { method: 'DELETE' }),
      'Course deleted.',
    );
  };

  // --- modules -------------------------------------------------------------
  const createModule = (event: React.FormEvent, courseId: string) => {
    event.preventDefault();
    void run(async () => {
      await authed('/api/admin/content/modules', {
        method: 'POST',
        body: JSON.stringify({ courseId, title: newModuleTitle }),
      });
      setNewModuleTitle('');
      setNewModuleFor(null);
    }, 'Module added.');
  };

  const renameModule = (module: Module) => {
    const title = window.prompt('Module title', module.title);
    if (title === null || title.trim() === module.title) return;
    void run(
      () =>
        authed(`/api/admin/content/modules/${encodeURIComponent(module.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        }),
      'Module renamed.',
    );
  };

  const removeModule = (module: Module) => {
    if (!window.confirm(`Delete "${module.title}" and its ${module.lectures.length} item(s)?`)) return;
    void run(
      () => authed(`/api/admin/content/modules/${encodeURIComponent(module.id)}`, { method: 'DELETE' }),
      'Module deleted.',
    );
  };

  // --- content items -------------------------------------------------------
  const openNewItem = (moduleId: string) => {
    setItemFormFor(moduleId);
    setItemDraft(EMPTY_ITEM);
    setUploadPercent(null);
  };

  const openEditItem = async (moduleId: string, item: Item) => {
    setItemFormFor(moduleId);
    setUploadPercent(null);
    // The catalog view omits URLs, so read the full row before editing it.
    try {
      const full = await authed<{ lecture: Record<string, string> }>(
        `/api/admin/content/lectures/${encodeURIComponent(item.id)}`,
      ).catch(() => null);
      setItemDraft({
        id: item.id,
        title: item.title,
        description: item.description,
        contentType: item.content_type,
        contentUrl: full?.lecture?.content_url ?? '',
        posterUrl: full?.lecture?.poster_url ?? '',
        durationSeconds: String(item.duration_seconds || ''),
      });
    } catch {
      setError('Could not load that item.');
    }
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploadPercent(0);
    try {
      const uploaded = await uploadMedia(token, file, setUploadPercent);
      setMedia((current) => [uploaded, ...current.filter((m) => m.filename !== uploaded.filename)]);
      setItemDraft((draft) => ({
        ...draft,
        contentUrl: uploaded.path,
        contentType: draft.contentType || uploaded.contentType || '',
        title: draft.title || file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
      }));
      flash(`${uploaded.filename} uploaded.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadPercent(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const saveItem = (event: React.FormEvent, moduleId: string) => {
    event.preventDefault();
    const payload = {
      moduleId,
      title: itemDraft.title,
      description: itemDraft.description,
      contentType: itemDraft.contentType || undefined,
      contentUrl: itemDraft.contentUrl,
      posterUrl: itemDraft.posterUrl,
      durationSeconds: Number(itemDraft.durationSeconds) || 0,
    };
    const editing = Boolean(itemDraft.id);
    void run(async () => {
      await authed(
        editing ? `/api/admin/content/lectures/${encodeURIComponent(itemDraft.id)}` : '/api/admin/content/lectures',
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      setItemFormFor(null);
      setItemDraft(EMPTY_ITEM);
    }, editing ? 'Item updated. Consumers pick it up within a minute.' : 'Item published. It is live on the consumer LMS.');
  };

  const removeItem = (item: Item) => {
    if (!window.confirm(`Delete "${item.title}"? It disappears from every consumer LMS.`)) return;
    void run(
      () => authed(`/api/admin/content/lectures/${encodeURIComponent(item.id)}`, { method: 'DELETE' }),
      'Item deleted.',
    );
  };

  const removeMedia = (file: MediaFile) => {
    if (!window.confirm(`Permanently delete the file ${file.filename}?`)) return;
    void run(
      () => authed(`/api/admin/content/media/${encodeURIComponent(file.filename)}`, { method: 'DELETE' }),
      'File deleted.',
    );
  };

  const totals = useMemo(() => {
    const modules = courses.reduce((sum, c) => sum + c.modules.length, 0);
    const items = courses.reduce((sum, c) => sum + c.modules.reduce((n, m) => n + m.lectures.length, 0), 0);
    return { courses: courses.length, modules, items };
  }, [courses]);

  if (loading) return <div className="card empty">Loading content…</div>;

  return (
    <>
      <div className="grid stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Courses</div>
          <div className="value">{totals.courses}</div>
        </div>
        <div className="stat">
          <div className="label">Modules</div>
          <div className="value">{totals.modules}</div>
        </div>
        <div className="stat">
          <div className="label">Content items</div>
          <div className="value">{totals.items}</div>
        </div>
        <div className="stat">
          <div className="label">Uploaded files</div>
          <div className="value">{media.length}</div>
        </div>
      </div>

      {error && (
        <div className="notice bad" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="notice good" style={{ marginBottom: 14 }}>
          {notice}
        </div>
      )}

      <div className="notice" style={{ marginBottom: 18 }}>
        Everything you publish here is mirrored by every registered consumer LMS automatically - nobody on that side
        selects it. The files themselves never leave this server: students always reach them through a validated LTI
        1.3 launch.
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <button onClick={() => setShowCourseForm((open) => !open)} disabled={saving}>
          {showCourseForm ? 'Cancel' : 'New course'}
        </button>
        <button className="secondary small" onClick={() => void load()} disabled={saving}>
          Reload
        </button>
      </div>

      {showCourseForm && (
        <div className="card">
          <h2>New course</h2>
          <form onSubmit={createCourse}>
            <div className="field">
              <label htmlFor="course-title">Title</label>
              <input
                id="course-title"
                value={newCourse.title}
                onChange={(e) => setNewCourse({ ...newCourse, title: e.target.value })}
                placeholder="Introduction to Financial Markets"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="course-description">Description</label>
              <textarea
                id="course-description"
                rows={3}
                value={newCourse.description}
                onChange={(e) => setNewCourse({ ...newCourse, description: e.target.value })}
                placeholder="What this course covers."
              />
            </div>
            <button type="submit" disabled={saving}>
              Create course
            </button>
          </form>
        </div>
      )}

      {courses.length === 0 && !showCourseForm && (
        <div className="card empty">
          No content yet. Create a course, add a module to it, then upload your files into that module.
        </div>
      )}

      {courses.map((course) => (
        <div className="card" key={course.id}>
          <div className="row">
            <div style={{ flex: 1, minWidth: 240 }}>
              <h2 style={{ marginBottom: 4 }}>{course.title}</h2>
              <div className="muted small">{course.description || 'No description.'}</div>
              <div className="mono small muted" style={{ marginTop: 4 }}>
                {course.id}
              </div>
            </div>
            <button className="secondary small" onClick={() => renameCourse(course)} disabled={saving}>
              Rename
            </button>
            <button className="secondary small" onClick={() => removeCourse(course)} disabled={saving}>
              Delete
            </button>
          </div>

          {course.modules.map((module) => (
            <div
              key={module.id}
              style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12 }}
            >
              <div className="row">
                <strong style={{ flex: 1, minWidth: 200 }}>{module.title}</strong>
                <button className="secondary small" onClick={() => openNewItem(module.id)} disabled={saving}>
                  Add content
                </button>
                <button className="secondary small" onClick={() => renameModule(module)} disabled={saving}>
                  Rename
                </button>
                <button className="secondary small" onClick={() => removeModule(module)} disabled={saving}>
                  Delete
                </button>
              </div>

              {module.lectures.length === 0 && (
                <p className="muted small" style={{ margin: '8px 0 0' }}>
                  Nothing in this module yet.
                </p>
              )}

              {module.lectures.map((item) => (
                <div
                  key={item.id}
                  className="row"
                  style={{ padding: '9px 0', borderBottom: '1px dashed var(--border)' }}
                >
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <strong>{item.title}</strong>{' '}
                    <span className="badge accent">{item.content_type}</span>{' '}
                    {item.duration_seconds > 0 && (
                      <span className="badge">{formatDuration(item.duration_seconds)}</span>
                    )}
                    {item.description && (
                      <>
                        <br />
                        <span className="muted small">{item.description}</span>
                      </>
                    )}
                    <br />
                    <span className="mono small muted">{item.id}</span>
                  </div>
                  <button
                    className="secondary small"
                    onClick={() => void openEditItem(module.id, item)}
                    disabled={saving}
                  >
                    Edit
                  </button>
                  <button className="secondary small" onClick={() => removeItem(item)} disabled={saving}>
                    Delete
                  </button>
                </div>
              ))}

              {itemFormFor === module.id && (
                <form onSubmit={(e) => saveItem(e, module.id)} style={{ marginTop: 14 }}>
                  <h3>{itemDraft.id ? 'Edit content item' : 'New content item'}</h3>

                  <div className="field">
                    <label htmlFor="item-file">Upload a file (video, audio, PDF or image)</label>
                    <input
                      id="item-file"
                      type="file"
                      ref={fileInput}
                      accept="video/*,audio/*,application/pdf,image/*"
                      onChange={(e) => void chooseFile(e.target.files?.[0])}
                      disabled={uploadPercent !== null}
                    />
                    {uploadPercent !== null && (
                      <div className="muted small" style={{ marginTop: 6 }}>
                        Uploading… {uploadPercent}%
                      </div>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="item-url">…or pick an uploaded file / paste an external URL</label>
                    <select
                      id="item-url"
                      value={media.some((m) => m.path === itemDraft.contentUrl) ? itemDraft.contentUrl : ''}
                      onChange={(e) => {
                        const path = e.target.value;
                        const file = media.find((m) => m.path === path);
                        setItemDraft((draft) => ({
                          ...draft,
                          contentUrl: path,
                          contentType: file?.contentType ?? draft.contentType,
                        }));
                      }}
                    >
                      <option value="">- uploaded files -</option>
                      {media.map((file) => (
                        <option key={file.filename} value={file.path}>
                          {file.filename} ({formatBytes(file.sizeBytes)})
                        </option>
                      ))}
                    </select>
                    <input
                      style={{ marginTop: 8 }}
                      value={itemDraft.contentUrl}
                      onChange={(e) => setItemDraft({ ...itemDraft, contentUrl: e.target.value })}
                      placeholder="/media/my-lecture.mp4 or https://example.com/video.mp4"
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="item-title">Title</label>
                    <input
                      id="item-title"
                      value={itemDraft.title}
                      onChange={(e) => setItemDraft({ ...itemDraft, title: e.target.value })}
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="item-description">Description</label>
                    <textarea
                      id="item-description"
                      rows={2}
                      value={itemDraft.description}
                      onChange={(e) => setItemDraft({ ...itemDraft, description: e.target.value })}
                    />
                  </div>

                  <div className="grid two">
                    <div className="field">
                      <label htmlFor="item-type">Content type</label>
                      <select
                        id="item-type"
                        value={itemDraft.contentType}
                        onChange={(e) =>
                          setItemDraft({ ...itemDraft, contentType: e.target.value as ContentType | '' })
                        }
                        required
                      >
                        <option value="">- choose -</option>
                        <option value="video">video</option>
                        <option value="audio">audio</option>
                        <option value="pdf">pdf</option>
                        <option value="image">image</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="item-duration">Duration in seconds (video/audio, optional)</label>
                      <input
                        id="item-duration"
                        inputMode="numeric"
                        value={itemDraft.durationSeconds}
                        onChange={(e) => setItemDraft({ ...itemDraft, durationSeconds: e.target.value })}
                        placeholder="0"
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="item-poster">Poster image URL (video only, optional)</label>
                    <input
                      id="item-poster"
                      value={itemDraft.posterUrl}
                      onChange={(e) => setItemDraft({ ...itemDraft, posterUrl: e.target.value })}
                      placeholder="/media/poster.jpg"
                    />
                  </div>

                  <div className="row">
                    <button type="submit" disabled={saving || uploadPercent !== null}>
                      {itemDraft.id ? 'Save changes' : 'Publish item'}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setItemFormFor(null);
                        setItemDraft(EMPTY_ITEM);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          ))}

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12 }}>
            {newModuleFor === course.id ? (
              <form className="row" onSubmit={(e) => createModule(e, course.id)}>
                <input
                  style={{ flex: 1, minWidth: 220 }}
                  value={newModuleTitle}
                  onChange={(e) => setNewModuleTitle(e.target.value)}
                  placeholder="Module 1: Introduction"
                  required
                  autoFocus
                />
                <button type="submit" disabled={saving}>
                  Add module
                </button>
                <button type="button" className="secondary" onClick={() => setNewModuleFor(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <button
                className="secondary small"
                onClick={() => {
                  setNewModuleFor(course.id);
                  setNewModuleTitle('');
                }}
                disabled={saving}
              >
                Add module
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="card">
        <h2>Uploaded files</h2>
        <p className="muted small">
          Stored in this server&rsquo;s <span className="mono">./media</span> directory and streamed from here with
          HTTP Range support, behind a short-lived signed URL issued only after a valid launch.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {media.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    Nothing uploaded yet.
                  </td>
                </tr>
              )}
              {media.map((file) => (
                <tr key={file.filename}>
                  <td className="mono small">{file.path}</td>
                  <td>
                    <span className="badge">{file.contentType ?? 'unknown'}</span>
                  </td>
                  <td className="small">{formatBytes(file.sizeBytes)}</td>
                  <td className="small">{formatTime(file.modifiedAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="secondary small" onClick={() => removeMedia(file)} disabled={saving}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

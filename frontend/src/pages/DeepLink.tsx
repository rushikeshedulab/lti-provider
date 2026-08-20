import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

interface CatalogLecture {
  id: string;
  title: string;
  description: string;
  content_type: 'video' | 'audio' | 'pdf' | 'image';
  duration_seconds: number;
}
interface CatalogModule {
  id: string;
  title: string;
  lectures: CatalogLecture[];
}
interface CatalogCourse {
  id: string;
  title: string;
  description: string;
  modules: CatalogModule[];
}

interface ContextResponse {
  deepLinkSessionToken: string;
  catalog: CatalogCourse[];
  launch: {
    platformIssuer: string;
    platformName: string | null;
    deploymentId: string;
    user: { name: string | null; email: string | null; roles: string[] };
    acceptMultiple: boolean;
  };
}

/**
 * Deep Linking content picker.
 *
 * This is the screen an instructor on the consumer LMS sees after an
 * LtiDeepLinkingRequest. Whatever they select is returned to the platform as a
 * SIGNED LtiDeepLinkingResponse - the consumer stores links, never content.
 */
export default function DeepLink() {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const lt = new URLSearchParams(window.location.search).get('lt');
    if (!lt) {
      setError('No deep linking handle in the URL.');
      return;
    }
    window.history.replaceState({}, '', '/deep-link');

    api<ContextResponse>('/api/deep-link/context', { method: 'POST', body: JSON.stringify({ lt }) })
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!data || selected.length === 0) return;
    setSubmitting(true);
    try {
      const result = await api<{ jwt: string; returnUrl: string }>('/api/deep-link/response', {
        method: 'POST',
        body: JSON.stringify({ deepLinkSessionToken: data.deepLinkSessionToken, lectureIds: selected }),
      });
      // The response travels back to the platform as a browser form POST,
      // exactly as the Deep Linking spec requires.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = result.returnUrl;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'JWT';
      field.value = result.jwt;
      form.appendChild(field);
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  if (error) {
    return (
      <div className="page narrow">
        <div className="card">
          <h1>Content selection unavailable</h1>
          <p className="muted">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page narrow">
        <div className="card empty">Validating Deep Linking request…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card">
        <span className="badge accent">LtiDeepLinkingRequest</span>
        <h1 style={{ marginTop: 10 }}>Select content to add</h1>
        <p className="subtitle" style={{ marginBottom: 0 }}>
          Requested by {data.launch.user.name ?? 'an instructor'} on{' '}
          <span className="mono">{data.launch.platformIssuer}</span>. The consumer will store only a resource link
          per selection - titles and ids, never the videos.
        </p>
      </div>

      {data.catalog.map((course) => (
        <div className="card" key={course.id}>
          <h2>{course.title}</h2>
          <p className="muted small">{course.description}</p>
          {course.modules.map((module) => (
            <div key={module.id} style={{ marginTop: 14 }}>
              <h3>{module.title}</h3>
              {module.lectures.map((lecture) => (
                <label
                  key={lecture.id}
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'flex-start',
                    padding: '8px 0',
                    borderBottom: '1px dashed var(--border)',
                    color: 'inherit',
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 'auto', marginTop: 3 }}
                    checked={selected.includes(lecture.id)}
                    onChange={() => toggle(lecture.id)}
                  />
                  <span>
                    <strong>{lecture.title}</strong>
                    <br />
                    <span className="muted small">{lecture.description}</span>
                    <br />
                    <span className="badge">{lecture.id}</span>{' '}
                    <span className="badge accent">{lecture.content_type}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      ))}

      <div className="card row">
        <button onClick={submit} disabled={selected.length === 0 || submitting}>
          {submitting ? 'Returning to LMS…' : `Add ${selected.length} lecture${selected.length === 1 ? '' : 's'}`}
        </button>
        <span className="muted small">Signs an LtiDeepLinkingResponse JWT and form-POSTs it to the platform.</span>
      </div>
    </div>
  );
}

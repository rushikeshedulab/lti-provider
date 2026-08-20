import { useCallback, useEffect, useState } from 'react';
import { api, formatDuration, formatTime } from '../lib/api';

interface ActivityRow {
  id: string;
  event_type: string;
  occurred_at: string;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  platform_issuer: string | null;
  platform_name: string | null;
  platform_client_id: string | null;
  deployment_id: string | null;
  course_id: string | null;
  course_name: string | null;
  module_name: string | null;
  lecture_id: string | null;
  lecture_name: string | null;
  launch_id: string | null;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  session_started_at: string | null;
  session_ended_at: string | null;
  session_presence_seconds: number | null;
  session_watched_seconds: number | null;
  session_end_reason: string | null;
}

interface SessionRow {
  id: string;
  launch_id: string;
  user_email: string | null;
  user_name: string | null;
  platform_issuer: string;
  platform_name: string | null;
  deployment_id: string;
  course_name: string | null;
  module_name: string | null;
  lecture_name: string | null;
  started_at: string;
  ended_at: string | null;
  presence_seconds: number;
  watched_seconds: number;
  end_reason: string | null;
}

interface Summary {
  totals: Record<string, string>;
  perStudent: {
    user_email: string | null;
    user_name: string | null;
    sessions: string;
    presence_seconds: string;
    watched_seconds: string;
    last_seen: string;
  }[];
  perLecture: { id: string; title: string; module_title: string; sessions: string; watched_seconds: string }[];
}

interface Registrations {
  tool: Record<string, unknown>;
  platforms: {
    id: number;
    name: string;
    issuer: string;
    client_id: string;
    deployment_ids: string[];
    auth_login_url: string;
    auth_token_url: string;
    jwks_url: string;
  }[];
}

const TOKEN_KEY = 'provider-admin-token';
const EVENTS = [
  'CONTENT_LAUNCHED',
  'CONTENT_VIEW_STARTED',
  'CONTENT_VIEW_ENDED',
  'DEEP_LINKING_REQUESTED',
  'DEEP_LINKING_RESPONSE_SENT',
  'LAUNCH_REJECTED',
];

function eventBadge(event: string): string {
  if (event === 'CONTENT_VIEW_STARTED') return 'badge good';
  if (event === 'CONTENT_VIEW_ENDED') return 'badge';
  if (event === 'LAUNCH_REJECTED') return 'badge bad';
  if (event.startsWith('DEEP_LINKING')) return 'badge warn';
  return 'badge accent';
}

export default function Admin() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const [tab, setTab] = useState<'activity' | 'sessions' | 'students' | 'registration'>('activity');
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [registrations, setRegistrations] = useState<Registrations | null>(null);
  const [eventFilter, setEventFilter] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const authed = useCallback(
    <T,>(path: string) => api<T>(path, { headers: { authorization: `Bearer ${token}` } }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const params = new URLSearchParams();
      if (eventFilter) params.set('event', eventFilter);
      if (emailFilter) params.set('email', emailFilter);
      const [a, s, sum] = await Promise.all([
        authed<{ rows: ActivityRow[] }>(`/api/admin/activity?${params.toString()}`),
        authed<{ rows: SessionRow[] }>('/api/admin/sessions'),
        authed<Summary>('/api/admin/summary'),
      ]);
      setActivity(a.rows);
      setSessions(s.rows);
      setSummary(sum);
    } catch (err) {
      if ((err as Error).message.includes('unauthorised')) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }
    }
  }, [authed, token, eventFilter, emailFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh || !token) return;
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, load, token]);

  useEffect(() => {
    if (tab === 'registration' && token && !registrations) {
      authed<Registrations>('/api/admin/registrations').then(setRegistrations).catch(() => undefined);
    }
  }, [tab, token, registrations, authed]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      const result = await api<{ token: string }>('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      sessionStorage.setItem(TOKEN_KEY, result.token);
      setToken(result.token);
    } catch {
      setLoginError('Incorrect password.');
    }
  };

  if (!token) {
    return (
      <div className="page narrow">
        <div className="card">
          <h1>Provider admin</h1>
          <p className="subtitle">Activity logs for every LTI launch and viewing session.</p>
          <form onSubmit={login}>
            <div className="field">
              <label htmlFor="pw">Admin password</label>
              <input
                id="pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="set by ADMIN_PASSWORD"
                autoFocus
              />
            </div>
            {loginError && <div className="notice bad" style={{ marginBottom: 12 }}>{loginError}</div>}
            <button type="submit">Sign in</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>Content activity</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Every row here was produced by this provider - launches from LTI, durations from the player.
          </p>
        </div>
        <div style={{ marginLeft: 'auto' }} className="row">
          <label className="row small" style={{ margin: 0, gap: 6 }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ width: 'auto' }}
            />
            auto-refresh
          </label>
          <button className="secondary small" onClick={() => void load()}>
            Refresh
          </button>
          <button
            className="secondary small"
            onClick={() => {
              sessionStorage.removeItem(TOKEN_KEY);
              setToken(null);
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {summary && (
        <div className="grid stats" style={{ marginBottom: 18 }}>
          <div className="stat">
            <div className="label">LTI launches</div>
            <div className="value">{summary.totals.launches}</div>
          </div>
          <div className="stat">
            <div className="label">Viewing sessions</div>
            <div className="value">{summary.totals.sessions}</div>
          </div>
          <div className="stat">
            <div className="label">Currently open</div>
            <div className="value">{summary.totals.open_sessions}</div>
          </div>
          <div className="stat">
            <div className="label">Total watched</div>
            <div className="value">{formatDuration(Number(summary.totals.total_watched_seconds))}</div>
          </div>
          <div className="stat">
            <div className="label">Students</div>
            <div className="value">{summary.totals.distinct_students}</div>
          </div>
          <div className="stat">
            <div className="label">Consumers</div>
            <div className="value">{summary.totals.distinct_platforms}</div>
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        {(['activity', 'sessions', 'students', 'registration'] as const).map((t) => (
          <button key={t} className={tab === t ? 'small' : 'secondary small'} onClick={() => setTab(t)}>
            {t === 'activity' && 'Activity log'}
            {t === 'sessions' && 'Viewing sessions'}
            {t === 'students' && 'Per student / lecture'}
            {t === 'registration' && 'LTI registration'}
          </button>
        ))}
      </div>

      {tab === 'activity' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <div style={{ minWidth: 220 }}>
              <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value)}>
                <option value="">All events</option>
                {EVENTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ minWidth: 240 }}>
              <input
                placeholder="Filter by student email"
                value={emailFilter}
                onChange={(e) => setEmailFilter(e.target.value)}
              />
            </div>
            <span className="muted small">{activity.length} events</span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Course</th>
                  <th>Lecture</th>
                  <th>Event</th>
                  <th>Start time</th>
                  <th>End time</th>
                  <th>Duration</th>
                  <th>Consumer platform</th>
                  <th>Launch id</th>
                </tr>
              </thead>
              <tbody>
                {activity.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      No activity yet. Launch a lecture from the consumer LMS.
                    </td>
                  </tr>
                )}
                {activity.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      {row.user_name ?? '-'}
                      <br />
                      <span className="muted small">{row.user_email ?? row.user_id ?? '-'}</span>
                    </td>
                    <td>{row.course_name ?? '-'}</td>
                    <td>
                      {row.lecture_name ?? '-'}
                      {row.module_name && (
                        <>
                          <br />
                          <span className="muted small">{row.module_name}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <span className={eventBadge(row.event_type)}>{row.event_type}</span>
                      {expanded === row.id && (
                        <pre className="mono small" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                          {JSON.stringify(
                            { ip: row.ip_address, userAgent: row.user_agent, metadata: row.metadata },
                            null,
                            2,
                          )}
                        </pre>
                      )}
                    </td>
                    <td className="small">{formatTime(row.session_started_at ?? row.occurred_at)}</td>
                    <td className="small">{row.session_ended_at ? formatTime(row.session_ended_at) : '-'}</td>
                    <td className="small">
                      {row.session_presence_seconds !== null ? (
                        <>
                          {formatDuration(row.session_presence_seconds)}
                          <br />
                          <span className="muted">watched {formatDuration(row.session_watched_seconds)}</span>
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="small">
                      {row.platform_name ?? '-'}
                      <br />
                      <span className="muted mono">{row.platform_issuer ?? '-'}</span>
                    </td>
                    <td className="mono small">{row.launch_id?.slice(0, 8) ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginBottom: 0, marginTop: 10 }}>
            Click a row to see IP, user agent and event metadata.
          </p>
        </div>
      )}

      {tab === 'sessions' && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Lecture</th>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>On page</th>
                  <th>Video watched</th>
                  <th>Closed by</th>
                  <th>Consumer</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="empty">
                      No viewing sessions yet.
                    </td>
                  </tr>
                )}
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.user_name ?? '-'}
                      <br />
                      <span className="muted small">{s.user_email}</span>
                    </td>
                    <td>
                      {s.lecture_name ?? '-'}
                      <br />
                      <span className="muted small">{s.course_name}</span>
                    </td>
                    <td className="small">{formatTime(s.started_at)}</td>
                    <td className="small">
                      {s.ended_at ? formatTime(s.ended_at) : <span className="badge good">open</span>}
                    </td>
                    <td>{formatDuration(s.presence_seconds)}</td>
                    <td>{formatDuration(s.watched_seconds)}</td>
                    <td>
                      <span className="badge">{s.end_reason ?? 'in progress'}</span>
                    </td>
                    <td className="small mono">{s.platform_issuer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'students' && summary && (
        <div className="grid two">
          <div className="card">
            <h2>Total viewing time per student</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Sessions</th>
                    <th>On page</th>
                    <th>Watched</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.perStudent.length === 0 && (
                    <tr>
                      <td colSpan={5} className="empty">
                        No data yet.
                      </td>
                    </tr>
                  )}
                  {summary.perStudent.map((s, i) => (
                    <tr key={i}>
                      <td>
                        {s.user_name ?? '-'}
                        <br />
                        <span className="muted small">{s.user_email}</span>
                      </td>
                      <td>{s.sessions}</td>
                      <td>{formatDuration(Number(s.presence_seconds))}</td>
                      <td>{formatDuration(Number(s.watched_seconds))}</td>
                      <td className="small">{formatTime(s.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2>Per lecture</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Lecture</th>
                    <th>Sessions</th>
                    <th>Watched</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.perLecture.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.title}
                        <br />
                        <span className="muted small">{l.module_title}</span>
                      </td>
                      <td>{l.sessions}</td>
                      <td>{formatDuration(Number(l.watched_seconds))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'registration' && (
        <div className="grid two">
          <div className="card">
            <h2>This tool</h2>
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(registrations?.tool ?? {}, null, 2)}
            </pre>
          </div>
          <div className="card">
            <h2>Trusted platforms</h2>
            {registrations?.platforms.map((p) => (
              <dl className="kv" key={p.id} style={{ marginBottom: 16 }}>
                <dt>Name</dt>
                <dd>{p.name}</dd>
                <dt>Issuer</dt>
                <dd className="mono">{p.issuer}</dd>
                <dt>client_id</dt>
                <dd className="mono">{p.client_id}</dd>
                <dt>deployment_ids</dt>
                <dd className="mono">{p.deployment_ids.join(', ')}</dd>
                <dt>Auth endpoint</dt>
                <dd className="mono">{p.auth_login_url}</dd>
                <dt>Token endpoint</dt>
                <dd className="mono">{p.auth_token_url}</dd>
                <dt>Platform JWKS</dt>
                <dd className="mono">{p.jwks_url}</dd>
              </dl>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

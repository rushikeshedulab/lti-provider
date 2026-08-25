import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, formatTime } from '../lib/api';

/**
 * PLATFORM CONNECTIONS
 * --------------------
 * Connecting a new LMS is meant to cost two pasted values: the client_id and
 * deployment_id its administrator generated. Everything else - the issuer, the
 * authorization and token endpoints, the key set - is read from the LMS itself,
 * so nothing here requires an environment change or a restart.
 *
 * A saved connection is usable straight away - there is no approval step. The
 * status simply reports whether a launch has actually arrived through it, which
 * is how you tell a working connection from one that merely saved cleanly.
 *
 * When a launch misbehaves, "Test" checks the endpoints against the live
 * platform and says whether the fault is this configuration or the platform
 * asking its own user to sign in.
 */

interface Deployment {
  deploymentId: string;
  activated: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
  activatedByEmail: string | null;
  contextTitle: string | null;
}

// NOTE: these interfaces are hand-copied from the server. Connection mirrors
// connectionView() in src/routes/admin.routes.ts; Discovered and Diagnosis
// mirror src/services/platformDiscovery.ts. There is no shared types package -
// the frontend build imports nothing from src/ - so they must be moved together.
interface Connection {
  id: number;
  name: string;
  issuer: string;
  clientId: string;
  authLoginUrl: string;
  authTokenUrl: string | null;
  jwksUrl: string;
  /** The document these endpoints are re-read from. Null = entered by hand. */
  discoveryUrl: string | null;
  discoverySource: string | null;
  discoveryFetchedAt: string | null;
  discoveryError: string | null;
  toolRedirectUri: string;
  isActive: boolean;
  createdVia: string;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deployments: Deployment[];
}

interface ToolDocument {
  oidc_initiation_url?: string;
  target_link_uri?: string;
  redirect_uris?: string[];
  public_jwk_url?: string;
  key_id?: string;
  [key: string]: unknown;
}

interface EndpointReport {
  url: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  verdict: string;
  detail: string;
}

interface EndpointFailure {
  field: 'issuer' | 'authLoginUrl' | 'authTokenUrl' | 'jwksUrl';
  code: string;
  message: string;
}

interface Validation {
  ok: boolean;
  jwks: { ok: boolean; keys: number; error?: string };
  authorization: EndpointReport;
  token: EndpointReport | null;
  failures: EndpointFailure[];
  warnings: string[];
}

interface Diagnosis extends Validation {
  issuerMismatch: { saved: string; published: string } | null;
  notes: string[];
}

/** One address discovery tried, and what it actually served. */
interface DiscoveryAttempt {
  url: string;
  reason: string;
  detail: string;
}

interface Discovered {
  name: string | null;
  issuer: string | null;
  discoveryUrl: string | null;
  // Null when nothing could be confirmed. The form leaves the field empty rather
  // than offering a path borrowed from a different LMS.
  authLoginUrl: string | null;
  authTokenUrl: string | null;
  jwksUrl: string | null;
  source: string;
  suggestedClientId: string | null;
  suggestedDeploymentId: string | null;
  warning: string | null;
  attempts: DiscoveryAttempt[];
}

const EMPTY_FORM = {
  url: '',
  clientId: '',
  deploymentId: '',
  name: '',
  issuer: '',
  authLoginUrl: '',
  authTokenUrl: '',
  jwksUrl: '',
  discoveryUrl: '',
  notes: '',
};
type FormState = typeof EMPTY_FORM;

/** The endpoint half of the form. One declaration drives inputs and error slots. */
const ENDPOINT_FIELDS: { key: keyof FormState; label: string; hint?: string }[] = [
  { key: 'issuer', label: 'Issuer (iss)', hint: 'Must match the `iss` the LMS sends, character for character.' },
  { key: 'authLoginUrl', label: 'Authorization endpoint' },
  { key: 'authTokenUrl', label: 'Token endpoint', hint: 'Optional - only LTI Advantage service calls need it.' },
  { key: 'jwksUrl', label: 'JWKS URL' },
  {
    key: 'discoveryUrl',
    label: 'Discovery document URL',
    hint: 'When set, the three endpoints above are re-read from this document automatically. Leave blank to keep them fixed.',
  },
];

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted small">{label}</div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <code className="mono small" style={{ flex: 1, wordBreak: 'break-all' }}>
          {value}
        </code>
        <button
          type="button"
          className="secondary small"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export default function Connections({ token }: { token: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [tool, setTool] = useState<ToolDocument | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Which fields the server rejected, so the message sits under the offending
  // input instead of in one flat banner at the top.
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [newDeployment, setNewDeployment] = useState<Record<number, string>>({});
  const [diagnosis, setDiagnosis] = useState<Record<number, Diagnosis>>({});
  const [editing, setEditing] = useState<Record<number, Partial<Connection>>>({});

  const authed = useCallback(
    <T,>(path: string, options: RequestInit = {}) =>
      api<T>(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) } }),
    [token],
  );

  const load = useCallback(async () => {
    const result = await authed<{ connections: Connection[]; tool: ToolDocument }>('/api/admin/connections');
    setConnections(result.connections);
    setTool(result.tool);
  }, [authed]);

  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  /** Fills in everything except the two ids, by reading the LMS's own config. */
  const discover = async () => {
    setError(null);
    setNotice(null);
    setDiscovering(true);
    try {
      const result = await authed<{ discovered: Discovered; jwks: { ok: boolean; keys: number; error?: string } }>(
        '/api/admin/connections/discover',
        { method: 'POST', body: JSON.stringify({ url: form.url }) },
      );
      const found = result.discovered;
      setDiscovered(found);
      setFieldErrors({});

      // Nothing was published. The fields stay EMPTY on purpose: filling them
      // with a plausible-looking guess is what produced a saved connection that
      // launched into a path the LMS does not serve. The attempts table below
      // shows what each address actually answered.
      if (found.source === 'none') {
        set({ issuer: '', authLoginUrl: '', authTokenUrl: '', jwksUrl: '', discoveryUrl: '' });
        setShowAdvanced(true);
        return;
      }

      set({
        issuer: found.issuer ?? '',
        authLoginUrl: found.authLoginUrl ?? '',
        authTokenUrl: found.authTokenUrl ?? '',
        jwksUrl: found.jwksUrl ?? '',
        discoveryUrl: found.discoveryUrl ?? '',
        name: form.name || found.name || '',
        // Only offered as a convenience when the LMS publishes them; the
        // administrator is still expected to paste the real values.
        clientId: form.clientId || found.suggestedClientId || '',
        deploymentId: form.deploymentId || found.suggestedDeploymentId || '',
      });
      setNotice(
        result.jwks.ok
          ? `Read ${found.source} and found ${result.jwks.keys} signing key(s).` +
              (found.discoveryUrl ? ' These endpoints will be re-read from that document automatically.' : '')
          : `Endpoints filled in from ${found.source}, but the key set could not be read.`,
      );
      if (!result.jwks.ok || found.warning) setShowAdvanced(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const save = async (event: React.FormEvent, saveSuspended = false) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setFieldErrors({});
    setSaving(true);
    try {
      const result = await authed<{ connection: Connection; notice?: string }>('/api/admin/connections', {
        method: 'POST',
        body: JSON.stringify({ ...form, saveSuspended }),
      });
      setForm(EMPTY_FORM);
      setDiscovered(null);
      setShowAdvanced(false);
      setNotice(result.notice ?? 'Connection saved. Launch it from the LMS to confirm it works end to end.');
      await load();
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      // The server says which endpoint is wrong and why; show it where the
      // administrator can act on it.
      const validation = err.body?.validation as Validation | undefined;
      if (validation?.failures?.length) {
        setFieldErrors(Object.fromEntries(validation.failures.map((f) => [f.field, f.message])));
        setShowAdvanced(true);
      }
      if (err.code === 'discovery_failed') {
        setDiscovered({
          name: null,
          issuer: null,
          discoveryUrl: null,
          authLoginUrl: null,
          authTokenUrl: null,
          jwksUrl: null,
          source: 'none',
          suggestedClientId: null,
          suggestedDeploymentId: null,
          warning: err.message,
          attempts: (err.body?.attempts as DiscoveryAttempt[]) ?? [],
        });
        setShowAdvanced(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const act = async (run: () => Promise<unknown>, message?: string) => {
    setError(null);
    setNotice(null);
    try {
      await run();
      if (message) setNotice(message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const statusBadge = (connection: Connection) => {
    if (!connection.isActive) return <span className="badge bad">suspended</span>;
    if (connection.status === 'active') return <span className="badge good">launching</span>;
    return <span className="badge">no launch yet</span>;
  };

  return (
    <div>
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

      <div className="grid two">
        {/* ---------------------------------------------------------------- */}
        <div className="card">
          <h2>Connect an LMS</h2>
          <p className="muted small">
            Ask the LMS administrator to generate a <span className="mono">client_id</span> and a{' '}
            <span className="mono">deployment_id</span> for this tool, then paste them here. The address is only used
            to read the endpoints the LMS publishes, so nothing has to be configured on the server.
          </p>

          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="url">LMS address</label>
              <div className="row" style={{ gap: 8 }}>
                <input
                  id="url"
                  value={form.url}
                  onChange={(e) => set({ url: e.target.value })}
                  placeholder="https://lms.example.edu"
                  style={{ flex: 1 }}
                />
                <button type="button" className="secondary" onClick={discover} disabled={!form.url || discovering}>
                  {discovering ? 'Reading…' : 'Read config'}
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="clientId">client_id</label>
              <input
                id="clientId"
                className="mono"
                value={form.clientId}
                onChange={(e) => set({ clientId: e.target.value })}
                placeholder="generated by the LMS"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="deploymentId">deployment_id</label>
              <input
                id="deploymentId"
                className="mono"
                value={form.deploymentId}
                onChange={(e) => set({ deploymentId: e.target.value })}
                placeholder="generated by the LMS"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="name">Display name (optional)</label>
              <input
                id="name"
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="taken from the LMS if left blank"
              />
            </div>

            {discovered && discovered.source !== 'none' && (
              <div className={discovered.warning ? 'notice warn' : 'notice'} style={{ marginBottom: 12 }}>
                {discovered.warning ?? (
                  <>
                    Endpoints read from <span className="mono">{discovered.source}</span>.
                  </>
                )}
              </div>
            )}

            {/*
              Nothing was published. This panel is the difference between
              "discovery failed" and an administrator who can actually fix it:
              it names every address tried and what each one served, so a
              front-end answering HTTP 200 text/html reads as the cause rather
              than looking like a working endpoint.
            */}
            {discovered && discovered.source === 'none' && (
              <div className="notice bad" style={{ marginBottom: 12 }}>
                <strong>This LMS publishes no LTI configuration.</strong>
                <p style={{ margin: '6px 0' }}>{discovered.warning}</p>
                <p style={{ margin: '6px 0' }}>
                  Ask the LMS administrator for its authorization endpoint, token endpoint and JWKS URL, and
                  enter them under <em>Show endpoints</em>. They are normally on the LMS's own
                  tool-registration screen.
                </p>
                {discovered.attempts.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="small">
                      What each address served ({discovered.attempts.length} tried)
                    </summary>
                    <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                      {discovered.attempts.map((attempt) => (
                        <li key={attempt.url} style={{ marginBottom: 6 }}>
                          <span className="mono">{attempt.url}</span>
                          <br />
                          <span className="muted">
                            {attempt.reason} - {attempt.detail}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <button type="button" className="secondary small" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? 'Hide endpoints' : 'Show endpoints'}
            </button>

            {showAdvanced && (
              <div style={{ marginTop: 12 }}>
                <p className="muted small">
                  Read from the address above where the LMS publishes them. Correct any of them if this LMS
                  uses different paths. Every one is checked against the LMS before the connection is saved.
                </p>
                {ENDPOINT_FIELDS.map(({ key, label, hint }) => (
                  <div className="field" key={key}>
                    <label htmlFor={key}>{label}</label>
                    <input
                      id={key}
                      className="mono"
                      value={form[key]}
                      onChange={(e) => set({ [key]: e.target.value } as Partial<FormState>)}
                      aria-invalid={Boolean(fieldErrors[key])}
                      style={fieldErrors[key] ? { borderColor: '#c0392b' } : undefined}
                    />
                    {fieldErrors[key] ? (
                      <p className="small" style={{ color: '#c0392b', margin: '4px 0 0' }}>
                        {fieldErrors[key]}
                      </p>
                    ) : hint ? (
                      <p className="muted small" style={{ margin: '4px 0 0' }}>
                        {hint}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 14 }} className="row">
              <button type="submit" disabled={saving || !form.clientId || !form.deploymentId}>
                {saving ? 'Saving…' : 'Save connection'}
              </button>
              {/*
                The honest replacement for "save even if the key set cannot be
                read", which used to store a connection that looked like it
                worked and failed every launch. This one is stored suspended,
                so it cannot serve a launch until somebody resumes it.
              */}
              {showAdvanced && !form.url && (
                <button
                  type="button"
                  className="secondary small"
                  disabled={saving || !form.clientId || !form.deploymentId}
                  onClick={(e) => void save(e, true)}
                  title="Stores the connection without verifying its endpoints. It stays suspended until you resume it."
                >
                  Save suspended (LMS not reachable yet)
                </button>
              )}
            </div>
          </form>
        </div>

        {/* ---------------------------------------------------------------- */}
        <div className="card">
          <h2>Give the LMS these</h2>
          <p className="muted small">
            The other half of the registration. Its administrator needs these values to create the developer key that
            produces the two ids.
          </p>
          <CopyField label="OIDC login initiation URL" value={String(tool?.oidc_initiation_url ?? '')} />
          <CopyField label="Redirect URI" value={(tool?.redirect_uris ?? []).join(', ')} />
          <CopyField label="Target link URI" value={String(tool?.target_link_uri ?? '')} />
          <CopyField label="Public JWKS URL" value={String(tool?.public_jwk_url ?? '')} />
          <CopyField label="Key id" value={String(tool?.key_id ?? '')} />
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      <div className="card" style={{ marginTop: 18 }}>
        <h2>Connected platforms</h2>
        {connections.length === 0 && <p className="muted small">No LMS is connected yet.</p>}

        {connections.map((connection) => (
          <div
            key={connection.id}
            style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}
          >
            <div className="row" style={{ marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <strong>{connection.name}</strong> {statusBadge(connection)}{' '}
                <span className="badge">{connection.createdVia === 'admin' ? 'added here' : 'from config'}</span>
                <br />
                <span className="muted small mono">{connection.issuer}</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="secondary small"
                  onClick={() =>
                    act(async () => {
                      const result = await authed<{ diagnosis: Diagnosis }>(
                        `/api/admin/connections/${connection.id}/test`,
                        { method: 'POST' },
                      );
                      setDiagnosis((d) => ({ ...d, [connection.id]: result.diagnosis }));
                    })
                  }
                >
                  Test
                </button>
                <button
                  className="secondary small"
                  onClick={() =>
                    setEditing((e) =>
                      connection.id in e
                        ? Object.fromEntries(Object.entries(e).filter(([k]) => Number(k) !== connection.id))
                        : { ...e, [connection.id]: { ...connection } },
                    )
                  }
                >
                  {connection.id in editing ? 'Cancel' : 'Edit endpoints'}
                </button>
                <button
                  className="secondary small"
                  onClick={() =>
                    act(
                      () =>
                        authed(`/api/admin/connections/${connection.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ isActive: !connection.isActive }),
                        }),
                      connection.isActive ? 'Connection suspended.' : 'Connection resumed.',
                    )
                  }
                >
                  {connection.isActive ? 'Suspend' : 'Resume'}
                </button>
                <button
                  className="secondary small"
                  onClick={() => {
                    if (
                      !confirm(
                        `Delete the connection to ${connection.name}? ` +
                          `Only a connection that has never been launched can be deleted - suspend it otherwise.`,
                      )
                    ) {
                      return;
                    }
                    void act(
                      () => authed(`/api/admin/connections/${connection.id}`, { method: 'DELETE' }),
                      'Connection deleted.',
                    );
                  }}
                >
                  Delete
                </button>
              </div>
            </div>

            {connection.id in editing ? (
              <div style={{ marginBottom: 12 }}>
                <p className="muted small">
                  Correct these to match what the LMS actually publishes. The issuer must equal the{' '}
                  <span className="mono">iss</span> it sends, character for character.
                </p>
                {(
                  [
                    ['issuer', 'Issuer (iss)'],
                    ['authLoginUrl', 'Authorization endpoint'],
                    ['authTokenUrl', 'Token endpoint'],
                    ['jwksUrl', 'JWKS URL'],
                    // Blank it to stop re-reading and pin the three above.
                    ['discoveryUrl', 'Discovery document URL (blank = endpoints stay fixed)'],
                  ] as const
                ).map(([field, label]) => (
                  <div className="field" key={field}>
                    <label htmlFor={`${field}-${connection.id}`}>{label}</label>
                    <input
                      id={`${field}-${connection.id}`}
                      className="mono"
                      value={String(editing[connection.id]?.[field] ?? '')}
                      onChange={(e) =>
                        setEditing((prev) => ({
                          ...prev,
                          [connection.id]: { ...prev[connection.id], [field]: e.target.value },
                        }))
                      }
                    />
                  </div>
                ))}
                <button
                  className="small"
                  onClick={() =>
                    act(async () => {
                      await authed(`/api/admin/connections/${connection.id}/endpoints`, {
                        method: 'PATCH',
                        body: JSON.stringify(editing[connection.id]),
                      });
                      setEditing((e) =>
                        Object.fromEntries(Object.entries(e).filter(([k]) => Number(k) !== connection.id)),
                      );
                    }, 'Endpoints updated.')
                  }
                >
                  Save endpoints
                </button>
              </div>
            ) : (
              <dl className="kv" style={{ marginBottom: 10 }}>
                <dt>client_id</dt>
                <dd className="mono">{connection.clientId}</dd>
                <dt>Authorization</dt>
                <dd className="mono small">{connection.authLoginUrl}</dd>
                <dt>Token</dt>
                <dd className="mono small">{connection.authTokenUrl}</dd>
                <dt>JWKS</dt>
                <dd className="mono small">{connection.jwksUrl}</dd>
                {/*
                  Where those three URLs came from, and how current they are.
                  Without this the connection reads as static configuration even
                  when it is being re-read from the LMS on a timer.
                */}
                <dt>Endpoints</dt>
                <dd className="small">
                  {connection.discoveryUrl ? (
                    <>
                      re-read from <span className="mono">{connection.discoverySource ?? 'discovery'}</span>,
                      last {formatTime(connection.discoveryFetchedAt)}
                      <br />
                      <span className="muted mono">{connection.discoveryUrl}</span>
                    </>
                  ) : (
                    <span className="muted">entered by hand - not re-read automatically</span>
                  )}
                  {connection.discoveryError && (
                    <>
                      <br />
                      <span className="badge bad" title={connection.discoveryError}>
                        stale
                      </span>{' '}
                      <span className="muted">{connection.discoveryError}</span>
                    </>
                  )}
                </dd>
              </dl>
            )}

            {diagnosis[connection.id] && (
              <div
                className={
                  diagnosis[connection.id]!.issuerMismatch ||
                  !diagnosis[connection.id]!.jwks.ok ||
                  !diagnosis[connection.id]!.authorization.ok
                    ? 'notice bad'
                    : 'notice good'
                }
                style={{ marginBottom: 10 }}
              >
                <div style={{ marginBottom: 6 }}>
                  <strong>Key set</strong>{' '}
                  {diagnosis[connection.id]!.jwks.ok
                    ? `${diagnosis[connection.id]!.jwks.keys} signing key(s)`
                    : (diagnosis[connection.id]!.jwks.error ?? 'unreadable')}
                </div>
                <div style={{ marginBottom: 6 }}>
                  <strong>Authorization endpoint</strong> {diagnosis[connection.id]!.authorization.detail}
                </div>
                <div style={{ marginBottom: 6 }}>
                  {/* Null when the platform publishes no token endpoint at all -
                      legitimate, and not the same thing as a broken one. */}
                  <strong>Token endpoint</strong>{' '}
                  {diagnosis[connection.id]!.token?.detail ?? 'not published by this platform'}
                </div>
                {diagnosis[connection.id]!.notes.map((note) => (
                  <div className="small" key={note} style={{ marginTop: 4 }}>
                    {note}
                  </div>
                ))}
              </div>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>deployment_id</th>
                    <th>Status</th>
                    <th>First launch</th>
                    <th>Course</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {connection.deployments.map((deployment) => (
                    <tr key={deployment.deploymentId}>
                      <td className="mono small">{deployment.deploymentId}</td>
                      <td>
                        {deployment.activated ? (
                          <span className="badge good">in use</span>
                        ) : (
                          <span className="badge">not launched yet</span>
                        )}
                      </td>
                      <td className="small">
                        {deployment.activated ? (
                          <>
                            {deployment.activatedBy ?? 'unknown user'}
                            <br />
                            <span className="muted">{formatTime(deployment.activatedAt)}</span>
                          </>
                        ) : (
                          <span className="muted">not yet</span>
                        )}
                      </td>
                      <td className="small">{deployment.contextTitle ?? <span className="muted">-</span>}</td>
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          {deployment.activated && (
                            <button
                              className="secondary small"
                              title="Forget the first-launch record"
                              onClick={() =>
                                act(
                                  () =>
                                    authed(`/api/admin/connections/${connection.id}/reset-activation`, {
                                      method: 'POST',
                                      body: JSON.stringify({ deploymentId: deployment.deploymentId }),
                                    }),
                                  'First-launch record cleared.',
                                )
                              }
                            >
                              Reset
                            </button>
                          )}
                          {connection.deployments.length > 1 && (
                            <button
                              className="secondary small"
                              onClick={() =>
                                act(
                                  () =>
                                    authed(
                                      `/api/admin/connections/${connection.id}/deployments/${encodeURIComponent(
                                        deployment.deploymentId,
                                      )}`,
                                      { method: 'DELETE' },
                                    ),
                                  'Deployment removed.',
                                )
                              }
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <input
                className="mono"
                placeholder="add another deployment_id"
                value={newDeployment[connection.id] ?? ''}
                onChange={(e) => setNewDeployment((d) => ({ ...d, [connection.id]: e.target.value }))}
                style={{ maxWidth: 320 }}
              />
              <button
                className="secondary small"
                disabled={!newDeployment[connection.id]}
                onClick={() =>
                  act(async () => {
                    await authed(`/api/admin/connections/${connection.id}/deployments`, {
                      method: 'POST',
                      body: JSON.stringify({ deploymentId: newDeployment[connection.id] }),
                    });
                    setNewDeployment((d) => ({ ...d, [connection.id]: '' }));
                  }, 'Deployment added.')
                }
              >
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

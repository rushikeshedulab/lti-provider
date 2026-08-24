import { useCallback, useEffect, useState } from 'react';
import { api, formatTime } from '../lib/api';

/**
 * PLATFORM CONNECTIONS
 * --------------------
 * Connecting a new LMS is meant to cost two pasted values: the client_id and
 * deployment_id its administrator generated. Everything else - the issuer, the
 * authorization and token endpoints, the key set - is read from the LMS itself,
 * so nothing here requires an environment change or a restart.
 *
 * A saved connection is not usable yet. It stays 'pending' until an instructor
 * completes one launch through it, which is the only step that can confirm the
 * deployment really points at the right course. The gate itself lives in the
 * launch endpoint; this screen only shows its state.
 */

interface Deployment {
  deploymentId: string;
  activated: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
  activatedByEmail: string | null;
  contextTitle: string | null;
  reportedToPlatform: boolean;
}

interface Connection {
  id: number;
  name: string;
  issuer: string;
  clientId: string;
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
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

interface Discovered {
  name: string | null;
  issuer: string;
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
  source: string;
  suggestedClientId: string | null;
  suggestedDeploymentId: string | null;
  warning: string | null;
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
  notes: '',
};
type FormState = typeof EMPTY_FORM;

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
  const [ignoreJwksCheck, setIgnoreJwksCheck] = useState(false);
  const [newDeployment, setNewDeployment] = useState<Record<number, string>>({});

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
      setDiscovered(result.discovered);
      set({
        issuer: result.discovered.issuer,
        authLoginUrl: result.discovered.authLoginUrl,
        authTokenUrl: result.discovered.authTokenUrl,
        jwksUrl: result.discovered.jwksUrl,
        name: form.name || result.discovered.name || '',
        // Only offered as a convenience when the LMS publishes them; the
        // administrator is still expected to paste the real values.
        clientId: form.clientId || result.discovered.suggestedClientId || '',
        deploymentId: form.deploymentId || result.discovered.suggestedDeploymentId || '',
      });
      setNotice(
        result.jwks.ok
          ? `Read ${result.discovered.source} and found ${result.jwks.keys} signing key(s).`
          : `Endpoints filled in from ${result.discovered.source}, but the key set could not be read.`,
      );
      if (!result.jwks.ok || result.discovered.warning) setShowAdvanced(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      await authed<{ connection: Connection }>('/api/admin/connections', {
        method: 'POST',
        body: JSON.stringify({ ...form, ignoreJwksCheck }),
      });
      setForm(EMPTY_FORM);
      setDiscovered(null);
      setShowAdvanced(false);
      setIgnoreJwksCheck(false);
      setNotice('Connection saved. It opens to students once an instructor has launched it once.');
      await load();
    } catch (e) {
      setError((e as Error).message);
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
    if (connection.status === 'active') return <span className="badge good">connected</span>;
    return <span className="badge warn">waiting for instructor</span>;
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

            {discovered && (
              <div className={discovered.warning ? 'notice warn' : 'notice'} style={{ marginBottom: 12 }}>
                {discovered.warning ?? (
                  <>
                    Endpoints read from <span className="mono">{discovered.source}</span>.
                  </>
                )}
              </div>
            )}

            <button type="button" className="secondary small" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? 'Hide endpoints' : 'Show endpoints'}
            </button>

            {showAdvanced && (
              <div style={{ marginTop: 12 }}>
                <p className="muted small">
                  Discovered from the address above. Correct any of them if this LMS uses different paths.
                </p>
                <div className="field">
                  <label htmlFor="issuer">Issuer (iss)</label>
                  <input
                    id="issuer"
                    className="mono"
                    value={form.issuer}
                    onChange={(e) => set({ issuer: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="authLoginUrl">Authorization endpoint</label>
                  <input
                    id="authLoginUrl"
                    className="mono"
                    value={form.authLoginUrl}
                    onChange={(e) => set({ authLoginUrl: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="authTokenUrl">Token endpoint</label>
                  <input
                    id="authTokenUrl"
                    className="mono"
                    value={form.authTokenUrl}
                    onChange={(e) => set({ authTokenUrl: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="jwksUrl">JWKS URL</label>
                  <input
                    id="jwksUrl"
                    className="mono"
                    value={form.jwksUrl}
                    onChange={(e) => set({ jwksUrl: e.target.value })}
                  />
                </div>
                <label className="row small" style={{ gap: 6, margin: '0 0 12px' }}>
                  <input
                    type="checkbox"
                    checked={ignoreJwksCheck}
                    onChange={(e) => setIgnoreJwksCheck(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  Save even if the key set cannot be read yet
                </label>
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <button type="submit" disabled={saving || !form.clientId || !form.deploymentId}>
                {saving ? 'Saving…' : 'Save connection'}
              </button>
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
                      const result = await authed<{ jwks: { ok: boolean; keys: number; error?: string } }>(
                        `/api/admin/connections/${connection.id}/test`,
                        { method: 'POST' },
                      );
                      setNotice(
                        result.jwks.ok
                          ? `${connection.name} published ${result.jwks.keys} signing key(s).`
                          : (result.jwks.error ?? 'Key set unreadable.'),
                      );
                    })
                  }
                >
                  Test
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

            <dl className="kv" style={{ marginBottom: 10 }}>
              <dt>client_id</dt>
              <dd className="mono">{connection.clientId}</dd>
              <dt>Authorization</dt>
              <dd className="mono small">{connection.authLoginUrl}</dd>
              <dt>Token</dt>
              <dd className="mono small">{connection.authTokenUrl}</dd>
              <dt>JWKS</dt>
              <dd className="mono small">{connection.jwksUrl}</dd>
            </dl>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>deployment_id</th>
                    <th>Status</th>
                    <th>Opened by</th>
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
                          <span className="badge good">open to students</span>
                        ) : (
                          <span className="badge warn">instructor must launch</span>
                        )}
                      </td>
                      <td className="small">
                        {deployment.activated ? (
                          <>
                            {deployment.activatedBy ?? 'an instructor'}
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
                              title="Require an instructor launch again"
                              onClick={() =>
                                act(
                                  () =>
                                    authed(`/api/admin/connections/${connection.id}/reset-activation`, {
                                      method: 'POST',
                                      body: JSON.stringify({ deploymentId: deployment.deploymentId }),
                                    }),
                                  'Deployment closed again until an instructor launches it.',
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

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface ToolConfig {
  title: string;
  description: string;
  oidc_initiation_url: string;
  target_link_uri: string;
  redirect_uris: string[];
  public_jwk_url: string;
  key_id: string;
}

export default function Home() {
  const [config, setConfig] = useState<ToolConfig | null>(null);

  useEffect(() => {
    api<ToolConfig>('/lti/config').then(setConfig).catch(() => setConfig(null));
  }, []);

  return (
    <div className="page">
      <h1>LTI 1.3 Content Provider</h1>
      <p className="subtitle">
        This service owns the course content. It never renders a course list of its own for students - content is
        reached only through a validated LTI 1.3 launch from a registered consumer LMS.
      </p>

      <div className="card">
        <h2>What this side of the demo does</h2>
        <div className="diagram">{`Consumer LMS  (LTI Platform)
      |
      |  1. third-party login initiation   ->  /lti/login
      |  2. OIDC auth request              <-  redirect to platform /lti/authorize
      |  3. signed id_token (form POST)    ->  /lti/launch
      |
      v
LTI Content Provider  (LTI Tool, this app)
      |
      +-- validate: signature / iss / aud / azp / exp / nonce / state / deployment
      +-- resolve:  custom.lecture_id  ->  Course > Module > Lecture
      +-- log:      CONTENT_LAUNCHED
      |
      v
Video content served in the consumer's iframe
      |
      +-- CONTENT_VIEW_STARTED  (player mount)
      +-- heartbeats            (playback progress)
      +-- CONTENT_VIEW_ENDED    (unload / timeout)
      |
      v
Activity logs + viewing durations  ->  /admin`}</div>
      </div>

      <div className="grid two">
        <div className="card">
          <h2>Tool endpoints</h2>
          {config ? (
            <dl className="kv">
              <dt>Login initiation</dt>
              <dd className="mono">{config.oidc_initiation_url}</dd>
              <dt>Redirect URI</dt>
              <dd className="mono">{config.redirect_uris.join(', ')}</dd>
              <dt>Target link URI</dt>
              <dd className="mono">{config.target_link_uri}</dd>
              <dt>Public JWKS</dt>
              <dd className="mono">
                <a href={config.public_jwk_url} target="_blank" rel="noreferrer">
                  {config.public_jwk_url}
                </a>
              </dd>
              <dt>Key id</dt>
              <dd className="mono">{config.key_id}</dd>
            </dl>
          ) : (
            <p className="muted">Loading configuration…</p>
          )}
        </div>

        <div className="card">
          <h2>What the provider learns from a launch</h2>
          <ul className="checklist">
            <li>
              <span className="step">Which consumer</span>
              <span className="detail">iss + client_id + deployment_id</span>
            </li>
            <li>
              <span className="step">Which student</span>
              <span className="detail">sub, name, email claims</span>
            </li>
            <li>
              <span className="step">Which content</span>
              <span className="detail">custom.lecture_id + resource_link</span>
            </li>
            <li>
              <span className="step">When</span>
              <span className="detail">iat of the id_token / launch timestamp</span>
            </li>
            <li>
              <span className="step">How long watched</span>
              <span className="detail">provider-side player telemetry, not LTI</span>
            </li>
          </ul>
          <div className="spacer" />
          <div className="notice warn">
            LTI 1.3 carries no playback data. Viewing duration is measured by this provider's own player and API.
          </div>
        </div>
      </div>
    </div>
  );
}

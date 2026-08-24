-- ===========================================================================
-- LTI CONTENT PROVIDER  (LTI 1.3 role: TOOL)
-- Owns: the content, the launch records, and all activity/viewing analytics.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- CONTENT MODEL:  Course -> Module -> Lecture
-- This data lives ONLY here. The consumer never copies it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modules (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS modules_course_idx ON modules(course_id);

-- content_type decides how the provider's player renders the item:
--   video | audio -> playable element, real playback telemetry available
--   pdf   | image -> rendered, but only presence can be measured (no timeline)
CREATE TABLE IF NOT EXISTS lectures (
  id               TEXT PRIMARY KEY,
  module_id        TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  content_type     TEXT NOT NULL DEFAULT 'video',
  content_url      TEXT NOT NULL,
  poster_url       TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lectures_content_type_check
    CHECK (content_type IN ('video', 'audio', 'pdf', 'image'))
);
CREATE INDEX IF NOT EXISTS lectures_module_idx ON lectures(module_id);

-- Migration for databases created before lectures held anything but video.
-- CREATE TABLE IF NOT EXISTS skips existing tables, so upgrade them here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'lectures' AND column_name = 'video_url')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'lectures' AND column_name = 'content_url')
  THEN
    ALTER TABLE lectures RENAME COLUMN video_url TO content_url;
  END IF;
END $$;

ALTER TABLE lectures ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'video';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lectures_content_type_check') THEN
    ALTER TABLE lectures ADD CONSTRAINT lectures_content_type_check
      CHECK (content_type IN ('video', 'audio', 'pdf', 'image'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- LTI PLATFORM REGISTRATIONS
-- One row per (issuer, client_id) pair the tool trusts. Everything needed to
-- validate an incoming launch and to call back out to the platform.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lti_platforms (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  issuer              TEXT NOT NULL,
  client_id           TEXT NOT NULL,
  deployment_ids      TEXT[] NOT NULL,
  auth_login_url      TEXT NOT NULL,
  auth_token_url      TEXT NOT NULL,
  jwks_url            TEXT NOT NULL,
  tool_redirect_uri   TEXT NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, client_id)
);

-- ---------------------------------------------------------------------------
-- OIDC STATE + NONCE STORES
-- state : created at login-initiation, echoed back by the platform. Bound to
--         the browser via cookie when cookies survive the iframe, and ALWAYS
--         validated server-side (see README: third-party cookie limitation).
-- nonce : single-use replay protection for the id_token.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lti_oidc_state (
  state             TEXT PRIMARY KEY,
  nonce             TEXT NOT NULL,
  platform_id       INTEGER NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  target_link_uri   TEXT NOT NULL,
  lti_message_hint  TEXT,
  login_hint        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS lti_nonces (
  nonce        TEXT PRIMARY KEY,
  platform_id  INTEGER NOT NULL REFERENCES lti_platforms(id) ON DELETE CASCADE,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- LTI LAUNCHES
-- One row per successfully validated LTI message. This is the provider's
-- answer to "which consumer, which student, which content, when".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lti_launches (
  id                    UUID PRIMARY KEY,
  platform_id           INTEGER NOT NULL REFERENCES lti_platforms(id),
  platform_issuer       TEXT NOT NULL,
  platform_client_id    TEXT NOT NULL,
  platform_name         TEXT,
  deployment_id         TEXT NOT NULL,
  message_type          TEXT NOT NULL,
  lti_version           TEXT NOT NULL,
  token_jti             TEXT,
  nonce                 TEXT NOT NULL,
  -- The consumer's own launch-session id, received as lti_message_hint at
  -- login initiation. Lets the provider report activity back to the right row.
  platform_launch_id    TEXT,

  user_id               TEXT NOT NULL,
  user_name             TEXT,
  user_email            TEXT,
  roles                 JSONB NOT NULL DEFAULT '[]'::jsonb,

  context_id            TEXT,
  context_title         TEXT,
  resource_link_id      TEXT,
  resource_link_title   TEXT,

  course_id             TEXT REFERENCES courses(id),
  module_id             TEXT REFERENCES modules(id),
  lecture_id            TEXT REFERENCES lectures(id),

  launched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address            TEXT,
  user_agent            TEXT,
  id_token_claims       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS lti_launches_user_idx ON lti_launches(user_id);
CREATE INDEX IF NOT EXISTS lti_launches_time_idx ON lti_launches(launched_at DESC);

-- The admin can retire content at any time, but a launch record is history and
-- must survive it. Point the content references at ON DELETE SET NULL, keeping
-- the row (and its id_token claims, which name the content anyway).
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('lti_launches_course_id_fkey',  'course_id',  'courses'),
      ('lti_launches_module_id_fkey',  'module_id',  'modules'),
      ('lti_launches_lecture_id_fkey', 'lecture_id', 'lectures')
    ) AS t(conname, column_name, referenced_table)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conname = target.conname AND c.confdeltype <> 'n'
    ) THEN
      EXECUTE format('ALTER TABLE lti_launches DROP CONSTRAINT %I', target.conname);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = target.conname) THEN
      EXECUTE format(
        'ALTER TABLE lti_launches ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE SET NULL',
        target.conname, target.column_name, target.referenced_table);
    END IF;
  END LOOP;
END $$;

-- Short-lived opaque handle that carries the validated launch from the HTTP
-- redirect into the React player without using a third-party cookie.
CREATE TABLE IF NOT EXISTS launch_tokens (
  token        TEXT PRIMARY KEY,
  launch_id    UUID NOT NULL REFERENCES lti_launches(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- VIEWING SESSIONS
-- LTI itself carries NO playback telemetry. These rows are produced by the
-- provider's own player (start / heartbeat / end), never by the LTI protocol.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS viewing_sessions (
  id                        UUID PRIMARY KEY,
  launch_id                 UUID NOT NULL REFERENCES lti_launches(id) ON DELETE CASCADE,
  platform_issuer           TEXT NOT NULL,
  deployment_id             TEXT NOT NULL,
  user_id                   TEXT NOT NULL,
  user_email                TEXT,
  user_name                 TEXT,
  course_id                 TEXT,
  module_id                 TEXT,
  lecture_id                TEXT,
  started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at                  TIMESTAMPTZ,
  last_heartbeat_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  presence_seconds          INTEGER NOT NULL DEFAULT 0,
  watched_seconds           INTEGER NOT NULL DEFAULT 0,
  furthest_position_seconds INTEGER NOT NULL DEFAULT 0,
  end_reason                TEXT,
  ip_address                TEXT,
  user_agent                TEXT
);
CREATE INDEX IF NOT EXISTS viewing_sessions_user_idx ON viewing_sessions(user_id);
CREATE INDEX IF NOT EXISTS viewing_sessions_open_idx ON viewing_sessions(ended_at) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- CONTENT ACTIVITY LOG  (append-only audit trail)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_activity_logs (
  id                  UUID PRIMARY KEY,
  event_type          TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  launch_id           UUID REFERENCES lti_launches(id) ON DELETE SET NULL,
  viewing_session_id  UUID REFERENCES viewing_sessions(id) ON DELETE SET NULL,
  session_id          TEXT,

  user_id             TEXT,
  user_email          TEXT,
  user_name           TEXT,

  platform_issuer     TEXT,
  platform_client_id  TEXT,
  platform_name       TEXT,
  deployment_id       TEXT,

  course_id           TEXT,
  course_name         TEXT,
  module_id           TEXT,
  module_name         TEXT,
  lecture_id          TEXT,
  lecture_name        TEXT,

  ip_address          TEXT,
  user_agent          TEXT,

  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS activity_time_idx  ON content_activity_logs(occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_user_idx  ON content_activity_logs(user_email);
CREATE INDEX IF NOT EXISTS activity_event_idx ON content_activity_logs(event_type);

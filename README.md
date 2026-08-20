# LTI Content Provider — LTI 1.3 **Tool**

Owns the course content and every record of who watched it. Content is reachable **only** through a validated LTI 1.3 launch; there is no student-facing catalogue and no public content API.

Runs on <http://localhost:4000>.

---

## Table of contents

1. [Architecture](#1-architecture)
2. [The LTI 1.3 flow](#2-the-lti-13-flow)
3. [Provider setup](#3-provider-setup)
4. [Consumer setup](#4-consumer-setup)
5. [Environment variables](#5-environment-variables)
6. [Key generation](#6-key-generation)
7. [Platform registration](#7-platform-registration)
8. [Tool registration](#8-tool-registration)
9. [Starting both applications](#9-starting-both-applications)
10. [Testing an LTI launch](#10-testing-an-lti-launch)
11. [How activity logging works](#11-how-activity-logging-works)
12. [Viewing session tracking and its limits](#viewing-session-tracking-and-its-limits)
13. [Security notes](#security-notes)

---

## 1. Architecture

```
Consumer LMS
      |
      | LTI 1.3 Launch
      ↓
LTI Content Provider
      |
      ↓
Course / Lecture
      |
      ↓
Video Content
      |
      ↓
Activity Logging
```

Layer by layer inside this project:

```
src/
├── config/         env + registration values (no secrets in code)
├── db/             pg pool + tiny query helpers (raw SQL, no ORM)
├── lti/            ── the LTI integration layer ──
│   ├── claims.ts        claim URIs, message types, roles
│   ├── keys.ts          RSA keypair loading, JWKS export
│   ├── platformStore.ts registered platforms (issuer + client_id)
│   ├── stateStore.ts    single-use state and nonce persistence
│   └── validateLaunch.ts the full validation chain
├── content/        the content model: Course → Module → Lecture
├── services/       launch records, viewing sessions, activity log,
│                   content-session tokens, outbound service calls
├── routes/         HTTP surface (lti, content, activity, deep-link, admin)
└── middleware/     bearer-token guard for the player API

frontend/           React (Vite) — player, deep-linking picker, admin dashboard
db/                 schema.sql + seed.sql
media/              self-hosted lecture videos, streamed from /media
```

The separation the brief asked for maps directly onto those folders: **frontend** (`frontend/`), **backend** (`src/`), **LTI integration** (`src/lti/`), **database** (`src/db/` + `db/`), **content** (`src/content/`), **logging** (`src/services/activityLog.ts`, `src/services/viewingSession.ts`).

### Database tables

| Table | Purpose |
|---|---|
| `courses`, `modules`, `lectures` | The static content model, including video URLs |
| `lti_platforms` | Registered consumers: issuer, client_id, deployment ids, endpoints |
| `lti_oidc_state`, `lti_nonces` | Single-use OIDC `state` and `nonce` |
| `lti_launches` | One row per validated LTI message, with the full decoded `id_token` |
| `launch_tokens` | One-time handle passing a validated launch into the React player |
| `viewing_sessions` | Start/end/duration per lecture view (provider-measured) |
| `content_activity_logs` | Append-only audit trail of every event |

---

## 2. The LTI 1.3 flow

### Step 1 — Login initiation (`POST|GET /lti/login`)

The consumer form-POSTs here first. Parameters: `iss`, `login_hint`, `client_id`, `lti_deployment_id`, `target_link_uri`, `lti_message_hint`.

The tool looks up the registration by `iss` + `client_id`, generates a **`state`** and a **`nonce`**, persists both server-side with a TTL, sets the state cookie, and redirects the browser to the platform's authorization endpoint with:

```
scope=openid  response_type=id_token  response_mode=form_post  prompt=none
client_id=…   redirect_uri=…          state=…                  nonce=…
login_hint=…  lti_message_hint=…      lti_deployment_id=…
```

### Step 2 — OIDC authentication (on the consumer)

The consumer authenticates the request and signs the `id_token`. See the [consumer README](../lti-consumer-lms/README.md).

### Step 3 — LTI message launch (`POST /lti/launch`)

The platform form-POSTs `id_token` + `state`. `src/lti/validateLaunch.ts` then performs, in order:

| # | Check | Failure code |
|---|---|---|
| 1 | `id_token` is a well-formed JWT | `malformed_id_token` |
| 2 | `iss` + `azp`/`aud` match a registered, active platform | `unknown_platform` |
| 3 | `state` exists server-side, unexpired, unused — consumed atomically | `invalid_state` |
| 4 | `state` belongs to that platform | `state_platform_mismatch` |
| 5 | State cookie matches, *if the browser sent one* | `state_cookie_mismatch` |
| 6 | **RS256 signature** verified against the platform's JWKS (`kid` lookup, cached) | `invalid_signature` |
| 7 | `iss` equals the registered issuer; `aud` contains the `client_id` | `invalid_signature` |
| 8 | `exp` / `iat` inside the allowed window (30 s clock tolerance, max age 300 s) | `invalid_signature` |
| 9 | If `aud` is multi-valued, `azp` is present and equals `client_id` | `missing_azp` / `invalid_azp` |
| 10 | `nonce` present, equal to the one we issued, and never seen before | `nonce_mismatch` / `nonce_replay` |
| 11 | `version` is `1.3.0` | `bad_version` |
| 12 | `message_type` is `LtiResourceLinkRequest` or `LtiDeepLinkingRequest` | `bad_message_type` |
| 13 | `deployment_id` registered for this platform | `unknown_deployment_id` |
| 14 | `target_link_uri` is this tool's launch URL | `bad_target_link_uri` |
| 15 | `sub` present (there is a user) | `missing_sub` |

Only after all of that does the tool resolve the content and record the launch. A rejection is logged as `LAUNCH_REJECTED` and shown as an explained error page.

### Step 4 — Serving the content

The tool resolves the lecture from the **`custom.lecture_id`** claim, writes an `lti_launches` row plus a `CONTENT_LAUNCHED` activity log, creates a one-time `launch_token`, and redirects to `/player?lt=…`. The React player exchanges that handle for the lecture payload and a short-lived **content session token** it uses for the activity API.

### What the provider knows, and from where

| Question | Source |
|---|---|
| Which consumer launched the content? | `iss`, `aud`/`azp` → `client_id`, `deployment_id` claims |
| Which student launched it? | `sub`, `name`, `email`, `roles` claims |
| Which course/lecture was launched? | `custom.lecture_id` (+ `context`, `resource_link` claims) |
| When did the launch happen? | `iat` of the `id_token`, stored as `launched_at` |
| When did viewing start/stop, and for how long? | **Not from LTI** — the provider's player; see [below](#viewing-session-tracking-and-its-limits) |

### Deep Linking

`LtiDeepLinkingRequest` launches land at the same `/lti/launch` endpoint and are routed by `message_type`. The tool requires an Instructor/Administrator role, shows a lecture picker, then signs an `LtiDeepLinkingResponse` (roles reversed: `iss` = our `client_id`, `aud` = the platform issuer) containing `ltiResourceLink` content items. Each item carries a `custom.lecture_id`, which is how future launches identify the content — the consumer never receives a video URL.

### Service calls back to the platform

`src/services/platformService.ts` obtains an access token from the platform's token endpoint using the OAuth 2.0 **client_credentials** grant with a **`private_key_jwt`** client assertion — the same mechanism AGS and NRPS use. It then pushes a viewing summary so the LMS can display duration without hosting the video.

> The `/lti/services/viewing-summary` endpoint itself is **not** an LTI specification service. It is a small demo service that exercises the token endpoint end to end. Real deployments would use AGS or NRPS here.

---

## 3. Provider setup

```bash
cd lti-content-provider
cp .env.example .env
npm install
npm run frontend:install
npm run setup           # keys:generate + db:migrate + db:seed
npm run frontend:build
npm run dev
```

`npm run setup` is idempotent — rerunning it will not overwrite existing keys (pass `--force` to `keys:generate` if you want new ones) and re-seeds content by upsert.

Seeded content: **Introduction to Financial Markets** → 4 modules → 9 items: 6 videos, 2 PDFs and 1 audio file. Module 4 exists purely to show the launch flow is identical whatever the content is.

### Content types

LTI itself is content-type agnostic — once a launch validates, whatever the tool renders appears in the consumer's iframe. `lectures.content_type` tells the player how to render each item:

| `content_type` | Rendered as | Playback telemetry |
|---|---|---|
| `video` | `<video>` | Yes — `watched_seconds` from the media timeline |
| `audio` | `<audio>` | Yes — same mechanism |
| `pdf` | `<iframe>` (the browser's built-in PDF viewer) | **No** — presence only |
| `image` | `<img>` | **No** — presence only |

For `pdf` and `image` the API returns `hasPlaybackTimeline: false`, and the player says so on screen: the provider can report how long the document was **open**, not how much of it was read. Page-level progress would need a PDF.js embed; the browser's built-in viewer does not expose it.

**Office formats (DOCX/PPTX/XLSX) are not rendered by browsers.** Convert them to PDF first — either by hand, or with `soffice --headless --convert-to pdf` if LibreOffice is available. Do not route them through Google's or Microsoft's online viewers: those need a publicly reachable URL and hand the file to a third party, which contradicts the point this demo exists to make.

### Where the content actually comes from

`lectures.content_url` accepts two forms:

| Stored value | Meaning |
|---|---|
| `/media/…` | **Self-hosted.** The file sits in `lti-content-provider/media/` and is streamed by this server from `/media`, with HTTP Range support so videos can seek and PDF viewers can fetch a page at a time instead of downloading everything first. |
| `https://…` | An external URL. |

Four items are **self-hosted** from `media/`: the headline video, two PDFs and an MP3. That makes the point of the whole demo concrete: the bytes come off the provider's own machine, travel through nothing but the consumer's iframe, and never touch the consumer's server. The remaining lectures use Google's public sample MP4s so the catalogue is full without shipping gigabytes.

### Self-hosted files are not public

A `<video src>` cannot send an `Authorization` header, and a cookie inside the consumer's iframe would be a third-party cookie. So the capability travels in the URL: after a launch validates, the provider mints a **short-lived media token** bound to one exact path and one launch, and returns `/media/file.mp4?t=…`.

| Request | Result |
|---|---|
| `/media/file.mp4` with no token | `401` |
| …with a forged or expired token | `401` |
| …with a token issued for a different file | `403` |
| …with a path-traversal attempt | `403` (the filename is reduced to its basename) |
| …with the correct token | `200` / `206`, Range supported |

Guessing a filename is therefore not enough — content really is reachable only through a validated LTI launch. Tokens live as long as `CONTENT_SESSION_TTL_SECONDS` and are marked `Cache-Control: private`.

Relative paths are expanded against `PROVIDER_BASE_URL` by `toDeliverableUrl()` before the API returns them, so the database stays portable across hosts.

**To add your own file:**

```bash
cp my-handout.pdf lti-content-provider/media/
```

then point a lecture at it — either edit `db/seed.sql` and re-run `npm run db:seed`, or update the row directly:

```sql
UPDATE lectures
   SET content_type = 'pdf', content_url = '/media/my-handout.pdf', poster_url = NULL
 WHERE id = 'lec-2-1';
```

Nothing changes on the consumer side: it only ever holds the lecture id.

---

## 4. Consumer setup

The consumer is a separate application. See [`../lti-consumer-lms/README.md`](../lti-consumer-lms/README.md). In short:

```bash
cd ../lti-consumer-lms
cp .env.example .env
npm install && npm run frontend:install
npm run setup
npm run frontend:build
npm run dev
```

Both projects must agree on `issuer`, `client_id` and `deployment_id`. The defaults already match.

---

## 5. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `PROVIDER_BASE_URL` | `http://localhost:4000` | Public base URL; all tool endpoints derive from it |
| `DATABASE_URL` | `postgres://lti:lti@localhost:5433/lti_provider` | Provider database |
| `LTI_PRIVATE_KEY_PATH` | `./keys/private.pem` | Tool signing key — **backend only** |
| `LTI_PUBLIC_KEY_PATH` | `./keys/public.pem` | Published via JWKS |
| `LTI_KEY_ID` | `provider-key-1` | `kid` in the JWKS and in signed JWT headers |
| `CONTENT_SESSION_SECRET` | *(change me)* | Signs the player's short-lived bearer token |
| `CONTENT_SESSION_TTL_SECONDS` | `14400` | Player token lifetime |
| `ADMIN_PASSWORD` | `admin123` | Activity dashboard password |
| `ALLOWED_FRAME_ANCESTORS` | `http://localhost:4001,http://localhost:5174` | CSP `frame-ancestors` allow-list |
| `VIEW_HEARTBEAT_TIMEOUT_SECONDS` | `90` | Silence after which a session is auto-closed |
| `VIEW_REAPER_INTERVAL_SECONDS` | `30` | How often the reaper runs |
| `LTI_STATE_TTL_SECONDS` | `600` | `state` lifetime |
| `LTI_NONCE_TTL_SECONDS` | `600` | `nonce` replay-window lifetime |
| `LTI_MAX_TOKEN_AGE_SECONDS` | `300` | Oldest accepted `id_token` |
| `PLATFORM_*`, `LTI_CLIENT_ID`, `LTI_DEPLOYMENT_IDS`, `CONSUMER_BASE_URL` | see `src/config/registration.ts` | Override the seeded platform registration |

---

## 6. Key generation

```bash
npm run keys:generate            # RSA-2048, PKCS#8 private + SPKI public
npm run keys:generate -- --force # replace an existing pair
```

- Written to `keys/`, which is **gitignored**; the private key gets mode `0600` where the OS supports it.
- The private key is read only by `src/lti/keys.ts` in the backend process. **Nothing under `frontend/` imports it, and it is never sent to a browser.**
- The public half is served as a JWKS at <http://localhost:4000/.well-known/jwks.json>, tagged with `kid`, `alg: RS256`, `use: sig`.
- The tool's private key signs **Deep Linking responses** and **client assertions**. It does *not* sign `id_token`s — those come from the platform.

---

## 7. Platform registration

What this tool needs to trust a consumer, stored in `lti_platforms`:

| Field | Demo value |
|---|---|
| Issuer (`iss`) | `http://localhost:4001` |
| Client ID | `edulab-content-provider` |
| Deployment ID | `deployment-fin-001` |
| Authorization endpoint | `http://localhost:4001/lti/authorize` |
| Token endpoint | `http://localhost:4001/lti/token` |
| Platform JWKS | `http://localhost:4001/.well-known/jwks.json` |

Seeded by `npm run db:seed` from `src/config/registration.ts`. Inspect at any time:

```bash
npm run registration:print
```

Or in the UI: **/admin → LTI registration**.

## 8. Tool registration

What a platform administrator needs in order to register this tool. Also available as JSON at <http://localhost:4000/lti/config>:

| Field | Value |
|---|---|
| Login initiation URL | `http://localhost:4000/lti/login` |
| Redirect URI | `http://localhost:4000/lti/launch` |
| Target link URI | `http://localhost:4000/lti/launch` |
| Public JWKS URL | `http://localhost:4000/.well-known/jwks.json` |
| Key ID | `provider-key-1` |
| Supported messages | `LtiResourceLinkRequest`, `LtiDeepLinkingRequest` |

---

## 9. Starting both applications

| | Command | URL |
|---|---|---|
| Postgres | `docker compose up -d` (repo root) | `localhost:5433` |
| Provider | `npm run dev` in `lti-content-provider` | <http://localhost:4000> |
| Consumer | `npm run dev` in `lti-consumer-lms` | <http://localhost:4001> |

`npm run dev` runs the backend with `tsx watch` and serves the **already built** React app from `public/`. For frontend hot-reload run `npm run frontend:dev` as well (Vite on :5173, proxying `/api`, `/lti` and `/.well-known` to :4000) — but drive the demo from :4000, since that is the origin registered with the platform.

Production-style: `npm run build && npm start`.

---

## 10. Testing an LTI launch

**Automated** — with both servers running, from the repository root:

```bash
node scripts/verify-lti-flow.mjs
```

114 assertions covering the whole flow end to end, including every security negative listed below.

**Through the UI** — sign in to <http://localhost:4001> as `angad@example.com` / `demo1234`, open the course, click **Launch lecture**. The player shows the launch details and the list of validation checks that passed.

**Things worth trying to prove it is real LTI:**

| Try this | Expected |
|---|---|
| Open <http://localhost:4000/lti/launch> directly | `405` — "only accepts a signed LTI 1.3 id_token via POST" |
| Open <http://localhost:4000/player> without a handle | "Cannot show this lecture" — no launch handle |
| Replay a captured `id_token` + `state` | `401 invalid_state` — state is single-use |
| Tamper with any byte of the `id_token` | `401 invalid_signature` |
| Stop the consumer, then launch | `401 invalid_signature` — the JWKS cannot be fetched |
| Change `LTI_CLIENT_ID` on one side only | `401 unknown_platform` |
| Sign in as a student and open Deep Linking | `403` — Instructor role required |

**Watch the server logs** (`npm run dev` output) — each hop prints a line: login initiation → signed token → launch OK → activity events.

**Reaper check** — with a lecture open in one tab:

```bash
npx tsx scripts/test-reaper.ts
```

back-dates the open session, runs the reaper, and prints the resulting `CONTENT_VIEW_ENDED` with `end_reason='timeout'`.

---

## 11. How activity logging works

Every event lands in `content_activity_logs` via `src/services/activityLog.ts`, fully denormalised so the dashboard needs no joins to be readable.

**Recorded fields:** `id`, `event_type`, `occurred_at`, `launch_id`, `viewing_session_id`, `session_id`, `user_id`, `user_email`, `user_name`, `platform_issuer`, `platform_client_id`, `platform_name`, `deployment_id`, `course_id`, `course_name`, `module_id`, `module_name`, `lecture_id`, `lecture_name`, `ip_address`, `user_agent`, `metadata`.

**Event types:**

| Event | Emitted when |
|---|---|
| `CONTENT_LAUNCHED` | An `LtiResourceLinkRequest` passed every validation check |
| `CONTENT_VIEW_STARTED` | The player mounted and opened a viewing session |
| `CONTENT_VIEW_ENDED` | The session closed — by beacon, by an explicit click, or by the reaper |
| `DEEP_LINKING_REQUESTED` | A valid `LtiDeepLinkingRequest` arrived |
| `DEEP_LINKING_RESPONSE_SENT` | The tool signed and returned content items |
| `LAUNCH_REJECTED` | A launch failed validation (the reason is in `metadata`) |

Logging failures are caught and reported to the console — a logging problem never breaks a launch.

**The dashboard** (<http://localhost:4000/admin>) shows Student · Course · Lecture · Event · Start time · End time · Duration · Consumer platform · Launch ID, with filters by event and student email, 10-second auto-refresh, and click-to-expand rows revealing IP, user agent and metadata. Further tabs give per-session, per-student and per-lecture totals, plus both halves of the LTI registration.

---

## Viewing session tracking and its limits

**LTI 1.3 does not provide video watch analytics.** The specification has no message for "started playing", "paused", "seeked" or "finished". Any product claiming LTI gives you watch time is measuring it somewhere else.

Because the **provider owns the video**, the provider's player is the right place to measure it. That is what this project does — outside the LTI protocol, and clearly labelled as such:

| Moment | Mechanism | Result |
|---|---|---|
| Player mounts | `POST /api/activity/view-start` | `viewing_sessions` row + `CONTENT_VIEW_STARTED` |
| Every 15 s | `POST /api/activity/heartbeat` | `last_heartbeat_at`, running durations |
| Frame closed / tab hidden | `navigator.sendBeacon` → `/api/activity/view-end` | `ended_at`, `CONTENT_VIEW_ENDED` |
| No heartbeat for 90 s | Server-side reaper (`reapStaleSessions`) | Closed with `end_reason='timeout'`, end time = last heartbeat |

**Two different durations are recorded, because they answer different questions:**

- **`presence_seconds`** — wall-clock seconds the lecture page was open. Includes time spent not watching.
- **`watched_seconds`** — seconds of video actually played, accumulated from the `<video>` element's `timeupdate` events. Only small forward deltas (< 2 s) are counted, so dragging the scrubber cannot inflate it.
- **`furthest_position_seconds`** — the furthest point reached in the video.

**Known limits, stated plainly:**

- `sendBeacon` is best-effort. A crashed tab, a killed browser or a sleeping phone may never send it — which is why the reaper exists. In that case the end time is the *last heartbeat*, so a session is never credited with time after the browser went quiet.
- Heartbeats are 15 s apart, so a timeout-closed session can under-report by up to that much. That is deliberate: under-reporting is safer than inflating.
- `watched_seconds` measures playback, not attention. A muted tab in the background still counts.
- Reloading the player starts a **new** viewing session; the previous one is closed with `end_reason='superseded'`.

---

## Security notes

- **Private keys never reach the frontend.** They are read from `keys/` by the backend, gitignored, and no file under `frontend/` references them.
- **`state` and `nonce` are single-use** and consumed with atomic `UPDATE … RETURNING` statements, so a concurrent replay cannot win a race.
- **Signature verification uses the platform's published JWKS** with `kid` lookup and caching (`jose`'s `createRemoteJWKSet`). No key material is hard-coded, and rotating the platform's key requires no change here.
- **All cryptography comes from [`jose`](https://github.com/panva/jose)** — signing, verification, JWKS handling. Nothing cryptographic is hand-rolled. The LTI *flow* is written out explicitly so it can be read and audited, which is the point of the demo.
- **`frame-ancestors`** is set from `ALLOWED_FRAME_ANCESTORS` instead of `X-Frame-Options`, so only the registered consumer origins may embed the player.

### Third-party cookies and the iframe

The player runs in a cross-site iframe. A conventional session cookie there is a **third-party cookie**: it needs `SameSite=None; Secure` (so, HTTPS), and browsers block it outright when third-party cookies are disabled. Two design choices avoid depending on that:

1. **OIDC `state`** is stored server-side and validated from the store. The state cookie is still set (`SameSite=None` under HTTPS, `Lax` otherwise) and checked *when present*, but its absence is expected and is recorded as such in the validation checks shown on the player page.
2. **The player's API calls** use a short-lived **content session JWT** delivered through the launch redirect and held in memory — no cookie at all. The unload path sends the same token in the `sendBeacon` body, since beacons cannot set headers.

To run the demo over HTTPS instead, put both apps behind TLS, set `PROVIDER_BASE_URL`/`CONSUMER_BASE_URL` to the `https://` origins, and the state cookie automatically becomes `SameSite=None; Secure`.

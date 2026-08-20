import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDuration, formatTime } from '../lib/api';

type ContentType = 'video' | 'audio' | 'pdf' | 'image';

interface Lecture {
  id: string;
  title: string;
  description: string;
  contentType: ContentType;
  contentUrl: string;
  selfHosted: boolean;
  /** video/audio expose a timeline; pdf/image do not. */
  hasPlaybackTimeline: boolean;
  posterUrl: string | null;
  durationSeconds: number;
  moduleId: string;
  moduleTitle: string;
  courseId: string;
  courseTitle: string;
}

interface LaunchInfo {
  id: string;
  launchedAt: string;
  messageType: string;
  ltiVersion: string;
  deploymentId: string;
  platformIssuer: string;
  platformClientId: string;
  platformName: string | null;
  user: { id: string; name: string | null; email: string | null; roles: string[] };
  context: { id: string | null; title: string | null; label: string | null };
  resourceLink: { id: string | null; title: string | null };
  custom: Record<string, string>;
  validationChecks: { step: string; detail: string }[];
}

interface ExchangeResponse {
  contentSessionToken: string;
  lecture: Lecture;
  launch: LaunchInfo;
}

const HEARTBEAT_MS = 15_000;

const TYPE_LABEL: Record<ContentType, string> = {
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF document',
  image: 'Image',
};

export default function Player() {
  const [data, setData] = useState<ExchangeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [endedAt, setEndedAt] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const exchangedRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const endedRef = useRef(false);

  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const watchedRef = useRef(0); // seconds of media actually played
  const positionRef = useRef(0); // furthest position reached
  const lastTimeRef = useRef<number | null>(null);
  const presenceStartRef = useRef<number>(Date.now());

  // --- 1. Exchange the one-time launch handle for content + a session token --
  useEffect(() => {
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    const lt = new URLSearchParams(window.location.search).get('lt');
    if (!lt) {
      setError('No launch handle in the URL. Open this lecture from the consumer LMS.');
      return;
    }
    // Drop the handle from the address bar; it is single-use anyway.
    window.history.replaceState({}, '', '/player');

    api<ExchangeResponse>('/api/launch/exchange', { method: 'POST', body: JSON.stringify({ lt }) })
      .then(async (payload) => {
        tokenRef.current = payload.contentSessionToken;
        setData(payload);

        // --- 2. CONTENT_VIEW_STARTED ---------------------------------------
        const started = await api<{ viewingSessionId: string; startedAt: string }>('/api/activity/view-start', {
          method: 'POST',
          headers: { authorization: `Bearer ${payload.contentSessionToken}` },
          body: JSON.stringify({}),
        });
        sessionIdRef.current = started.viewingSessionId;
        presenceStartRef.current = Date.now();
        setSessionId(started.viewingSessionId);
        setStartedAt(started.startedAt);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const sendEnd = useCallback((reason: string, useBeacon: boolean) => {
    if (endedRef.current || !sessionIdRef.current || !tokenRef.current) return;
    endedRef.current = true;

    const payload = JSON.stringify({
      token: tokenRef.current,
      viewingSessionId: sessionIdRef.current,
      watchedSeconds: Math.round(watchedRef.current),
      positionSeconds: Math.round(positionRef.current),
      reason,
    });

    if (useBeacon && navigator.sendBeacon) {
      // Keeps working while the document is being torn down. Cannot set headers,
      // so the content session token travels in the body instead.
      navigator.sendBeacon('/api/activity/view-end', new Blob([payload], { type: 'text/plain' }));
      return;
    }
    void api<{ endedAt: string }>('/api/activity/view-end', { method: 'POST', body: payload })
      .then((r) => setEndedAt(r.endedAt))
      .catch(() => undefined);
  }, []);

  // --- 3. Heartbeats + unload handling --------------------------------------
  useEffect(() => {
    if (!sessionId) return;

    const beat = setInterval(() => {
      if (endedRef.current) return;
      void api('/api/activity/heartbeat', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenRef.current}` },
        body: JSON.stringify({
          viewingSessionId: sessionId,
          watchedSeconds: Math.round(watchedRef.current),
          positionSeconds: Math.round(positionRef.current),
        }),
      }).catch(() => undefined);
    }, HEARTBEAT_MS);

    const display = setInterval(() => setTick((t) => t + 1), 1000);

    const onPageHide = () => sendEnd('unload', true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sendEnd('hidden', true);
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(beat);
      clearInterval(display);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionId, sendEnd]);

  // --- Playback measurement (video/audio only - NOT something LTI provides) --
  const onTimeUpdate = () => {
    const media = mediaRef.current;
    if (!media) return;
    const now = media.currentTime;
    const last = lastTimeRef.current;
    // Count only small forward deltas so seeking cannot inflate watch time.
    if (last !== null && now > last && now - last < 2) watchedRef.current += now - last;
    lastTimeRef.current = now;
    positionRef.current = Math.max(positionRef.current, now);
  };
  const resetDelta = () => {
    lastTimeRef.current = null;
  };

  if (error) {
    return (
      <div className="page narrow">
        <div className="card">
          <h1>Cannot show this lecture</h1>
          <p className="muted">{error}</p>
          <div className="notice">
            Content on this provider is only reachable through a validated LTI 1.3 launch. Start from the consumer
            LMS and click <strong>Launch Lecture</strong>.
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page narrow">
        <div className="card empty">Validating LTI launch…</div>
      </div>
    );
  }

  const { lecture, launch } = data;
  const presenceEnd = endedAt ? new Date(endedAt).getTime() : Date.now();
  const presenceSeconds = Math.max(0, Math.floor((presenceEnd - presenceStartRef.current) / 1000));

  const mediaProps = {
    controls: true,
    preload: 'metadata' as const,
    onTimeUpdate,
    onSeeking: resetDelta,
    onPause: resetDelta,
    onPlay: resetDelta,
  };

  return (
    <div className="page">
      <div className="card">
        <div className="row" style={{ gap: 8 }}>
          <span className="badge accent">Served by the content provider</span>
          <span className="badge">{TYPE_LABEL[lecture.contentType]}</span>
          {lecture.selfHosted && <span className="badge good">self-hosted file</span>}
        </div>
        <h1 style={{ marginTop: 10 }}>{lecture.title}</h1>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          {lecture.courseTitle} &middot; {lecture.moduleTitle}
        </p>

        {lecture.contentType === 'video' && (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            poster={lecture.posterUrl ?? undefined}
            {...mediaProps}
          >
            <source src={lecture.contentUrl} type="video/mp4" />
            Your browser cannot play this video.
          </video>
        )}

        {lecture.contentType === 'audio' && (
          <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} style={{ width: '100%' }} {...mediaProps}>
            <source src={lecture.contentUrl} />
            Your browser cannot play this audio.
          </audio>
        )}

        {lecture.contentType === 'pdf' && (
          <div className="doc-frame">
            {/* The browser's built-in PDF viewer. It fetches by HTTP Range, so
                large documents render the first page without downloading all of it. */}
            <iframe src={lecture.contentUrl} title={lecture.title} />
            <p className="muted small" style={{ margin: '10px 0 0' }}>
              Not rendering?{' '}
              <a href={lecture.contentUrl} target="_blank" rel="noreferrer">
                Open the PDF in a new tab
              </a>
              .
            </p>
          </div>
        )}

        {lecture.contentType === 'image' && (
          <img
            src={lecture.contentUrl}
            alt={lecture.title}
            style={{ width: '100%', borderRadius: 8, display: 'block' }}
          />
        )}

        <p className="muted small" style={{ marginTop: 12 }}>
          {lecture.description}
        </p>
      </div>

      <div className="grid two">
        <div className="card">
          <h2>Viewing session (provider-measured)</h2>
          <dl className="kv">
            <dt>Session id</dt>
            <dd className="mono">{sessionId ?? 'starting…'}</dd>
            <dt>Started</dt>
            <dd>{formatTime(startedAt)}</dd>
            <dt>Ended</dt>
            <dd>{endedAt ? formatTime(endedAt) : <span className="badge good">open</span>}</dd>
            <dt>Time on page</dt>
            <dd data-tick={tick}>{formatDuration(presenceSeconds)}</dd>
            {lecture.hasPlaybackTimeline && (
              <>
                <dt>{lecture.contentType === 'audio' ? 'Audio played' : 'Video watched'}</dt>
                <dd>{formatDuration(watchedRef.current)}</dd>
              </>
            )}
          </dl>

          {!lecture.hasPlaybackTimeline && (
            <div className="notice warn" style={{ marginTop: 12 }}>
              A {TYPE_LABEL[lecture.contentType].toLowerCase()} has no playback timeline, so the provider can report
              only how long it was <strong>open</strong> — not how much was read. Claiming otherwise would be
              guesswork.
            </div>
          )}

          <div className="spacer" />
          <button
            className="secondary small"
            disabled={!sessionId || Boolean(endedAt)}
            onClick={() => sendEnd('explicit', false)}
          >
            End viewing session now
          </button>
          <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
            CONTENT_VIEW_ENDED is also sent automatically when this frame is closed, and the server closes any
            session that stops sending heartbeats.
          </p>
        </div>

        <div className="card">
          <h2>What the provider knows about this launch</h2>
          <dl className="kv">
            <dt>Consumer</dt>
            <dd>
              {launch.platformName ?? '-'} <span className="mono">({launch.platformIssuer})</span>
            </dd>
            <dt>client_id</dt>
            <dd className="mono">{launch.platformClientId}</dd>
            <dt>deployment_id</dt>
            <dd className="mono">{launch.deploymentId}</dd>
            <dt>Student</dt>
            <dd>
              {launch.user.name ?? '-'} &middot; {launch.user.email ?? 'no email claim'}
            </dd>
            <dt>sub</dt>
            <dd className="mono">{launch.user.id}</dd>
            <dt>Roles</dt>
            <dd className="small">{launch.user.roles.map((r) => r.split('#').pop()).join(', ') || '-'}</dd>
            <dt>Context</dt>
            <dd>
              {launch.context.title ?? '-'} <span className="mono">({launch.context.id ?? '-'})</span>
            </dd>
            <dt>Resource link</dt>
            <dd className="mono">{launch.resourceLink.id ?? '-'}</dd>
            <dt>Requested lecture</dt>
            <dd className="mono">{launch.custom.lecture_id ?? lecture.id}</dd>
            <dt>Launched at</dt>
            <dd>{formatTime(launch.launchedAt)}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h2>LTI 1.3 validation performed before this content was served</h2>
        <ul className="checklist">
          {launch.validationChecks.map((check, i) => (
            <li key={i}>
              <span className="tick">✓</span>
              <span className="step">{check.step}</span>
              <span className="detail">{check.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

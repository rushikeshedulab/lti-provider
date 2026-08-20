/**
 * Manual check for the stale-session reaper: back-dates the newest open viewing
 * session, runs the reaper, and prints what it closed.
 */
import { pool, query } from '../src/db/pool.js';
import { reapStaleSessions } from '../src/services/viewingSession.js';

const open = await query<{ id: string }>(
  `UPDATE viewing_sessions
      SET last_heartbeat_at = now() - interval '10 minutes'
    WHERE id = (SELECT id FROM viewing_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1)
    RETURNING id`,
);
if (open.length === 0) {
  console.log('No open viewing session to test with. Launch a lecture first.');
} else {
  console.log('Back-dated session', open[0]!.id);
  const closed = await reapStaleSessions();
  console.log('Reaper closed', closed, 'session(s)');
  const rows = await query(`SELECT id, end_reason, presence_seconds, ended_at FROM viewing_sessions WHERE id = $1`, [
    open[0]!.id,
  ]);
  console.log(rows[0]);
  const log = await query(
    `SELECT event_type, metadata->>'end_reason' AS reason FROM content_activity_logs
      WHERE viewing_session_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [open[0]!.id],
  );
  console.log(log[0]);
}
await pool.end();

import { pool, query } from './pool.js';

/**
 * STARTUP MIGRATIONS
 * ------------------
 * Self-service platform connections added columns to `lti_platforms`. A running
 * installation must not need someone to remember `npm run db:migrate` before
 * the admin panel works, so the same DDL runs here every time the server boots.
 *
 * Every statement is idempotent (`IF NOT EXISTS`), so this is a no-op on a
 * database that is already current - which is the normal case. The identical
 * statements also live in db/schema.sql, which stays the description of a
 * freshly created database.
 */
const STATEMENTS: { label: string; sql: string }[] = [
  {
    label: 'lti_platforms.created_via',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'env'`,
  },
  {
    label: 'lti_platforms.status',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
  },
  {
    label: 'lti_platforms.notes',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS notes TEXT`,
  },
  {
    label: 'lti_platforms.updated_at',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  },
  {
    label: 'lti_platforms.activated_deployments',
    sql: `ALTER TABLE lti_platforms
            ADD COLUMN IF NOT EXISTS activated_deployments JSONB NOT NULL DEFAULT '{}'::jsonb`,
  },
  // DYNAMIC ENDPOINT RESOLUTION
  // A connection now remembers WHERE its endpoints came from, so they can be
  // re-read from the platform instead of being frozen at the moment of saving.
  // The three existing *_url columns become the last-known-good snapshot.
  {
    label: 'lti_platforms.discovery_url',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS discovery_url TEXT`,
  },
  {
    label: 'lti_platforms.discovery_source',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS discovery_source TEXT`,
  },
  {
    label: 'lti_platforms.discovery_fetched_at',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS discovery_fetched_at TIMESTAMPTZ`,
  },
  {
    label: 'lti_platforms.discovery_error',
    sql: `ALTER TABLE lti_platforms ADD COLUMN IF NOT EXISTS discovery_error TEXT`,
  },
  {
    /**
     * A platform may publish no token endpoint at all - only LTI Advantage
     * service calls need one - and storing '' for "absent" would pass some
     * emptiness checks and fail others. NULL is the honest value.
     */
    label: 'lti_platforms.auth_token_url: allow NULL',
    sql: `ALTER TABLE lti_platforms ALTER COLUMN auth_token_url DROP NOT NULL`,
  },
  {
    /**
     * `status` is only ever a summary of `activated_deployments`, so recompute
     * it rather than trust it. It reports whether a launch has ever arrived
     * through the connection; it does not gate anything.
     */
    label: 'lti_platforms: reconcile status with activations',
    sql: `UPDATE lti_platforms
             SET status = CASE WHEN activated_deployments <> '{}'::jsonb THEN 'active' ELSE 'pending' END
           WHERE status IS DISTINCT FROM
                 CASE WHEN activated_deployments <> '{}'::jsonb THEN 'active' ELSE 'pending' END`,
  },
];

export async function runStartupMigrations(): Promise<void> {
  // Nothing to upgrade before the schema itself exists; `npm run setup` creates
  // it, and this must not crash the process when it has not been run yet.
  const [table] = await query<{ present: boolean }>(
    `SELECT to_regclass('public.lti_platforms') IS NOT NULL AS present`,
  );
  if (!table?.present) {
    console.warn('[migrate] lti_platforms does not exist yet - run `npm run setup` to create the schema.');
    return;
  }

  const changed: string[] = [];
  for (const statement of STATEMENTS) {
    try {
      const result = await pool.query(statement.sql);
      // DDL reports a null rowCount; only the adoption UPDATE reports rows, and
      // then only on the boot that actually upgraded them.
      if (result.rowCount) changed.push(`${statement.label} (${result.rowCount})`);
    } catch (err) {
      console.error(`[migrate] ${statement.label} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  console.log(
    changed.length
      ? `[migrate] schema updated: ${changed.join(', ')}`
      : `[migrate] schema is current (${STATEMENTS.length} checks)`,
  );
}

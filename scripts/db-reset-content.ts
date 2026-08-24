import { pool, query } from '../src/db/pool.js';

/**
 * Wipes every course, module and content item from the provider database.
 *
 * Use it once to clear content that predates the admin-upload flow (the old
 * demo seed), or any time you want to start the catalog from scratch. Platform
 * registrations, launches and activity logs are left alone; launch rows keep
 * their id_token claims and simply lose their content foreign keys.
 *
 * Files in ./media are NOT touched - delete those from the admin panel.
 */
try {
  const [before] = await query<{ courses: string; modules: string; lectures: string }>(
    `SELECT (SELECT count(*) FROM courses)  AS courses,
            (SELECT count(*) FROM modules)  AS modules,
            (SELECT count(*) FROM lectures) AS lectures`,
  );

  // modules and lectures go with it: both cascade from courses.
  await query(`DELETE FROM courses`);

  console.log(`Removed ${before?.courses ?? 0} course(s), ${before?.modules ?? 0} module(s), ${before?.lectures ?? 0} content item(s).`);
  console.log('The catalog is now empty. Upload content at /admin.');
} catch (err) {
  console.error('Reset failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

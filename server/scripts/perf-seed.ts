// Generates a realistic, SKEWED data set in a dedicated perf database, using set-based SQL (no per-row round trips).
//   npm run perf:seed                         defaults: 2,000 users, 2,000 projects, 500,000 tasks
//   PERF_TASKS=2000000 npm run perf:seed      scale up
// Skew matters: 30% of all tasks live in just 5 "hot" projects (100k+ tasks each), like a real company's biggest
// projects. Uniform data hides the problems that matter.
import pg from 'pg';
import { hashPassword } from '../src/modules/auth/password.js';
import { migrate } from '../src/migrate.js';
import { assertPerfDb, ensurePerfDb, ms, PERF_PASSWORD, PERF_URL } from './perf-lib.js';

const USERS = Number(process.env.PERF_USERS ?? 2000);
const PROJECTS = Number(process.env.PERF_PROJECTS ?? 2000);
const TASKS = Number(process.env.PERF_TASKS ?? 500_000);
const HOT = 5;

assertPerfDb(PERF_URL);
await ensurePerfDb(PERF_URL);
const pool = new pg.Pool({ connectionString: PERF_URL, max: 2 });
const db = await pool.connect();
await db.query(`SET statement_timeout = 0`); // seeding is allowed to take a while

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const r = await fn();
  console.log(`  ${label.padEnd(34)} ${ms(performance.now() - t).padStart(7)} ms`);
  return r;
}

try {
  console.log(`Seeding ${PERF_URL.replace(/:[^:@]*@/, ':***@')}`);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await step('apply migrations', () => migrate(pool));

  const hash = await hashPassword(PERF_PASSWORD);
  await step('users', async () => {
    await db.query(
      `INSERT INTO users (email, name, password_hash, created_at)
       SELECT 'user' || g || '@perf.test', 'User ' || g, $1, now() - random() * interval '700 days'
         FROM generate_series(1, $2) g`,
      [hash, USERS],
    );
    await db.query(`INSERT INTO users (email, name, password_hash, role) VALUES ('admin@perf.test', 'Perf Admin', $1, 'admin')`, [hash]);
    await db.query(`CREATE TEMP TABLE u AS SELECT id, row_number() OVER (ORDER BY created_at, id)::int AS rn FROM users WHERE role = 'user'`);
    await db.query(`CREATE INDEX ON u (rn)`);
  });

  await step('projects', async () => {
    await db.query(
      `WITH base AS MATERIALIZED (SELECT g, random() AS r, 1 + floor(random() * $2)::int AS urn FROM generate_series(1, $1) g)
       INSERT INTO projects (name, description, status, created_by, created_at, updated_at)
       SELECT (array['Website','Mobile','Billing','Onboarding','Analytics','Search','Payments','Migration','Platform','Security'])[1 + g % 10]
              || ' ' || (array['Redesign','Launch','Revamp','Rollout','Cleanup','Upgrade'])[1 + g % 6] || ' ' || g,
              'Project ' || g || ' covers ' || (array['customer','internal','partner','billing','reporting'])[1 + g % 5] || ' work.',
              CASE WHEN r < 0.8 THEN 'active' WHEN r < 0.9 THEN 'completed' ELSE 'archived' END,
              u.id, ts.t, ts.t
         FROM base JOIN u ON u.rn = base.urn
         CROSS JOIN LATERAL (SELECT now() - random() * interval '730 days' AS t) ts`,
      [PROJECTS, USERS],
    );
    await db.query(`CREATE TEMP TABLE p AS SELECT id, created_by, row_number() OVER (ORDER BY created_at, id)::int AS rn FROM projects`);
    await db.query(`CREATE INDEX ON p (rn)`);
  });

  await step('memberships', async () => {
    await db.query(`INSERT INTO project_members (project_id, user_id, role) SELECT id, created_by, 'owner' FROM p`);
    // 4-12 extra members each; hot projects get 40 so they look like big teams.
    // NOTE: random() must be evaluated ONCE per row (materialised CTE), not inside the join condition, where
    // it is re-evaluated per comparison and almost never matches.
    await db.query(
      `WITH picks AS MATERIALIZED (
         SELECT p.id AS project_id, 1 + floor(random() * $1)::int AS urn
           FROM p CROSS JOIN LATERAL generate_series(1, CASE WHEN p.rn <= $2 THEN 40 ELSE 4 + (p.rn % 9) END) k)
       INSERT INTO project_members (project_id, user_id, role)
       SELECT picks.project_id, u.id, 'member' FROM picks JOIN u ON u.rn = picks.urn
       ON CONFLICT DO NOTHING`,
      [USERS, HOT],
    );
    const { rows: [m] } = await db.query(`SELECT count(*)::int AS n FROM project_members`);
    if (m.n < PROJECTS * 3) throw new Error(`Seed bug: only ${m.n} memberships for ${PROJECTS} projects`);
    // member ranking so tasks can pick a random member of THEIR project using set-based joins
    await db.query(
      `CREATE TEMP TABLE pm AS
       SELECT project_id, user_id, row_number() OVER (PARTITION BY project_id ORDER BY user_id)::int AS ord,
              count(*) OVER (PARTITION BY project_id)::int AS cnt FROM project_members`,
    );
    await db.query(`CREATE INDEX ON pm (project_id, ord)`);
  });

  await step(`tasks (${TASKS.toLocaleString()})`, async () => {
    await db.query(
      `WITH gen AS MATERIALIZED (
         SELECT g,
                CASE WHEN random() < 0.3 THEN 1 + floor(random() * $2)::int ELSE 1 + floor(random() * $3)::int END AS prn,
                random() AS r_status, random() AS r_prio, random() AS r_asg, random() AS r_due,
                random() AS r_m1, random() AS r_m2, random() AS r_age,
                1 + floor(random() * 20)::int AS w1, 1 + floor(random() * 20)::int AS w2, 1 + floor(random() * 20)::int AS w3
           FROM generate_series(1, $1) g),
       t AS (
         SELECT gen.*, p.id AS project_id,
                (SELECT cnt FROM pm WHERE pm.project_id = p.id AND pm.ord = 1) AS cnt
           FROM gen JOIN p ON p.rn = gen.prn)
       INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, creator_id, due_date, completed_at, created_at, updated_at)
       SELECT t.project_id,
              (array['Fix','Add','Refactor','Review','Document','Test','Deploy','Plan','Investigate','Update','Remove','Design','Migrate','Optimise','Monitor','Audit','Clean','Draft','Verify','Ship'])[t.w1]
              || ' ' || (array['login','billing','search','dashboard','export','import','email','invoice','report','profile','cache','queue','webhook','payment','session','upload','filter','sidebar','schema','pipeline'])[t.w2]
              || ' ' || (array['bug','flow','page','job','endpoint','module','widget','policy','script','feature','handler','service','layer','check','rule','config','report','view','test','docs'])[t.w3]
              || ' #' || t.g,
              'Details for task ' || t.g || ' regarding the ' || (array['customer','internal','partner'])[1 + t.g % 3] || ' request.',
              s.status,
              CASE WHEN t.r_prio < 0.1 THEN 'urgent' WHEN t.r_prio < 0.3 THEN 'high' WHEN t.r_prio < 0.75 THEN 'medium' ELSE 'low' END,
              CASE WHEN t.r_asg < 0.15 THEN NULL ELSE m2.user_id END,
              m1.user_id,
              CASE WHEN t.r_due < 0.3 THEN NULL ELSE current_date + (floor(t.r_age * 150) - 60)::int END,
              CASE WHEN s.status = 'done' THEN least(now(), c.at + t.r_due * interval '30 days') END,
              c.at, c.at
         FROM t
         CROSS JOIN LATERAL (SELECT CASE WHEN t.r_status < 0.40 THEN 'done' WHEN t.r_status < 0.60 THEN 'in_progress'
                                         WHEN t.r_status < 0.70 THEN 'in_review' ELSE 'todo' END AS status) s
         CROSS JOIN LATERAL (SELECT now() - t.r_age * interval '700 days' AS at) c
         JOIN pm m1 ON m1.project_id = t.project_id AND m1.ord = 1 + floor(t.r_m1 * t.cnt)::int
         JOIN pm m2 ON m2.project_id = t.project_id AND m2.ord = 1 + floor(t.r_m2 * t.cnt)::int`,
      [TASKS, HOT, PROJECTS],
    );
  });

  await step('comments (~15% of tasks)', () =>
    db.query(`INSERT INTO comments (task_id, author_id, body, created_at, updated_at)
              SELECT id, creator_id, 'Looks good, picking this up.', created_at + interval '1 hour', created_at + interval '1 hour'
                FROM tasks TABLESAMPLE BERNOULLI (15)`));

  await step('activity log (created + done events)', async () => {
    await db.query(`INSERT INTO activity_log (project_id, task_id, actor_id, action, metadata, created_at)
                    SELECT project_id, id, creator_id, 'task.created', jsonb_build_object('title', title), created_at FROM tasks ORDER BY created_at`);
    await db.query(`INSERT INTO activity_log (project_id, task_id, actor_id, action, metadata, created_at)
                    SELECT project_id, id, COALESCE(assignee_id, creator_id), 'task.status_changed', '{"from":"in_review","to":"done"}'::jsonb, completed_at
                      FROM tasks WHERE status = 'done' ORDER BY completed_at`);
  });

  await step('ANALYZE (planner statistics)', () => db.query('ANALYZE'));

  const { rows } = await db.query(`
    SELECT relname AS table, to_char(n_live_tup, 'FM999,999,999') AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`);
  console.table(rows);
  const hot = await db.query(`SELECT p.name, count(*)::int AS tasks FROM tasks t JOIN projects p ON p.id = t.project_id GROUP BY p.name ORDER BY 2 DESC LIMIT 3`);
  console.log('Largest projects:', hot.rows.map((r) => `${r.name} (${r.tasks.toLocaleString()})`).join(', '));
  console.log(`Login for perf users: user<N>@perf.test / admin@perf.test with password "${PERF_PASSWORD}"`);
} finally {
  db.release();
  await pool.end();
}

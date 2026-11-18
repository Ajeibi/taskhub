// Measures the REAL application against the seeded perf database:
//   1. per-endpoint latency (p50/p95/max) over a real HTTP server
//   2. EXPLAIN (ANALYZE, BUFFERS) of the exact SQL each endpoint ran (captured, not re-typed)
//   3. keyset vs OFFSET pagination at depth
//   4. throughput and tail latency under concurrent mixed load
//   npm run perf:seed && npm run perf:run
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { assertPerfDb, ms, PERF_PASSWORD, PERF_URL } from './perf-lib.js';

assertPerfDb(PERF_URL);
const config: Config = {
  NODE_ENV: 'test', PORT: 0, LOG_LEVEL: 'silent', DATABASE_URL: PERF_URL, DB_POOL_MAX: 10,
  JWT_SECRET: 'perf-secret-perf-secret-perf-secret-0123', ACCESS_TOKEN_TTL_SECONDS: 3600, REFRESH_TOKEN_TTL_DAYS: 1,
  COOKIE_SECURE: false, AUTH_RATE_LIMIT_MAX: 1_000_000,
};

// ---- app under test, with SQL capture --------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: PERF_URL, max: config.DB_POOL_MAX });
let capture: Array<{ text: string; values: unknown[] }> | null = null;
const realQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
(pool as unknown as { query: unknown }).query = (text: unknown, values?: unknown[]) => {
  if (capture) capture.push({ text: typeof text === 'string' ? text : (text as { text: string }).text, values: values ?? [] });
  return realQuery(text, values);
};
const app = createApp({ db: pool, logger: pino({ level: 'silent' }), config });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const explainPool = new pg.Pool({ connectionString: PERF_URL, max: 2 });

// ---- helpers ---------------------------------------------------------------------------------------------------
const q = async <T = Record<string, never>>(sql: string, params: unknown[] = []): Promise<T[]> => (await explainPool.query(sql, params)).rows as T[];
async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PERF_PASSWORD }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} (did you run perf:seed?)`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}
async function get(path: string, token: string): Promise<Response> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  await res.json(); // include body transfer + parse in the measurement
  return res;
}
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

// ---- who and what to test --------------------------------------------------------------------------------------
const [hot] = await q<{ project_id: string; n: number }>(`SELECT project_id, count(*)::int AS n FROM tasks GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
const [heavy] = await q<{ email: string }>(`SELECT u.email FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 AND m.role = 'member' LIMIT 1`, [hot!.project_id]);
const [regular] = await q<{ email: string; n: number }>(
  `SELECT u.email, count(*)::int AS n FROM project_members m JOIN users u ON u.id = m.user_id
    WHERE m.user_id NOT IN (SELECT user_id FROM project_members WHERE project_id = $1)
    GROUP BY u.email HAVING count(*) BETWEEN 8 AND 14 LIMIT 1`, [hot!.project_id]);
const [commented] = await q<{ task_id: string }>(`SELECT task_id FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1 LIMIT 500) LIMIT 1`, [hot!.project_id]);
const totals = (await q<{ t: string; n: number }>(`SELECT 'tasks' t, count(*)::int n FROM tasks UNION ALL SELECT 'projects', count(*)::int FROM projects UNION ALL SELECT 'users', count(*)::int FROM users UNION ALL SELECT 'activity', count(*)::int FROM activity_log`)).map((r) => `${r.n.toLocaleString()} ${r.t}`);
console.log(`\nData set: ${totals.join(', ')}. Hottest project has ${hot!.n.toLocaleString()} tasks.`);

const tokens = { regular: await login(regular!.email), heavy: await login(heavy!.email), admin: await login('admin@perf.test') };
const H = hot!.project_id;
interface Scenario { name: string; who: keyof typeof tokens; path: string; runs?: number }
const scenarios: Scenario[] = [
  { name: 'Project list (member, ~10 projects)', who: 'regular', path: '/api/projects?limit=25' },
  { name: 'Project search "billing"', who: 'regular', path: '/api/projects?q=billing' },
  { name: 'Hot project detail (counts over big project)', who: 'heavy', path: `/api/projects/${H}` },
  { name: 'Hot project tasks, first page', who: 'heavy', path: `/api/projects/${H}/tasks?limit=25` },
  { name: 'Hot project tasks, status+priority filter', who: 'heavy', path: `/api/projects/${H}/tasks?status=todo,in_progress&priority=urgent,high` },
  { name: 'Hot project tasks, assignee=me', who: 'heavy', path: `/api/projects/${H}/tasks?assignee=me` },
  { name: 'Hot project tasks, text search "login"', who: 'heavy', path: `/api/projects/${H}/tasks?q=login` },
  { name: 'Hot project tasks, overdue', who: 'heavy', path: `/api/projects/${H}/tasks?overdue=true` },
  { name: 'My tasks across projects (assignee=me)', who: 'regular', path: '/api/tasks?assignee=me' },
  { name: 'My overdue tasks', who: 'regular', path: '/api/tasks?assignee=me&overdue=true' },
  { name: 'Global task search "payment"', who: 'regular', path: '/api/tasks?q=payment' },
  { name: 'Dashboard (member, ~10 projects)', who: 'regular', path: '/api/dashboard' },
  { name: 'Dashboard (member of hottest project)', who: 'heavy', path: '/api/dashboard' },
  { name: 'Dashboard (platform admin: sees ALL data)', who: 'admin', path: '/api/dashboard', runs: 5 },
  { name: 'Comments on a task', who: 'heavy', path: `/api/tasks/${commented!.task_id}/comments` },
];

interface Summary { scenario: string; p50: string; p95: string; max: string; sql: number; slowestSql: string; seqScans: string; rowsDiscarded: string }
const summaries: Summary[] = [];
const flagged: Array<{ scenario: string; sql: string; ms: number; seq: string }> = [];
const BIG = new Set(['tasks', 'activity_log', 'comments']);

function walk(node: Record<string, any>, out: Array<Record<string, any>>): void { out.push(node); for (const c of node.Plans ?? []) walk(c, out); }

console.log('\n== 1+2. Endpoint latency and query plans (warm cache, sequential) ==');
for (const s of scenarios) {
  const token = tokens[s.who];
  for (let i = 0; i < 3; i++) await get(s.path, token); // warm-up
  const times: number[] = [];
  for (let i = 0; i < (s.runs ?? 30); i++) { const t = performance.now(); await get(s.path, token); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);

  capture = []; await get(s.path, token); const stmts = capture; capture = null;
  let slowest = 0; const seq: string[] = []; let discarded = 0;
  for (const st of stmts) {
    if (/^\s*select 1\s*$/i.test(st.text)) continue;
    const plan = ((await explainPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${st.text}`, st.values)).rows[0] as { 'QUERY PLAN': any })['QUERY PLAN'];
    const exec: number = plan[0]['Execution Time'];
    slowest = Math.max(slowest, exec);
    const nodes: Array<Record<string, any>> = []; walk(plan[0].Plan, nodes);
    const seqBig = nodes.filter((n) => /Seq Scan/.test(n['Node Type']) && BIG.has(n['Relation Name']));
    for (const n of seqBig) {
      const loops = n['Actual Loops'] ?? 1;
      const removed = (n['Rows Removed by Filter'] ?? 0) * loops;
      discarded += removed;
      seq.push(`${n['Relation Name']}(${Math.round((n['Actual Rows'] * loops + removed) / 1000)}k rows)`);
    }
    if (seqBig.length || exec > 50) flagged.push({ scenario: s.name, sql: st.text.replace(/\s+/g, ' ').slice(0, 160), ms: exec, seq: seq.join(', ') });
  }
  summaries.push({ scenario: s.name, p50: ms(pct(times, 50)), p95: ms(pct(times, 95)), max: ms(times[times.length - 1]!), sql: stmts.filter((x) => !/^\s*select 1\s*$/i.test(x.text)).length, slowestSql: ms(slowest), seqScans: seq.join(', ') || '-', rowsDiscarded: discarded ? discarded.toLocaleString() : '-' });
}
console.table(summaries.map((r) => ({ Scenario: r.scenario, 'p50 ms': r.p50, 'p95 ms': r.p95, 'max ms': r.max, 'SQL stmts': r.sql, 'slowest SQL ms': r.slowestSql, 'Seq scans on big tables': r.seqScans })));
if (flagged.length) { console.log('\nStatements that did a big-table sequential scan or took > 50 ms:'); for (const f of flagged) console.log(` - [${f.scenario}] ${ms(f.ms)} ms  ${f.seq || ''}\n     ${f.sql}`); }
else console.log('\nNo statement did a sequential scan of a big table or exceeded 50 ms.');

// ---- 3. keyset vs offset ---------------------------------------------------------------------------------------
console.log('\n== 3. Pagination at depth: OFFSET vs keyset (hottest project) ==');
async function execMs(sql: string, params: unknown[]): Promise<{ ms: number; buffers: number }> {
  const r: number[] = []; let buffers = 0;
  for (let i = 0; i < 7; i++) {
    const p = ((await explainPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0] as { 'QUERY PLAN': any })['QUERY PLAN'];
    r.push(p[0]['Execution Time']); buffers = (p[0].Plan['Shared Hit Blocks'] ?? 0) + (p[0].Plan['Shared Read Blocks'] ?? 0);
  }
  r.sort((a, b) => a - b); return { ms: r[3]!, buffers };
}
const rowsInHot = hot!.n;
const depths = [0, Math.floor(rowsInHot / 10), Math.floor(rowsInHot / 2), rowsInHot - 100];
const paging: Array<Record<string, string>> = [];
for (const depth of depths) {
  const [key] = await q<{ t: string; id: string }>(
    `SELECT created_at::text AS t, id FROM tasks WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC OFFSET $2 LIMIT 1`, [H, depth]);
  const off = await execMs(`SELECT id FROM tasks WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC OFFSET $2 LIMIT 25`, [H, depth]);
  const keyset = await execMs(
    `SELECT id FROM tasks WHERE project_id = $1 AND deleted_at IS NULL AND (created_at, id) <= ($2::timestamptz, $3::uuid) ORDER BY created_at DESC, id DESC LIMIT 25`, [H, key!.t, key!.id]);
  paging.push({ 'Rows skipped': depth.toLocaleString(), 'OFFSET ms': ms(off.ms), 'OFFSET buffers': off.buffers.toLocaleString(), 'Keyset ms': ms(keyset.ms), 'Keyset buffers': keyset.buffers.toLocaleString() });
}
console.table(paging);

// ---- 4. concurrent mixed load ----------------------------------------------------------------------------------
console.log('\n== 4. Concurrent mixed load (single Node process, pool of 10 DB connections) ==');
const mix: Array<[string, string]> = [
  ['regular', '/api/dashboard'], ['regular', '/api/projects?limit=25'], ['heavy', `/api/projects/${H}/tasks?limit=25`],
  ['regular', '/api/tasks?assignee=me'], ['heavy', `/api/projects/${H}/tasks?q=login`], ['heavy', `/api/projects/${H}`],
];
async function load(concurrency: number, seconds: number) {
  const lat: number[] = []; let errors = 0; const end = Date.now() + seconds * 1000; let n = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
    for (let i = w; Date.now() < end; i++) {
      const [who, path] = mix[(i + n++) % mix.length]!; const t = performance.now();
      try { await get(path, tokens[who as keyof typeof tokens]); lat.push(performance.now() - t); } catch { errors++; }
    }
  }));
  lat.sort((a, b) => a - b);
  return { Concurrency: String(concurrency), 'Req/s': String(Math.round(lat.length / seconds)), 'p50 ms': ms(pct(lat, 50)), 'p95 ms': ms(pct(lat, 95)), 'p99 ms': ms(pct(lat, 99)), Errors: String(errors) };
}
const loads = [];
for (const c of [1, 10, 50]) loads.push(await load(c, 8));
console.table(loads);

server.close(); await pool.end(); await explainPool.end();

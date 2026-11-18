#!/usr/bin/env node
// Loads a small, realistic demo workspace through the PUBLIC API (so it works against any running deployment).
//   BASE_URL=https://taskhub-xxxx.onrender.com node scripts/seed-demo.mjs
//   node scripts/seed-demo.mjs                      (defaults to http://localhost:8080)
// Safe to run twice: existing accounts are reused and projects are only created if the demo owner has none.
// The accounts below are public DEMO accounts with a published password; never reuse real credentials here.
const BASE = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const PASSWORD = 'demo-password-123';
const PEOPLE = [
  { name: 'Demo Owner', email: 'demo@taskhub.example' },
  { name: 'Amara Okafor', email: 'amara@taskhub.example' },
  { name: 'David Eze', email: 'david@taskhub.example' },
];

async function http(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}
const must = (r, what) => { if (r.status >= 300) throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.data)}`); return r.data; };

async function account({ name, email }) {
  let r = await http('POST', '/api/auth/register', null, { name, email, password: PASSWORD });
  if (r.status === 409) r = await http('POST', '/api/auth/login', null, { email, password: PASSWORD });
  const s = must(r, `sign-in for ${email}`);
  return { ...s.user, token: s.accessToken };
}

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const PROJECTS = [
  {
    name: 'Website Redesign',
    description: 'Refresh the marketing site: new homepage, pricing page and blog.',
    tasks: [
      ['Design new homepage hero', 'done', 'high', -3], ['Write pricing page copy', 'done', 'medium', -1],
      ['Build responsive navigation', 'in_progress', 'high', 1], ['Set up analytics events', 'in_progress', 'medium', 4],
      ['Review accessibility audit', 'in_review', 'urgent', 0], ['Optimise hero images', 'in_review', 'medium', 3],
      ['Choose new typography', 'todo', 'medium', -2], ['Migrate blog posts', 'todo', 'low', 10], ['Launch checklist', 'todo', 'high', 7],
    ],
  },
  {
    name: 'Mobile App Launch',
    description: 'Ship v1.0 to the App Store and Play Store.',
    tasks: [
      ['Finalise onboarding flow', 'in_progress', 'urgent', 2], ['Beta feedback triage', 'in_review', 'high', 1],
      ['Push notification setup', 'todo', 'high', 6], ['Store listing screenshots', 'todo', 'medium', 9],
    ],
  },
];

const [owner, amara, david] = await Promise.all(PEOPLE.map(account)).catch(async () => {
  // Parallel sign-ups can race on a cold server; fall back to one at a time.
  const out = [];
  for (const p of PEOPLE) out.push(await account(p));
  return out;
});

const existing = must(await http('GET', '/api/projects?limit=50', owner.token), 'list projects');
if (existing.items.length) {
  console.log(`Demo owner already has ${existing.items.length} project(s): nothing to create.`);
} else {
  for (const p of PROJECTS) {
    const project = must(await http('POST', '/api/projects', owner.token, { name: p.name, description: p.description }), 'create project');
    for (const m of [amara, david]) must(await http('POST', `/api/projects/${project.id}/members`, owner.token, { email: m.email }), 'add member');
    const assignees = [owner.id, amara.id, david.id, null];
    let i = 0;
    for (const [title, status, priority, due] of p.tasks) {
      const t = must(await http('POST', `/api/projects/${project.id}/tasks`, owner.token, { title, priority, assigneeId: assignees[i++ % 4], dueDate: day(due) }), 'create task');
      if (status !== 'todo') must(await http('PATCH', `/api/tasks/${t.id}`, owner.token, { status, version: t.version }), 'set status');
    }
    console.log(`Created "${p.name}" with ${p.tasks.length} tasks`);
  }
}
console.log(`\nDemo logins at ${BASE} (password: ${PASSWORD})\n  ${PEOPLE.map((p) => p.email).join('\n  ')}`);

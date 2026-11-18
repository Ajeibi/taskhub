import pg from 'pg';

export const testUrl = (): string =>
  process.env.TEST_DATABASE_URL ?? 'postgres://taskhub:taskhub@localhost:5432/taskhub_test';

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: testUrl(), max: 4 });
}

export async function resetData(db: pg.Pool): Promise<void> {
  await db.query('TRUNCATE users, projects RESTART IDENTITY CASCADE');
}

export async function makeUser(db: pg.Pool, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
    [email, email.split('@')[0]],
  );
  return rows[0]!.id;
}

/** Creates a project and its owner membership in one go. */
export async function makeProject(db: pg.Pool, ownerId: string, name = 'P'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id`,
    [name, ownerId],
  );
  const id = rows[0]!.id;
  await db.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, ownerId]);
  return id;
}

-- 0001_init: core schema.
-- Design rules:
--  * The database is the last line of defence: relationships and enums are enforced here,
--    not only in application code.
--  * Soft delete (deleted_at) on projects, tasks and comments so history is recoverable and
--    the activity log never dangles. Partial indexes keep deleted rows out of hot paths.
--  * `version` columns support optimistic locking (UPDATE ... WHERE id = $1 AND version = $2).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (email = lower(email) AND position('@' IN email) > 1)
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,      -- sha256 of the token; the raw token is never stored
  family_id   uuid        NOT NULL,             -- all tokens descended from one login; revoked together on reuse
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text        NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_by  uuid        NOT NULL REFERENCES users (id),
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED
);
CREATE INDEX projects_active_created_idx ON projects (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX projects_search_idx ON projects USING gin (search_vector);

-- Membership is the single source of truth for authorization AND for "who owns the project".
-- Exactly one owner per project is enforced by the partial unique index below.
CREATE TABLE project_members (
  project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text        NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);
CREATE UNIQUE INDEX project_members_one_owner_idx ON project_members (project_id) WHERE role = 'owner';

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title        text        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description  text        NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  status       text        NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
  priority     text        NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_id  uuid,
  creator_id   uuid        NOT NULL REFERENCES users (id),
  due_date     date,
  completed_at timestamptz,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED,
  -- An assignee MUST be a member of the task's project. With a NULL assignee_id the FK is not checked
  -- (MATCH SIMPLE), so unassigned tasks are allowed. If the member is removed from the project, only
  -- assignee_id is nulled (column-list SET NULL, PostgreSQL 15+), so the task becomes unassigned.
  CONSTRAINT tasks_assignee_is_member FOREIGN KEY (project_id, assignee_id)
    REFERENCES project_members (project_id, user_id) ON DELETE SET NULL (assignee_id),
  -- completed_at is set if and only if the task is done.
  CONSTRAINT tasks_completed_consistent CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX tasks_project_created_idx   ON tasks (project_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_status_idx    ON tasks (project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee_status_idx   ON tasks (assignee_id, status) WHERE deleted_at IS NULL AND assignee_id IS NOT NULL;
CREATE INDEX tasks_overdue_idx           ON tasks (due_date) WHERE deleted_at IS NULL AND status <> 'done' AND due_date IS NOT NULL;
CREATE INDEX tasks_search_idx            ON tasks USING gin (search_vector);

CREATE TABLE comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author_id  uuid        NOT NULL REFERENCES users (id),
  body       text        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comments_task_created_idx ON comments (task_id, created_at, id) WHERE deleted_at IS NULL;

-- Append-only audit trail. No FK to tasks on purpose: history must survive hard deletes
-- (e.g. a retention job purging old soft-deleted rows). metadata holds the before/after of changed fields.
CREATE TABLE activity_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id    uuid,
  actor_id   uuid        REFERENCES users (id) ON DELETE SET NULL,
  action     text        NOT NULL,   -- e.g. task.created, task.status_changed, member.added
  metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_project_idx ON activity_log (project_id, id DESC);
CREATE INDEX activity_task_idx    ON activity_log (task_id, id DESC) WHERE task_id IS NOT NULL;

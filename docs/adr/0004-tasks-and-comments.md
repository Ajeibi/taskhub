# ADR 0004: Tasks and comments

Status: accepted

## Rules enforced
| Rule | Where it is enforced |
|---|---|
| Task access = access to its project (non-members get 404) | `requireTask()` delegates to `requireProject()`; one authorization path |
| Assignee must be a project member | Friendly 422 pre-check **and** the composite foreign key. The FK is the guarantee: if a member is removed between the check and the write, the violation is mapped to the same 422 |
| `done` <=> `completed_at` set | Service sets/clears it from status; the DB CHECK refuses any disagreement |
| Archived projects are read-only for tasks and comments | `requireWritable()` -> 409 |
| Only creator, owner or admin may delete a task | service (403) |
| Comments: only the author edits; author or owner deletes | service (403) |
| Concurrent edits cannot silently overwrite each other | `version` + `UPDATE ... WHERE version = $n` -> 409 with current version |

## Design choices
- **Status transitions are free** (todo, in_progress, in_review, done in any order). Teams reopen and skip stages; a strict state machine would add rules nobody asked for. If a workflow is required later, it is a single validation function in `update()`.
- **Every mutation and its audit entry share one transaction.** Updates log one entry per kind of change (`task.status_changed`, `task.assigned`, `task.updated` with a before/after diff) so an activity feed can read naturally.
- **One list implementation** serves the per-project board (`/projects/:id/tasks`) and the cross-project view (`/tasks`: "my tasks", global search). Authorization is part of the query (membership join), not a post-filter, so a page can never contain, or be short-changed by, rows the caller may not see.
- **Filters** (status, priority, assignee `me|none|uuid`, overdue, text) are all parameterised; list values are validated against enums before reaching SQL.
- **Indexes serve the filters:** `(project_id, created_at, id)` for the board and cursor; `(assignee_id, status)` for "my tasks"; partial `due_date` index for overdue; GIN for text.
- **Due date is a calendar date**, read back as text (`YYYY-MM-DD`). Converting through a JS `Date` shifts the day in some time zones. "Overdue" uses the database's `current_date`, so the DB time zone (UTC in the container) defines "today".
- **Soft delete** for tasks and comments; deleted rows are excluded from lists, counts and search.

## Trade-offs / future work
- Ordering is fixed (newest first). Sorting by due date or priority needs a different keyset (e.g. `(due_date, id)` with NULL handling); it is the natural next feature.
- No total counts on lists (expensive at scale); the project view's per-status counts cover the monitoring need.
- Comments are plain text, no edit history or mentions.

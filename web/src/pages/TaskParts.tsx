import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api, ApiError, PRIORITIES, STATUS_LABEL, STATUSES,
  type Comment, type Member, type Page, type Priority, type ProjectDetail, type Status, type Task, type TaskDetail,
} from '../api';
import { useAuth } from '../auth';
import {
  Avatar, DueDate, ErrorBanner, fmtDate, fmtDateTime, Modal, PriorityFlag, SlideOver, Spinner, StatusIcon,
} from '../ui';

// ---- Optimistic-locking helper ------------------------------------------------------------------
/** Thrown when someone else changed the task first; `latest` is the fresh copy so the UI can refresh. */
export class StaleTask extends Error {
  constructor(public latest: Task) { super('Someone else just changed this task. It has been refreshed, so try again.'); }
}
export async function patchTask(task: { id: string; version: number }, patch: Record<string, unknown>): Promise<Task> {
  try {
    return await api<Task>(`/api/tasks/${task.id}`, { method: 'PATCH', body: { ...patch, version: task.version } });
  } catch (e) {
    if (e instanceof ApiError && e.isConflict) throw new StaleTask(await api<Task>(`/api/tasks/${task.id}`));
    throw e;
  }
}

// ---- Filters (toolbar) --------------------------------------------------------------------------
export interface Filters { q: string; status: string; priority: string; assignee: string; overdue: boolean }
export const NO_FILTERS: Filters = { q: '', status: '', priority: '', assignee: '', overdue: false };

export function TaskFilters({ value, onChange, withStatus }: { value: Filters; onChange: (f: Filters) => void; withStatus?: boolean }) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="toolbar" role="search" aria-label="Filter tasks">
      <input type="search" placeholder="Search tasksâ€¦" aria-label="Search tasks" value={value.q} onChange={(e) => set('q', e.target.value)} />
      {withStatus && (
        <select aria-label="Status" value={value.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      )}
      <select aria-label="Priority" value={value.priority} onChange={(e) => set('priority', e.target.value)}>
        <option value="">Any priority</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select aria-label="Assignee" value={value.assignee} onChange={(e) => set('assignee', e.target.value)}>
        <option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>
      </select>
      <label className="check"><input type="checkbox" checked={value.overdue} onChange={(e) => set('overdue', e.target.checked)} /> Overdue</label>
      {Object.values(value).some(Boolean) && <button className="ghost small" onClick={() => onChange({ ...NO_FILTERS })}>Clear</button>}
    </div>
  );
}

// ---- List row -----------------------------------------------------------------------------------
export function TaskRow({ task, showProject, onOpen, onStatus }: {
  task: Task; showProject?: boolean; onOpen: (t: Task) => void; onStatus: (t: Task, s: Status) => void;
}) {
  const done = task.status === 'done';
  return (
    <li className={`task-row cols ${done ? 'is-done' : ''}`}>
      <button className="status-btn" aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`} title={done ? 'Reopen' : 'Mark done'} onClick={() => onStatus(task, done ? 'todo' : 'done')}>
        <StatusIcon status={task.status} />
      </button>
      <div className="grow">
        <button className="title" onClick={() => onOpen(task)}>{task.title}</button>
        {showProject && <div className="sub"><Link to={`/projects/${task.projectId}`}>{task.projectName}</Link> Â· {STATUS_LABEL[task.status]}</div>}
      </div>
      <div className="assignee-cell"><Avatar name={task.assignee?.name} /><span>{task.assignee?.name ?? ''}</span></div>
      <DueDate iso={task.dueDate} overdue={task.isOverdue} />
      <PriorityFlag p={task.priority} />
    </li>
  );
}

// ---- Create -------------------------------------------------------------------------------------
export function NewTaskModal({ projectId, members, defaultStatus = 'todo', onClose, onCreated }: {
  projectId: string; members: Member[]; defaultStatus?: Status; onClose: () => void; onCreated: (t: Task) => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Status>(defaultStatus);
  const [priority, setPriority] = useState<Priority>('medium');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      let t = await api<Task>(`/api/projects/${projectId}/tasks`, {
        method: 'POST', body: { title, description, priority, assigneeId: assigneeId || null, dueDate: dueDate || null },
      });
      if (status !== 'todo') t = await patchTask(t, { status });
      onCreated(t);
      onClose();
    } catch (err) { setError(err); setBusy(false); }
  }
  return (
    <Modal title="New task" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <ErrorBanner error={error} />
        <label>Task name<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus placeholder="What needs to be done?" /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={10000} /></label>
        <div className="row">
          <label>Status<select value={status} onChange={(e) => setStatus(e.target.value as Status)}>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
          <label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label>Assignee
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === user?.id ? ' (me)' : ''}</option>)}
            </select>
          </label>
          <label>Due date<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        </div>
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Create task</button></footer>
      </form>
    </Modal>
  );
}

// ---- Detail panel: auto-saves each property; comments below -------------------------------------
export function TaskPanel({ taskId, onClose, onChanged, onDeleted }: {
  taskId: string; onClose: () => void; onChanged: (t: Task) => void; onDeleted: (id: string) => void;
}) {
  const { user } = useAuth();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [newComment, setNewComment] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const latest = useRef<TaskDetail | null>(null); // newest copy, so queued saves always use the current version
  const queue = useRef<Promise<void>>(Promise.resolve());
  const apply = (t: TaskDetail) => { latest.current = t; setTask(t); setTitle(t.title); setDescription(t.description); };
  const load = async () => {
    setError(null);
    try {
      const t = await api<TaskDetail>(`/api/tasks/${taskId}`);
      apply(t);
      const [p, c] = await Promise.all([api<ProjectDetail>(`/api/projects/${t.projectId}`), api<Page<Comment>>(`/api/tasks/${taskId}/comments?limit=100`)]);
      setProject(p); setComments(c.items);
    } catch (e) { setError(e); }
  };
  useEffect(() => { setTask(null); void load(); }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = project?.status === 'archived';
  const canModerate = project?.myRole === 'owner' || project?.myRole === 'admin';

  // Saves run one at a time. Two quick edits (e.g. status then assignee) would otherwise both carry the same
  // version, and the second would be rejected by optimistic locking as if someone else had edited the task.
  function save(patch: Record<string, unknown>): Promise<void> {
    queue.current = queue.current.then(async () => {
      const current = latest.current;
      if (!current || readOnly) return;
      setError(null);
      try {
        const updated = await patchTask(current, patch);
        apply({ ...current, ...updated });
        onChanged(updated);
      } catch (e) {
        if (e instanceof StaleTask) { apply({ ...current, ...e.latest }); onChanged(e.latest); }
        setError(e);
      }
    });
    return queue.current;
  }
  async function remove() {
    if (!task || !window.confirm(`Delete â€œ${task.title}â€?`)) return;
    try { await api(`/api/tasks/${task.id}`, { method: 'DELETE' }); onDeleted(task.id); onClose(); } catch (e) { setError(e); }
  }
  async function addComment(e: FormEvent) {
    e.preventDefault();
    try {
      const c = await api<Comment>(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { body: newComment } });
      setComments((prev) => [...prev, c]); setNewComment('');
    } catch (err) { setError(err); }
  }
  async function saveComment(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      const c = await api<Comment>(`/api/tasks/${taskId}/comments/${editing.id}`, { method: 'PATCH', body: { body: editing.body } });
      setComments((prev) => prev.map((x) => (x.id === c.id ? c : x)));
      setEditing(null);
    } catch (err) { setError(err); }
  }
  async function removeComment(id: string) {
    try { await api(`/api/tasks/${taskId}/comments/${id}`, { method: 'DELETE' }); setComments((prev) => prev.filter((c) => c.id !== id)); }
    catch (err) { setError(err); }
  }

  return (
    <SlideOver label="Task details" onClose={onClose}>
      <div className="so-top">
        {task && <><StatusIcon status={task.status} /><span className="muted small">in <Link to={`/projects/${task.projectId}`} onClick={onClose}>{task.projectName}</Link></span></>}
        <span className="spacer" />
        {task && !readOnly && (task.creator.id === user?.id || canModerate) && <button className="ghost danger-text small" onClick={() => void remove()}>Delete</button>}
        <button className="icon" onClick={onClose} aria-label="Close">Ã—</button>
      </div>
      <div className="so-body">
        {!task ? (error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Spinner />) : (
          <>
            <ErrorBanner error={error} />
            {readOnly && <p className="banner">This project is archived: tasks are read-only.</p>}
            <input className="title-input" aria-label="Task name" value={title} disabled={readOnly} maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => { if (title.trim() && title !== task.title) void save({ title }); else setTitle(task.title); }} />

            <dl className="props">
              <dt>Status</dt>
              <dd>
                <select aria-label="Status" value={task.status} disabled={readOnly} onChange={(e) => void save({ status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </dd>
              <dt>Assignee</dt>
              <dd style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                <Avatar name={task.assignee?.name} />
                <select aria-label="Assignee" value={task.assignee?.id ?? ''} disabled={readOnly} onChange={(e) => void save({ assigneeId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {(project?.members ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === user?.id ? ' (me)' : ''}</option>)}
                </select>
              </dd>
              <dt>Due date</dt>
              <dd><input type="date" aria-label="Due date" value={task.dueDate ?? ''} disabled={readOnly} onChange={(e) => void save({ dueDate: e.target.value || null })} /></dd>
              <dt>Priority</dt>
              <dd style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                <PriorityFlag p={task.priority} label={false} />
                <select aria-label="Priority" value={task.priority} disabled={readOnly} onChange={(e) => void save({ priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </dd>
              <dt>Created</dt>
              <dd className="muted small">{fmtDate(task.createdAt)} by {task.creator.name}{task.completedAt && <> Â· completed {fmtDate(task.completedAt)}</>}</dd>
            </dl>

            <h3>Description</h3>
            <textarea className="desc" aria-label="Description" placeholder="Add a descriptionâ€¦" value={description} disabled={readOnly} maxLength={10000}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => { if (description !== task.description) void save({ description }); }} />

            <section aria-label="Comments" className="comments">
              <h3>Comments ({comments.length})</h3>
              {comments.length === 0 && <p className="muted small">No comments yet.</p>}
              {comments.map((c) => (
                <div className="comment" key={c.id}>
                  <Avatar name={c.author.name} size="lg" />
                  <div className="grow">
                    <b>{c.author.name}</b> <span className="muted small">{fmtDateTime(c.createdAt)}{c.edited ? ' (edited)' : ''}</span>
                    {!readOnly && (c.author.id === user?.id || canModerate) && <button className="link right small danger-text" onClick={() => void removeComment(c.id)}>Delete</button>}
                    {!readOnly && c.author.id === user?.id && editing?.id !== c.id && <button className="link right small" style={{ marginRight: '.7rem' }} onClick={() => setEditing({ id: c.id, body: c.body })}>Edit</button>}
                    {editing?.id === c.id ? (
                      <form className="composer" onSubmit={(e) => void saveComment(e)}>
                        <input autoFocus aria-label="Edit comment" value={editing.body} maxLength={5000} required
                          onChange={(e) => setEditing({ id: c.id, body: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} />
                        <button className="primary">Save</button>
                        <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : <p className="pre">{c.body}</p>}
                  </div>
                </div>
              ))}
              {!readOnly && (
                <form onSubmit={addComment} className="composer">
                  <Avatar name={user?.name} size="lg" />
                  <input value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Write a commentâ€¦" aria-label="New comment" maxLength={5000} required />
                  <button className="primary">Comment</button>
                </form>
              )}
            </section>
          </>
        )}
      </div>
    </SlideOver>
  );
}


import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api, ApiError, PRIORITIES, STATUS_LABEL, STATUSES,
  type Comment, type Member, type Page, type Priority, type ProjectDetail, type Status, type Task, type TaskDetail,
} from '../api';
import { useAuth } from '../auth';
import { ErrorBanner, fmtDate, fmtDateTime, Modal, PriorityBadge, Spinner, errorMessage } from '../ui';

// ---- Filters ------------------------------------------------------------------------------------
export interface Filters { q: string; status: string; priority: string; assignee: string; overdue: boolean }
export const NO_FILTERS: Filters = { q: '', status: '', priority: '', assignee: '', overdue: false };

export function TaskFilters({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="filters" role="search" aria-label="Filter tasks">
      <input type="search" placeholder="Search tasks…" aria-label="Search tasks" value={value.q} onChange={(e) => set('q', e.target.value)} />
      <select aria-label="Status" value={value.status} onChange={(e) => set('status', e.target.value)}>
        <option value="">Any status</option>
        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <select aria-label="Priority" value={value.priority} onChange={(e) => set('priority', e.target.value)}>
        <option value="">Any priority</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select aria-label="Assignee" value={value.assignee} onChange={(e) => set('assignee', e.target.value)}>
        <option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>
      </select>
      <label className="check"><input type="checkbox" checked={value.overdue} onChange={(e) => set('overdue', e.target.checked)} /> Overdue</label>
    </div>
  );
}

// ---- Row ----------------------------------------------------------------------------------------
export function TaskRow({ task, showProject, onOpen, onUpdated }: {
  task: Task; showProject?: boolean; onOpen: (t: Task) => void; onUpdated: (t: Task) => void;
}) {
  const [err, setErr] = useState<unknown>(null);
  async function changeStatus(status: Status) {
    setErr(null);
    try { onUpdated(await api<Task>(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status, version: task.version } })); }
    catch (e) {
      setErr(e);
      if (e instanceof ApiError && e.isConflict) onUpdated(await api<Task>(`/api/tasks/${task.id}`).catch(() => task)); // show the latest
    }
  }
  return (
    <li className={`task ${task.status === 'done' ? 'is-done' : ''}`}>
      <div className="grow">
        <button className="link title" onClick={() => onOpen(task)}>{task.title}</button>
        <div className="muted small">
          {showProject && <><Link to={`/projects/${task.projectId}`}>{task.projectName}</Link> · </>}
          {task.assignee ? task.assignee.name : 'Unassigned'}
          {task.dueDate && <> · <span className={task.isOverdue ? 'overdue' : ''}>due {fmtDate(task.dueDate)}{task.isOverdue ? ' (overdue)' : ''}</span></>}
        </div>
        {err != null && <p className="small overdue" role="alert">{errorMessage(err)}</p>}
      </div>
      <PriorityBadge p={task.priority} />
      <select aria-label={`Status of ${task.title}`} value={task.status} onChange={(e) => void changeStatus(e.target.value as Status)}>
        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
    </li>
  );
}

// ---- Create -------------------------------------------------------------------------------------
export function NewTaskModal({ projectId, members, onClose, onCreated }: {
  projectId: string; members: Member[]; onClose: () => void; onCreated: (t: Task) => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      onCreated(await api<Task>(`/api/projects/${projectId}/tasks`, {
        method: 'POST', body: { title, description, priority, assigneeId: assigneeId || null, dueDate: dueDate || null },
      }));
      onClose();
    } catch (err) { setError(err); setBusy(false); }
  }
  return (
    <Modal title="New task" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <ErrorBanner error={error} />
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={10000} /></label>
        <div className="row">
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

// ---- Detail / edit / comments -------------------------------------------------------------------
export function TaskModal({ taskId, onClose, onChanged, onDeleted }: {
  taskId: string; onClose: () => void; onChanged: (t: Task) => void; onDeleted: (id: string) => void;
}) {
  const { user } = useAuth();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [form, setForm] = useState({ title: '', description: '', status: 'todo' as Status, priority: 'medium' as Priority, assigneeId: '', dueDate: '' });
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newComment, setNewComment] = useState('');

  const apply = (t: TaskDetail) => {
    setTask(t);
    setForm({ title: t.title, description: t.description, status: t.status, priority: t.priority, assigneeId: t.assignee?.id ?? '', dueDate: t.dueDate ?? '' });
  };
  const load = async () => {
    setError(null); setConflict(false);
    try {
      const t = await api<TaskDetail>(`/api/tasks/${taskId}`);
      apply(t);
      const [p, c] = await Promise.all([api<ProjectDetail>(`/api/projects/${t.projectId}`), api<Page<Comment>>(`/api/tasks/${taskId}/comments?limit=100`)]);
      setProject(p); setComments(c.items);
    } catch (e) { setError(e); }
  };
  useEffect(() => { void load(); }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = project?.status === 'archived';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!task) return;
    // Send only what changed, plus the version we edited from (optimistic locking).
    const patch: Record<string, unknown> = { version: task.version };
    if (form.title !== task.title) patch.title = form.title;
    if (form.description !== task.description) patch.description = form.description;
    if (form.status !== task.status) patch.status = form.status;
    if (form.priority !== task.priority) patch.priority = form.priority;
    if (form.assigneeId !== (task.assignee?.id ?? '')) patch.assigneeId = form.assigneeId || null;
    if (form.dueDate !== (task.dueDate ?? '')) patch.dueDate = form.dueDate || null;
    if (Object.keys(patch).length === 1) return onClose();
    setBusy(true); setError(null); setConflict(false);
    try {
      const updated = await api<Task>(`/api/tasks/${task.id}`, { method: 'PATCH', body: patch });
      onChanged(updated);
      onClose();
    } catch (err) {
      setError(err);
      setConflict(err instanceof ApiError && err.isConflict);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!task || !window.confirm(`Delete “${task.title}”?`)) return;
    try { await api(`/api/tasks/${task.id}`, { method: 'DELETE' }); onDeleted(task.id); onClose(); } catch (e) { setError(e); }
  }

  async function addComment(e: FormEvent) {
    e.preventDefault();
    try {
      const c = await api<Comment>(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { body: newComment } });
      setComments((prev) => [...prev, c]); setNewComment('');
    } catch (err) { setError(err); }
  }
  async function removeComment(id: string) {
    try { await api(`/api/tasks/${taskId}/comments/${id}`, { method: 'DELETE' }); setComments((prev) => prev.filter((c) => c.id !== id)); }
    catch (err) { setError(err); }
  }

  const canModerate = project?.myRole === 'owner' || project?.myRole === 'admin';
  return (
    <Modal title="Task" onClose={onClose} wide>
      {!task ? (error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Spinner />) : (
        <>
          <form onSubmit={save} className="form">
            {error != null && (
              <div className="banner error" role="alert">
                <span>{conflict ? 'Someone else changed this task while you were editing. Reload to see their changes (your edits will be discarded).' : errorMessage(error)}</span>
                {conflict && <button type="button" className="link" onClick={() => void load()}>Reload</button>}
              </div>
            )}
            {readOnly && <p className="banner">This project is archived: tasks are read-only.</p>}
            <fieldset disabled={readOnly || busy}>
              <label>Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={200} /></label>
              <label>Description<textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={10000} /></label>
              <div className="row">
                <label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
                <label>Priority<select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
                <label>Assignee
                  <select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
                    <option value="">Unassigned</option>
                    {(project?.members ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                  </select>
                </label>
                <label>Due date<input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></label>
              </div>
            </fieldset>
            <p className="muted small">
              In <Link to={`/projects/${task.projectId}`} onClick={onClose}>{task.projectName}</Link> · created by {task.creator.name} on {fmtDate(task.createdAt)}
              {task.completedAt && <> · completed {fmtDate(task.completedAt)}</>}
            </p>
            <footer>
              {!readOnly && (task.creator.id === user?.id || canModerate) && <button type="button" className="danger" onClick={() => void remove()}>Delete</button>}
              <span className="spacer" />
              <button type="button" onClick={onClose}>Close</button>
              {!readOnly && <button className="primary" disabled={busy}>Save changes</button>}
            </footer>
          </form>

          <section aria-label="Comments" className="comments">
            <h3>Comments ({comments.length})</h3>
            {comments.length === 0 && <p className="muted small">No comments yet.</p>}
            <ul className="list">
              {comments.map((c) => (
                <li key={c.id}>
                  <div><b>{c.author.name}</b> <span className="muted small">{fmtDateTime(c.createdAt)}{c.edited ? ' (edited)' : ''}</span>
                    {!readOnly && (c.author.id === user?.id || canModerate) && <button className="link right small" onClick={() => void removeComment(c.id)}>Delete</button>}
                  </div>
                  <p className="pre">{c.body}</p>
                </li>
              ))}
            </ul>
            {!readOnly && (
              <form onSubmit={addComment} className="inline">
                <input value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Write a comment…" aria-label="New comment" maxLength={5000} required />
                <button className="primary">Post</button>
              </form>
            )}
          </section>
        </>
      )}
    </Modal>
  );
}

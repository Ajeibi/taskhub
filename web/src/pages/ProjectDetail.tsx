import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, qs, STATUSES, STATUS_LABEL, type Project, type ProjectDetail as Detail, type ProjectStatus, type Status, type Task } from '../api';
import { useAuth } from '../auth';
import { usePaged } from '../hooks';
import { useProjects } from '../projects-context';
import {
  Avatar, AvatarStack, DueDate, ErrorBanner, errorMessage, Modal, PriorityFlag, ProgressBar, ProjectIcon, Spinner, StatusIcon, StatusPill, useDebounced,
} from '../ui';
import { NewTaskModal, NO_FILTERS, patchTask, TaskFilters, TaskPanel, TaskRow, type Filters } from './TaskParts';

type View = 'list' | 'board' | 'overview';
const VIEWS: Array<{ id: View; label: string }> = [{ id: 'list', label: 'List' }, { id: 'board', label: 'Board' }, { id: 'overview', label: 'Overview' }];

// ---- One status bucket: its own cursor-paginated feed; reloads when `rev` changes ------------------
function useBucket(projectId: string, status: Status, f: Filters, q: string, rev: number) {
  const list = usePaged<Task>(`/api/projects/${projectId}/tasks${qs({ q, status, priority: f.priority, assignee: f.assignee, overdue: f.overdue, limit: 25 })}`);
  const first = useRef(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (first.current) { first.current = false; return; } list.reload(); }, [rev]);
  return list;
}

interface BucketProps {
  projectId: string; status: Status; filters: Filters; q: string; rev: number; total: number; filtered: boolean; writable: boolean;
  onOpen: (t: Task) => void; onMove: (t: Task, s: Status) => void; onAdd: (title: string, s: Status) => Promise<void>;
}

function QuickAdd({ status, onAdd, variant }: { status: Status; onAdd: BucketProps['onAdd']; variant: 'row' | 'card' }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try { await onAdd(title.trim(), status); setTitle(''); } finally { setBusy(false); }
  }
  if (!open) return <button className={variant === 'card' ? 'ghost add-card' : 'ghost small'} onClick={() => setOpen(true)}>+ Add task</button>;
  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: '.4rem', width: '100%' }}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task name, then Enter" aria-label={`New ${STATUS_LABEL[status]} task`} maxLength={200} disabled={busy}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setTitle(''); } }} />
      <button className="primary" disabled={busy || !title.trim()}>Add</button>
    </form>
  );
}

function ListGroup(p: BucketProps) {
  const list = useBucket(p.projectId, p.status, p.filters, p.q, p.rev);
  const [collapsed, setCollapsed] = useState(false);
  if (p.filtered && !list.loading && list.items.length === 0) return null;
  const count = p.filtered ? `${list.items.length}${list.hasMore ? '+' : ''}` : String(p.total);
  return (
    <section className="group" aria-label={STATUS_LABEL[p.status]}>
      <div className="group-head">
        <button className="toggle" aria-label={collapsed ? 'Expand' : 'Collapse'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }}><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
        <StatusPill s={p.status} />
        <span className="count">{count}</span>
      </div>
      {!collapsed && (
        <>
          <ErrorBanner error={list.error} onRetry={list.reload} />
          <ul style={{ margin: 0, padding: 0 }}>
            {list.items.map((t) => <TaskRow key={t.id} task={t} onOpen={p.onOpen} onStatus={p.onMove} />)}
          </ul>
          {list.hasMore && <button className="ghost small" style={{ margin: '.4rem 1.5rem' }} onClick={list.loadMore} disabled={list.loading}>{list.loading ? 'Loading…' : 'Load more'}</button>}
          {p.writable && !p.filtered && <div className="add-row"><QuickAdd status={p.status} onAdd={p.onAdd} variant="row" /></div>}
        </>
      )}
    </section>
  );
}

function BoardColumn(p: BucketProps & { drag: Task | null; setDrag: (t: Task | null) => void }) {
  const list = useBucket(p.projectId, p.status, p.filters, p.q, p.rev);
  const [over, setOver] = useState(false);
  const count = p.filtered ? `${list.items.length}${list.hasMore ? '+' : ''}` : String(p.total);
  return (
    <section className={`column${over ? ' over' : ''}`} aria-label={STATUS_LABEL[p.status]}
      onDragOver={(e) => { if (p.drag && p.writable) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (p.drag && p.drag.status !== p.status) p.onMove(p.drag, p.status); p.setDrag(null); }}>
      <header><StatusPill s={p.status} /><span className="muted small">{count}</span></header>
      <ErrorBanner error={list.error} onRetry={list.reload} />
      <div className="cards-col">
        {list.items.map((t) => (
          <article key={t.id} className={`task-card${p.drag?.id === t.id ? ' dragging' : ''}`} draggable={p.writable}
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; p.setDrag(t); }}
            onDragEnd={() => p.setDrag(null)}>
            <button className="title" onClick={() => p.onOpen(t)}>{t.title}</button>
            <div className="meta">
              <Avatar name={t.assignee?.name} size="sm" />
              <DueDate iso={t.dueDate} overdue={t.isOverdue} />
              <span className="right"><PriorityFlag p={t.priority} label={false} /></span>
            </div>
          </article>
        ))}
      </div>
      {list.hasMore && <button className="ghost small" onClick={list.loadMore} disabled={list.loading}>{list.loading ? 'Loading…' : 'Load more'}</button>}
      {p.writable && !p.filtered && <QuickAdd status={p.status} onAdd={p.onAdd} variant="card" />}
    </section>
  );
}

// ---- Edit + team ---------------------------------------------------------------------------------
function EditProjectModal({ project, onClose, onSaved }: { project: Detail; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { await api<Project>(`/api/projects/${project.id}`, { method: 'PATCH', body: { name, description, status, version: project.version } }); onSaved(); onClose(); }
    catch (err) { setError(err); }
  }
  const conflict = error instanceof ApiError && error.isConflict;
  return (
    <Modal title="Edit project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        {error != null && <div className="banner error" role="alert"><span>{conflict ? 'Someone else changed this project. Close and reopen to see the latest.' : errorMessage(error)}</span></div>}
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
        <label>Description<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></label>
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            <option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived (read-only)</option>
          </select>
        </label>
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary">Save</button></footer>
      </form>
    </Modal>
  );
}

function Members({ project, canManage, meId, onChanged }: { project: Detail; canManage: boolean; meId: string; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q);
  const [matches, setMatches] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (debounced.trim().length < 2) { setMatches([]); return; }
    let live = true;
    api<{ items: typeof matches }>(`/api/users${qs({ q: debounced })}`).then((r) => live && setMatches(r.items.filter((u) => !project.members.some((m) => m.userId === u.id)))).catch(() => {});
    return () => { live = false; };
  }, [debounced, project.members]);

  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); onChanged(); } catch (e) { setError(e); } };
  return (
    <section className="card" aria-label="Team">
      <h2>Team ({project.members.length})</h2>
      <ErrorBanner error={error} />
      <ul className="list">
        {project.members.map((m) => (
          <li key={m.userId}>
            <Avatar name={m.name} />
            <span>{m.name}{m.userId === meId ? ' (you)' : ''}</span> <span className="muted small">{m.email}</span>
            <span className="right">
              {m.role === 'owner' ? <span className="badge">owner</span> : (
                <>
                  {canManage && <button className="link small" onClick={() => void run(() => api(`/api/projects/${project.id}/members/${m.userId}`, { method: 'PATCH', body: { role: 'owner' } }))}>Make owner</button>}{' '}
                  {(canManage || m.userId === meId) && <button className="link small danger-text" onClick={() => { if (window.confirm(m.userId === meId ? 'Leave this project?' : `Remove ${m.name}? Their tasks become unassigned.`)) void run(() => api(`/api/projects/${project.id}/members/${m.userId}`, { method: 'DELETE' })); }}>{m.userId === meId ? 'Leave' : 'Remove'}</button>}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="add-member">
          <input type="search" placeholder="Add by name or email…" aria-label="Find people to add" value={q} onChange={(e) => setQ(e.target.value)} />
          {matches.length > 0 && (
            <ul className="menu">
              {matches.map((u) => (
                <li key={u.id}><button onClick={() => void run(async () => { await api(`/api/projects/${project.id}/members`, { method: 'POST', body: { email: u.email } }); setQ(''); setMatches([]); })}>{u.name} <span className="muted small">{u.email}</span></button></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ---- Page ----------------------------------------------------------------------------------------
export default function ProjectDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const sidebar = useProjects();
  const [params, setParams] = useSearchParams();
  const [project, setProject] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rev, setRev] = useState(0);
  const [drag, setDrag] = useState<Task | null>(null);
  const q = useDebounced(filters.q);
  const view = (VIEWS.find((v) => v.id === params.get('view'))?.id ?? 'list') as View;

  const loadProject = useCallback(() => { api<Detail>(`/api/projects/${id}`).then((p) => { setProject(p); setError(null); }).catch(setError); }, [id]);
  useEffect(() => { setProject(null); setFilters(NO_FILTERS); loadProject(); }, [loadProject]);

  const refresh = () => { setRev((r) => r + 1); loadProject(); };
  const openId = params.get('task');
  const setParam = (key: string, value: string | null) => setParams((p) => { if (value) p.set(key, value); else p.delete(key); return p; }, { replace: true });

  async function move(t: Task, status: Status) {
    setNotice(null);
    try { await patchTask(t, { status }); } catch (e) { setNotice(errorMessage(e)); }
    refresh();
  }
  async function quickAdd(title: string, status: Status) {
    setNotice(null);
    try {
      let t = await api<Task>(`/api/projects/${id}/tasks`, { method: 'POST', body: { title } });
      if (status !== 'todo') t = await patchTask(t, { status });
    } catch (e) { setNotice(errorMessage(e)); }
    refresh();
  }

  if (error instanceof ApiError && error.status === 404) return <div className="page-body"><div className="card"><h1>Project not found</h1><p className="muted">It may have been deleted, or you may not have access.</p></div></div>;
  if (error) return <div className="page-body"><ErrorBanner error={error} onRetry={loadProject} /></div>;
  if (!project) return <div className="page-body"><Spinner /></div>;

  const canManage = project.myRole === 'owner' || project.myRole === 'admin';
  const archived = project.status === 'archived';
  const filtered = Boolean(q || filters.priority || filters.assignee || filters.overdue);
  const totals: Record<Status, number> = { todo: project.taskCounts.todo, in_progress: project.taskCounts.inProgress, in_review: project.taskCounts.inReview, done: project.taskCounts.done };
  const bucket = (s: Status): BucketProps => ({
    projectId: id, status: s, filters, q, rev, total: totals[s], filtered, writable: !archived,
    onOpen: (t) => setParam('task', t.id), onMove: (t, to) => void move(t, to), onAdd: quickAdd,
  });

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <ProjectIcon id={project.id} name={project.name} large />
          <h1>{project.name}</h1>
          {project.status !== 'active' && <span className="badge">{project.status}</span>}
          <AvatarStack names={project.members.map((m) => m.name)} />
          <div className="actions">
            {canManage && <button className="ghost" onClick={() => setEditing(true)}>Edit</button>}
            {canManage && (
              <button className="ghost danger-text" onClick={async () => {
                if (!window.confirm(`Delete project “${project.name}”?`)) return;
                try { await api(`/api/projects/${project.id}`, { method: 'DELETE' }); sidebar.reload(); navigate('/projects'); } catch (e) { setNotice(errorMessage(e)); }
              }}>Delete</button>
            )}
            <button className="primary" disabled={archived} title={archived ? 'Archived projects are read-only' : undefined} onClick={() => setCreating(true)}>+ Add task</button>
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={`tab${view === v.id ? ' active' : ''}`} onClick={() => setParam('view', v.id === 'list' ? null : v.id)}>{v.label}</button>
          ))}
        </div>
      </div>

      {notice && <div className="banner error" role="alert" style={{ margin: '.7rem 1.5rem 0' }}><span>{notice}</span><button className="link right" onClick={() => setNotice(null)}>Dismiss</button></div>}

      {view !== 'overview' && <TaskFilters value={filters} onChange={setFilters} />}

      {view === 'list' && (
        <div className="page-body flush">
          <div className="cols list-head"><span /><span>Name</span><span>Assignee</span><span>Due date</span><span>Priority</span></div>
          {STATUSES.map((s) => <ListGroup key={s} {...bucket(s)} />)}
          {!filtered && project.taskCounts.total === 0 && <p className="empty"><strong>No tasks yet</strong>Use “+ Add task” under a status to create the first one.</p>}
        </div>
      )}

      {view === 'board' && (
        <div className="board">
          {STATUSES.map((s) => <BoardColumn key={s} {...bucket(s)} drag={drag} setDrag={setDrag} />)}
        </div>
      )}

      {view === 'overview' && (
        <div className="page-body">
          {project.description && <p className="pre" style={{ marginTop: 0 }}>{project.description}</p>}
          <div className="grid2">
            <section className="card" aria-label="Progress">
              <h2>Progress</h2>
              <ProgressBar counts={project.taskCounts} />
              <dl className="counts">
                {STATUSES.map((s) => <div key={s}><dt><StatusIcon status={s} size={12} /> {STATUS_LABEL[s]}</dt><dd>{totals[s]}</dd></div>)}
              </dl>
            </section>
            <Members project={project} canManage={canManage} meId={user?.id ?? ''} onChanged={loadProject} />
          </div>
        </div>
      )}

      {creating && <NewTaskModal projectId={id} members={project.members} onClose={() => setCreating(false)} onCreated={refresh} />}
      {openId && <TaskPanel taskId={openId} onClose={() => setParam('task', null)} onChanged={refresh} onDeleted={refresh} />}
      {editing && <EditProjectModal project={project} onClose={() => setEditing(false)} onSaved={() => { loadProject(); sidebar.reload(); }} />}
    </>
  );
}

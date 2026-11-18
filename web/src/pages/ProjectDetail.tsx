import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, qs, type Project, type ProjectDetail as Detail, type ProjectStatus, type Task } from '../api';
import { useAuth } from '../auth';
import { usePaged } from '../hooks';
import { ErrorBanner, errorMessage, Modal, ProgressBar, Spinner, useDebounced } from '../ui';
import { NewTaskModal, NO_FILTERS, TaskFilters, TaskModal, TaskRow, type Filters } from './TaskParts';

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
            <span>{m.name}{m.userId === meId ? ' (you)' : ''}</span> <span className="muted small">{m.email}</span>
            <span className="right">
              {m.role === 'owner' ? <span className="badge">owner</span> : (
                <>
                  {canManage && <button className="link small" onClick={() => void run(() => api(`/api/projects/${project.id}/members/${m.userId}`, { method: 'PATCH', body: { role: 'owner' } }))}>Make owner</button>}
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

export default function ProjectDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [project, setProject] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(filters.q);

  const loadProject = useCallback(() => { api<Detail>(`/api/projects/${id}`).then((p) => { setProject(p); setError(null); }).catch(setError); }, [id]);
  useEffect(() => { setProject(null); loadProject(); }, [loadProject]);

  const list = usePaged<Task>(`/api/projects/${id}/tasks${qs({ q, status: filters.status, priority: filters.priority, assignee: filters.assignee, overdue: filters.overdue, limit: 25 })}`);
  const openId = params.get('task');
  const closeTask = () => setParams((p) => { p.delete('task'); return p; }, { replace: true });
  const replace = (t: Task) => { list.setItems((items) => items.map((x) => (x.id === t.id ? t : x))); loadProject(); };

  if (error instanceof ApiError && error.status === 404) return <div className="card"><h1>Project not found</h1><p className="muted">It may have been deleted, or you may not have access.</p></div>;
  if (error) return <ErrorBanner error={error} onRetry={loadProject} />;
  if (!project) return <Spinner />;

  const canManage = project.myRole === 'owner' || project.myRole === 'admin';
  const archived = project.status === 'archived';

  return (
    <>
      <div className="head">
        <div>
          <h1>{project.name}</h1>
          <p className="muted small">{project.status} · you are {project.myRole === 'admin' ? 'an admin' : `the ${project.myRole === 'owner' ? 'owner' : 'a member'}`}</p>
        </div>
        {canManage && (
          <div className="actions">
            <button onClick={() => setEditing(true)}>Edit</button>
            <button className="danger" onClick={async () => { if (window.confirm(`Delete project “${project.name}”?`)) { await api(`/api/projects/${project.id}`, { method: 'DELETE' }).catch(setError); navigate('/projects'); } }}>Delete</button>
          </div>
        )}
      </div>
      {project.description && <p className="pre">{project.description}</p>}

      <div className="grid2 wide-left">
        <section className="card" aria-label="Progress">
          <h2>Progress</h2>
          <ProgressBar counts={project.taskCounts} />
          <dl className="counts">
            <div><dt>To do</dt><dd>{project.taskCounts.todo}</dd></div>
            <div><dt>In progress</dt><dd>{project.taskCounts.inProgress}</dd></div>
            <div><dt>In review</dt><dd>{project.taskCounts.inReview}</dd></div>
            <div><dt>Done</dt><dd>{project.taskCounts.done}</dd></div>
          </dl>
        </section>
        <Members project={project} canManage={canManage} meId={user?.id ?? ''} onChanged={loadProject} />
      </div>

      <div className="head">
        <h2>Tasks</h2>
        <button className="primary" disabled={archived} title={archived ? 'Archived projects are read-only' : undefined} onClick={() => setCreating(true)}>New task</button>
      </div>
      <TaskFilters value={filters} onChange={setFilters} />
      <ErrorBanner error={list.error} onRetry={list.reload} />
      {list.loading && list.items.length === 0 ? <Spinner /> : list.items.length === 0 && !list.error ? (
        <p className="card muted">{Object.values(filters).some(Boolean) ? 'No tasks match these filters.' : 'No tasks yet. Create the first one.'}</p>
      ) : (
        <ul className="card tasks">
          {list.items.map((t) => <TaskRow key={t.id} task={t} onOpen={(x) => setParams({ task: x.id })} onUpdated={replace} />)}
        </ul>
      )}
      {list.hasMore && <button className="center-btn" onClick={list.loadMore} disabled={list.loading}>{list.loading ? 'Loading…' : 'Load more'}</button>}

      {creating && <NewTaskModal projectId={id} members={project.members} onClose={() => setCreating(false)} onCreated={() => { list.reload(); loadProject(); }} />}
      {openId && <TaskModal taskId={openId} onClose={closeTask} onChanged={replace} onDeleted={() => { list.reload(); loadProject(); }} />}
      {editing && <EditProjectModal project={project} onClose={() => setEditing(false)} onSaved={loadProject} />}
    </>
  );
}

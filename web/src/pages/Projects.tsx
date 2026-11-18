import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs, type Project } from '../api';
import { usePaged } from '../hooks';
import { useProjects } from '../projects-context';
import { ErrorBanner, Modal, ProgressBar, ProjectIcon, Spinner, useDebounced } from '../ui';

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const sidebar = useProjects();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { const p = await api<Project>('/api/projects', { method: 'POST', body: { name, description } }); sidebar.reload(); navigate(`/projects/${p.id}`); }
    catch (err) { setError(err); setBusy(false); }
  }
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <ErrorBanner error={error} />
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus placeholder="e.g. Website redesign" /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} /></label>
        <p className="muted small">You become the owner. Add team members after creating it.</p>
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Create project</button></footer>
      </form>
    </Modal>
  );
}

export default function Projects() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const debounced = useDebounced(q);
  const list = usePaged<Project>(`/api/projects${qs({ q: debounced, status, limit: 12 })}`);
  const creating = params.get('new') === '1';
  const setCreating = (v: boolean) => setParams(v ? { new: '1' } : {}, { replace: true });

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>All projects</h1>
          <div className="actions"><button className="primary" onClick={() => setCreating(true)}>+ New project</button></div>
        </div>
      </div>
      <div className="toolbar" role="search" aria-label="Filter projects">
        <input type="search" placeholder="Search projects…" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option>
        </select>
      </div>
      <div className="page-body">
        <ErrorBanner error={list.error} onRetry={list.reload} />
        {list.loading && list.items.length === 0 ? <Spinner /> : list.items.length === 0 && !list.error ? (
          <p className="empty"><strong>{q || status ? 'No projects match your search' : 'No projects yet'}</strong>{q || status ? 'Try a different search.' : 'Create your first project to get started.'}</p>
        ) : (
          <ul className="cards">
            {list.items.map((p) => (
              <li key={p.id} className="card project">
                <div className="top">
                  <ProjectIcon id={p.id} name={p.name} large />
                  <div className="grow">
                    <h2><Link to={`/projects/${p.id}`}>{p.name}</Link></h2>
                    <span className="muted small">{p.status !== 'active' ? `${p.status} · ` : ''}{p.myRole}</span>
                  </div>
                </div>
                <p className="clamp">{p.description || 'No description'}</p>
                <ProgressBar counts={p.taskCounts} />
              </li>
            ))}
          </ul>
        )}
        {list.hasMore && <button className="center-btn" onClick={list.loadMore} disabled={list.loading}>{list.loading ? 'Loading…' : 'Load more'}</button>}
      </div>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}


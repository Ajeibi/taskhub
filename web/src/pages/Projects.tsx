import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs, type Project } from '../api';
import { usePaged } from '../hooks';
import { ErrorBanner, Modal, ProgressBar, Spinner, useDebounced } from '../ui';

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { const p = await api<Project>('/api/projects', { method: 'POST', body: { name, description } }); navigate(`/projects/${p.id}`); }
    catch (err) { setError(err); setBusy(false); }
  }
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <ErrorBanner error={error} />
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} /></label>
        <p className="muted small">You become the owner. Add team members after creating it.</p>
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Create project</button></footer>
      </form>
    </Modal>
  );
}

export default function Projects() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const debounced = useDebounced(q);
  const list = usePaged<Project>(`/api/projects${qs({ q: debounced, status, limit: 12 })}`);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="head">
        <h1>Projects</h1>
        <button className="primary" onClick={() => setCreating(true)}>New project</button>
      </div>
      <div className="filters" role="search" aria-label="Filter projects">
        <input type="search" placeholder="Search projects…" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option>
        </select>
      </div>
      <ErrorBanner error={list.error} onRetry={list.reload} />
      {list.loading && list.items.length === 0 ? <Spinner /> : list.items.length === 0 && !list.error ? (
        <p className="card muted">{q || status ? 'No projects match your search.' : 'No projects yet. Create your first project to get started.'}</p>
      ) : (
        <ul className="cards">
          {list.items.map((p) => (
            <li key={p.id} className="card project">
              <h2><Link to={`/projects/${p.id}`}>{p.name}</Link></h2>
              <p className="muted small">{p.status}{p.status !== 'active' ? ' · ' : ''}{p.myRole === 'owner' ? ' owner' : p.myRole === 'admin' ? ' admin' : ' member'}</p>
              <p className="clamp">{p.description || <span className="muted">No description</span>}</p>
              <ProgressBar counts={p.taskCounts} />
            </li>
          ))}
        </ul>
      )}
      {list.hasMore && <button className="center-btn" onClick={list.loadMore} disabled={list.loading}>{list.loading ? 'Loading…' : 'Load more'}</button>}
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}

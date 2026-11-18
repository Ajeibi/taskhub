import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import Tasks from './pages/Tasks';
import { ProjectsProvider, useProjects } from './projects-context';
import { Avatar, ProjectIcon, Spinner } from './ui';

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { user, logout } = useAuth();
  const { projects, loading } = useProjects();
  const cls = ({ isActive }: { isActive: boolean }) => `sb-link${isActive ? ' active' : ''}`;
  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Sidebar" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) onNavigate(); }}>
      <Link to="/" className="sb-brand"><span className="logo">T</span>TaskHub</Link>
      <nav className="sb-nav" aria-label="Main">
        <NavLink to="/" end className={cls}><Icon d="M3 11l9-8 9 8M5 10v10h14V10" />Home</NavLink>
        <NavLink to="/tasks" className={cls}><Icon d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />My tasks</NavLink>
        <NavLink to="/projects" end className={cls}><Icon d="M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />All projects</NavLink>
      </nav>
      <div className="sb-section"><span>Projects</span><Link to="/projects?new=1" className="link" aria-label="New project" title="New project">+</Link></div>
      <nav className="sb-projects" aria-label="Your projects">
        {projects.map((p) => (
          <NavLink key={p.id} to={`/projects/${p.id}`} className={cls}><ProjectIcon id={p.id} name={p.name} /><span className="name">{p.name}</span></NavLink>
        ))}
        {!loading && projects.length === 0 && <p className="sb-empty">No projects yet.</p>}
      </nav>
      <div className="sb-user">
        <Avatar name={user?.name} size="lg" />
        <div className="who"><b>{user?.name}</b><span className="muted small">{user?.role === 'admin' ? 'Admin' : 'Member'}</span></div>
        <button className="ghost right small" onClick={() => void logout()}>Sign out</button>
      </div>
    </aside>
  );
}

function Layout() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <ProjectsProvider>
      <a className="skip" href="#main">Skip to content</a>
      <div className="app">
        <Sidebar open={open} onNavigate={() => setOpen(false)} />
        {open && <div className="scrim" onClick={() => setOpen(false)} />}
        <div className="content">
          <div className="mobilebar">
            <button className="ghost" aria-label="Open menu" onClick={() => setOpen(true)}>☰</button>
            <b>TaskHub</b>
          </div>
          <main id="main"><Outlet /></main>
        </div>
      </div>
    </ProjectsProvider>
  );
}

function Protected() {
  const { user, loading } = useAuth();
  if (loading) return <main><Spinner /></main>;
  return user ? <Layout /> : <Navigate to="/login" replace />;
}

export default function App() {
  const { user, loading } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={loading ? <Spinner /> : user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<Protected />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/tasks" element={<Tasks />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Page, type Project } from './api';
import { useAuth } from './auth';

/** The sidebar's project list. Pages call reload() after creating/renaming/deleting a project. */
interface ProjectsState { projects: Project[]; loading: boolean; reload: () => void }
const Ctx = createContext<ProjectsState>({ projects: [], loading: false, reload: () => {} });

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    api<Page<Project>>('/api/projects?limit=50')
      .then((p) => setProjects(p.items.filter((x) => x.status !== 'archived')))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (user) reload(); }, [user, reload]);

  const value = useMemo(() => ({ projects, loading, reload }), [projects, loading, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useProjects = (): ProjectsState => useContext(Ctx);

import { useState } from 'react';
import { qs, type Status, type Task } from '../api';
import { usePaged } from '../hooks';
import { ErrorBanner, errorMessage, Spinner, useDebounced } from '../ui';
import { NO_FILTERS, patchTask, StaleTask, TaskFilters, TaskPanel, TaskRow, type Filters } from './TaskParts';

/** Every task in every project I belong to. Same filters and paging as a project page. */
export default function Tasks() {
  const [filters, setFilters] = useState<Filters>({ ...NO_FILTERS, assignee: 'me' });
  const q = useDebounced(filters.q);
  const list = usePaged<Task>(`/api/tasks${qs({ q, status: filters.status, priority: filters.priority, assignee: filters.assignee, overdue: filters.overdue, limit: 25 })}`);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const replace = (t: Task) => list.setItems((items) => items.map((x) => (x.id === t.id ? t : x)));
  async function move(t: Task, status: Status) {
    setNotice(null);
    try { replace(await patchTask(t, { status })); }
    catch (e) { if (e instanceof StaleTask) replace(e.latest); setNotice(errorMessage(e)); }
  }
  return (
    <>
      <div className="page-head"><div className="page-title"><h1>My tasks</h1></div></div>
      <TaskFilters value={filters} onChange={setFilters} withStatus />
      {notice && <div className="banner error" role="alert" style={{ margin: '.7rem 1.5rem 0' }}><span>{notice}</span></div>}
      <div className="page-body flush">
        <ErrorBanner error={list.error} onRetry={list.reload} />
        {list.loading && list.items.length === 0 ? <div style={{ padding: '1rem 1.5rem' }}><Spinner /></div> : list.items.length === 0 && !list.error ? (
          <p className="empty"><strong>Nothing here</strong>No tasks match these filters.</p>
        ) : (
          <>
            <div className="cols list-head"><span /><span>Name</span><span>Assignee</span><span>Due date</span><span>Priority</span></div>
            <ul style={{ margin: 0, padding: 0 }}>
              {list.items.map((t) => <TaskRow key={t.id} task={t} showProject onOpen={(x) => setOpenId(x.id)} onStatus={(x, s) => void move(x, s)} />)}
            </ul>
          </>
        )}
        {list.hasMore && <button className="center-btn" onClick={list.loadMore} disabled={list.loading}>{list.loading ? 'Loading…' : 'Load more'}</button>}
      </div>
      {openId && <TaskPanel taskId={openId} onClose={() => setOpenId(null)} onChanged={replace} onDeleted={(id) => list.setItems((i) => i.filter((x) => x.id !== id))} />}
    </>
  );
}

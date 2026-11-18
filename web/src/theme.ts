// Light by default; dark only if the user chose it. Stored per browser (a convenience, not critical state).
const KEY = 'taskhub-theme';
type Theme = 'light' | 'dark';

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function set(t: Theme): void {
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}
export function applyStoredTheme(): void {
  try { set(localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'); } catch { set('light'); }
}
export function toggleTheme(): void {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  set(next);
  try { localStorage.setItem(KEY, next); } catch { /* private mode: still works for this session */ }
}

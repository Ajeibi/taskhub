# ADR 0006: Frontend

Status: accepted

## Choices
- **React 19 + TypeScript + Vite, plain CSS.** No UI kit, state library or data-fetching library: the app has a handful of screens and one small `fetch` wrapper. Fewer dependencies means fewer things to explain, upgrade and secure. Design tokens are CSS variables; dark mode follows the OS setting; layout is responsive (single column under 760px).
- **React Router** for four routes: dashboard, projects, project detail (task detail is a `?task=<id>` modal so it is linkable and the back button works), and a cross-project task list.
- **State is local.** Server data is fetched per screen and kept in component state; there is no global cache. Trade-off: no cross-screen cache invalidation, so screens refetch after mutations. A query library (TanStack Query) would be the next step if screens multiply.

## Session handling (the part worth explaining)
- The **access token is held in memory only**: nothing in localStorage/sessionStorage for an XSS payload to steal. After a page reload the app restores the session by calling `/api/auth/refresh`, which uses the `httpOnly; SameSite=Strict` refresh cookie.
- On a `401` the client refreshes **once, shared by all in-flight requests (single-flight)**, then retries. This matters because refresh tokens are single-use with reuse detection: two parallel refreshes with the same cookie would look like token theft and revoke the whole session. A unit test proves three parallel 401s produce exactly one refresh call.
- If refresh fails, the app returns to the sign-in page.
- In development Vite proxies `/api` to the backend so the browser sees one origin (the strict cookie would not travel cross-origin). In production the API serves the built files, so it is one origin too.

## UX decisions tied to backend rules
- **Optimistic locking surfaced to the user:** every edit sends the `version` it loaded. A `409` shows "someone else changed this task" with a Reload action instead of silently overwriting.
- Edit forms send **only changed fields**; clearing assignee/due date sends `null`.
- **Archived projects** render read-only (inputs disabled, "New task" disabled) rather than letting the user hit a server error.
- Lists use "Load more" (cursor paging) and a request counter so a slow earlier response can never overwrite a newer filter's results. Search input is debounced (300 ms).
- Accessibility basics: labelled controls, a skip link, `role="dialog"`/Escape/focus return on modals, status text in `role="status"`/`role="alert"`, progress bars with `aria-valuenow`.
- Rendering is through React's escaping; there is no `dangerouslySetInnerHTML`, so user text (titles, comments) cannot inject markup.

## Known gaps
- Comment editing exists in the API but not the UI. No drag-and-drop board, no real-time updates (the user sees changes after a refetch), no i18n, no component-level tests (the client logic that carries risk, session/refresh handling, is unit-tested; the screens were verified by driving the running app in a browser).

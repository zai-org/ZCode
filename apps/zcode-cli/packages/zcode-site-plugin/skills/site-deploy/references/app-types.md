# App types on ZCode Sites

Build and start the app the way its framework documents for production; this page only covers what is specific to ZCode Sites. Every app binds `0.0.0.0:$PORT` (3000) and answers 200 on `/`.

## Static sites

- Copy the build output into `stage/dist/` (or set `SITE_DIR` in `start.sh`), plus `templates/static.sh` → `stage/start.sh` and `templates/static-server.mjs` → `stage/static-server.mjs`. No `node_modules`.
- `SPA_FALLBACK=1` for client-side routing (unknown paths serve `index.html`); `0` for multi-page sites and static exports of SSR frameworks (unknown paths return 404, a `404.html` is used; `/about` resolves to `about.html` or `about/index.html`).
- The site is served from the domain root: the base path must be `/`, not a sub-path or `./`.
- Build-time env vars inlined into bundles are public; never put secrets there.
- A framework that can export static files (no API routes, SSR or server actions) should be deployed that way: smaller and faster to start.

## Node servers

- Ship compiled JS, `package.json` and production `node_modules` installed for linux x64 ([native-deps.md](native-deps.md)); no `ts-node` / `tsx` / dev servers at runtime.
- Prefer the framework's self-contained server output (standalone / node adapter / bundled server): it is smaller. Its `node_modules` was traced on the local machine, so native packages in it (e.g. `sharp`) are local binaries; reinstall those for linux x64 into the stage (`npm install --no-save --os=linux --cpu=x64 --libc=glibc <pkg>@<same version>`). Copy the static assets the server expects next to it.
- In `start.sh`, run the JS entry file directly (`exec node <file>`), not a `node_modules/.bin` shim.

## Python servers

- Dependencies in `stage/vendor` ([python-deps.md](python-deps.md)); start with `python3 -m <server>` (uvicorn for ASGI, gunicorn for WSGI), never the framework's development server.
- 1 vCPU: one uvicorn worker, at most two gunicorn workers (one if the app keeps state in memory).

## Platform specifics for every server

- **HTTPS proxy**: the app receives plain HTTP with `X-Forwarded-Proto: https` and `X-Forwarded-Host`. Trust them where the framework needs it for secure cookies, redirects and CSRF (e.g. Express `trust proxy`, Django `SECURE_PROXY_SSL_HEADER`).
- **Host and origin checks**: the platform's proxy fronts the app, so the `Host` header is an internal address and the site's own host is only in `X-Forwarded-Host`. Turn host allow-lists off (accept any host, e.g. Django `ALLOWED_HOSTS = ['*']`) and take the origin for CSRF and absolute URLs from the forwarded headers (e.g. Django `USE_X_FORWARDED_HOST = True`); never hardcode a site domain.
- **Timeouts**: requests are cut after 300 s; WebSocket / SSE clients must reconnect. Apps built on long-lived connections (Streamlit, Gradio) are best-effort.
- **No secrets**: a framework secret key can only be generated in `start.sh`, which invalidates sessions on every restart; tell the user.
- **Temporary data**: SQLite files and uploads go under `$DATA_DIR`; run migrations in `start.sh` before `exec`. The data is lost when the instance is recycled; tell the user.

## Monorepos

Deploy one app. Build it with the workspace tooling, then stage only that app's output and its production dependencies; workspace packages must end up in the stage as real files (a bundled server, standalone output, or `pnpm deploy --prod --filter <app> .zcode-site/stage`).

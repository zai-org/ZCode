---
name: site-deploy
description: Put a new web project online with ZCode Sites for a preview or share link, and manage those sites. Use for deploy, publish, go-live or share requests, not for the user's own project with its own deploy or release process.
---

# Site Deploy

Turn the user's project into a **stage directory** whose root holds `start.sh`; `zcode-site deploy` packs and uploads it. The cloud unpacks it to `/app` on Linux and runs `bash start.sh`; the deploy succeeds once `GET /` on port 3000 answers below 500, and it should answer 200 so visitors see a page.

`zcode-site` below means `node "<skill-dir>/../../scripts/zcode-site.mjs"`, where `<skill-dir>` is the directory of this file. It runs the same on macOS, Linux and Windows. **`zcode-site help` is the full CLI reference** (commands, options, output, exit and error codes); read it when a command fails or you need one not listed here. Run everything from the project root, and use the user's shell for anything else (the machine may be Windows: PowerShell or cmd, `py -3` instead of `python3`).

## Is ZCode Sites the right target?

"Deploy" means two different things. Decide before doing anything else:

- **The user's own real project** → **not ZCode Sites.** Follow the project's own deployment or release process, or ask the user how they ship it. Signs: deployment config (`Dockerfile`, `docker-compose.yml`, `vercel.json`, `netlify.toml`, `fly.toml`, `Procfile`, `app.yaml`, k8s/Helm/Terraform files, CI workflows that deploy, `deploy` / `release` scripts), a production domain or environment config, a long git history or a team remote.
- **A new or temporary project the user wants to see online or share** (built in this conversation, a demo, prototype, mock-up or small tool) → ZCode Sites.

Use ZCode Sites for a real project only when the user explicitly asks for ZCode Sites (or invoked `/site-deploy`). When it is unclear which case applies, ask; don't default to ZCode Sites.

## The cloud runtime

| Item | Value |
|-|-|
| OS / CPU | Debian 12 (glibc 2.36), **x86-64**. Binaries built on the user's macOS/Windows/arm64 machine don't run |
| Preinstalled | Node.js 24, Python 3.12, bash, tini. No web server, nginx, build tools, ffmpeg, chromium or `apt` |
| Start | Package unpacked to `/app`, then `bash /app/start.sh` in the foreground |
| Port | **0.0.0.0:3000** |
| Health | `GET /` below 500 within **90 s**, else `WARMUP_FAILED` |
| Resources | 1 vCPU, 1 GB memory, 512 MB disk shared by the package and `$DATA_DIR` |
| Storage | `$DATA_DIR` (`/data`) is writable but **temporary** and per instance |
| Instances | One instance per site: memory and `$DATA_DIR` are shared by all requests, lost on restart. A stateless high-traffic site can spread over several with `zcode-site instance multi` |
| Network | Outbound internet works; HTTPS terminates in front, the app gets plain HTTP |
| Secrets | None injected; `.env` files are never packaged |
| Limits | package ≤ 200 MB, unpacked ≤ 400 MB, ≤ 20,000 files, each ≤ 25 MB, depth ≤ 32, `/.__zcode/` reserved |

All runtime dependencies (`node_modules/`, Python `vendor/`) ship **inside the package, built for linux x86-64**. Nothing is installed at runtime.

## Workflow

### 1. Understand the project

Classify it by what it needs at runtime, then read the matching section of [references/app-types.md](references/app-types.md):

- **Static**: the build output is only HTML/CSS/JS, or it can be exported that way → `templates/static.sh` + `templates/static-server.mjs`
- **Node server**: server code runs per request (SSR, API routes, a Node HTTP server) → `templates/node.sh`
- **Python server** → `templates/python.sh`

Ask the user first when it's unclear which app to deploy or how it starts, or when it needs a database, secrets, persistent storage, background workers or several processes (one HTTP service is supported; offer a fallback such as SQLite under `$DATA_DIR` or a static build).

**Confirm with the user before changing or uploading anything**, and wait for an explicit yes. Say plainly that:

- the project is uploaded to the ZCode cloud: the stage contains the built files and, for Node/Python servers, the server source code;
- it becomes a public site: anyone with the link can open it;
- secrets are never uploaded, but anything else in the stage is (name what you plan to include if there's anything sensitive-looking, such as data files or internal docs).

One confirmation covers redeploys of the same site in this conversation; ask again before deploying to a different or new site.

### 2. Adapt the source

Smallest changes that still work locally; tell the user what changed.

- Listen on `$PORT` with host `0.0.0.0`; many servers default to 127.0.0.1.
- `/` answers 200 directly, no redirect; serve from the root (`base: "/"`).
- No absolute paths from the user's machine. Written files go under `$DATA_DIR`, created at startup.
- Non-secret config may be `export`ed in `start.sh`. Never package secrets; tell the user which features need them.

### 3. Build the stage

Build with the project's tooling, then copy **only what runs** into a fresh `.zcode-site/stage/` (delete the old one first). Add `.zcode-site/` to `.gitignore`. The stage root becomes `/app`. Layouts and what to leave out: [references/packaging.md](references/packaging.md).

### 4. Install runtime dependencies for linux x86-64

Cross-install into the stage, never copy the local `node_modules` or virtualenv: Node [references/native-deps.md](references/native-deps.md), Python [references/python-deps.md](references/python-deps.md). Packages that compile at install time (`better-sqlite3`, `bcrypt`, `canvas`, …) can't be cross-installed; swap them for a pure-JS or prebuilt equivalent, or explain the limitation.

### 5. Write start.sh

Copy the template to `.zcode-site/stage/start.sh` and adjust the `ADJUST` lines. Keep: `cd` to its own directory, `exec` the server in the foreground (no `&`, `nohup`, pm2), bind `0.0.0.0:3000`, no install/build/download, LF line endings.

### 6. Check it starts

```
zcode-site check .zcode-site/stage
```

`check` runs `start.sh` locally and expects `{"status":"live","httpStatus":200}`; on `START_FAILED` read `data.log` and [references/troubleshooting.md](references/troubleshooting.md). `"skipped"` means the stage holds Linux binaries (or there is no bash) — then start the app from its normal local environment with the same command and confirm `/` returns 200.

### 7. Deploy

First deploy of the project (no `.zcode-site.json` in the project root):

```
zcode-site deploy .zcode-site/stage --new --name "<display name>" --prefix <domain-prefix>
```

Later deploys: `zcode-site deploy .zcode-site/stage`. If the user wants an unlinked project to update one of their existing sites, use `zcode-site list` and `--site <id>` instead of `--new`.

- The display name can be any language. The domain is `{prefix}-{4 random chars}` and stays the same across deploys (changing it later breaks the old link): pick the prefix from what the project is (`happy-birthday`, `tokyo-trip-2026`, not `app` or `my-project`), 4–30 lowercase letters, digits and `-`, translating rather than transliterating Chinese.
- The name and the prefix go through the server's content review. A name that fails gets 3611 and nothing is created: pick another display name and deploy again. A prefix that fails is replaced by `site` with a warning; tell the user the domain (they can change it later with `prefix`).
- Deploy first checks the stage against the package contract, including that every native binary is linux x86-64. On `PACKAGE_CHECK_FAILED` nothing was created or uploaded: fix everything in `error.data.problems` and deploy again.
- The deploy writes `.zcode-site.json`; keep it, never put it in the stage. It streams progress for a few minutes; let it finish.
- On other failures follow `error.hint`. For `PACKAGE_INVALID` or `WARMUP_FAILED` read `zcode-site logs <deploymentId>`, fix steps 3–6 and deploy again. For quota errors (exit 3), tell the user new deployments are paused until the next period and upgrading their ZCode plan raises the limits; don't retry. Exit 2: ask the user to sign in to ZCode again.

Report: the URL, what you changed and why, how it was verified (`check` live, or local run when skipped) and that the cloud health check passed, and anything that won't work in the cloud.

## Managing a site

`zcode-site status | logs <deploymentId> | offline | online | rename <name> | badge hide|show | instance single|multi | analytics [--range 24h|7d|30d] | prefix <prefix> | list | usage` — they act on the linked site unless `--site <id>` is given. Rebuild the stage from scratch for every redeploy; never patch an old stage.

- `analytics` shows page views, visitors, average visit duration, bounce rate, the trend and the top pages, referrers, devices and regions (default last 7 days). It counts browser visits only, a few minutes late, and starts over when the domain prefix changes.
- `prefix <prefix>` gives the site a new address `{prefix}-{4 new random chars}`. **The old address stops working at once** (no redirect, it may go to someone else) and analytics start over. Tell the user this and wait for an explicit yes. A prefix with fewer than 4 usable characters is rejected; one that fails content review gets 3614 — pick another.
- `delete --site <id>` permanently deletes a site: the address returns 404 at once and it can't be restored. Only when the user asks to delete that specific site: name it (name and URL) and wait for an explicit yes. It always needs `--site`; it gets 3610 while a deployment is running.

Site `status`: `pending` = never deployed successfully (the URL shows nothing yet), `online` = the URL serves `currentDeployment`, `offline` = taken offline. Deployed content goes through the server's content review after it is live; `offlineReason: review_rejected` means the review rejected the live version and took the site offline — `online` gets 3612, so tell the user, change the content and deploy again (a successful deploy puts it back online). Deployment progress is `latestDeployment.status`; while it is `preparing`, `uploading`, `publishing` or `verifying` the deployment is still running (it ends within about 10 minutes) — wait and check again, don't redeploy.

Every site shows a small "ZCode" badge. When the user asks to remove it, run `zcode-site badge hide`; only paid plans can, and free plans get 3608 — tell the user to upgrade.

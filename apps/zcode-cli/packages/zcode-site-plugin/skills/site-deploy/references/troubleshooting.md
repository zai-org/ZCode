# Troubleshooting

Start from where it failed: `zcode-site check`, the package check of `zcode-site deploy` (`PACKAGE_CHECK_FAILED`), or the cloud deploy. Error codes and their meaning are in `zcode-site help`.

## The site doesn't come up (`check` or the cloud health check)

Locally, read `data.log` of `START_FAILED`. In the cloud, read `zcode-site logs <deploymentId>` (the deploy also streams it as `log` events).

| Symptom in the log | Cause | Fix |
|-|-|-|
| nothing answers, log shows `listening on 127.0.0.1` / `localhost` | bound to loopback | bind `0.0.0.0` (framework flag or `HOST`/`HOSTNAME` env) |
| nothing answers, log shows another port (5173, 8000, 8080…) | wrong port | use `$PORT` / 3000 |
| `start.sh exited (code 0)` | the server was started in the background or as a daemon, so the script finished | `exec` the server in the foreground; no `&`, `nohup`, `pm2 start`, `--daemon` |
| `$'\r': command not found` | CRLF line endings | convert `start.sh` to LF |
| `Cannot find module …` / `ERR_MODULE_NOT_FOUND` | file or dependency not in the stage, or `package.json` missing (`"type": "module"`) | add it to the stage; with a standalone server output, check the static assets copied next to it |
| `invalid ELF header`, `Exec format error`, `wrong ELF class`, `not a valid Win32 application` | native module built for the user's machine | reinstall for linux x64 ([native-deps.md](native-deps.md), [python-deps.md](python-deps.md)) |
| `GLIBC_2.38' not found` (or another version > 2.36) | binary built for a newer Linux | install the manylinux/glibc variant built for glibc ≤ 2.36, or replace the package |
| `was compiled against a different Node.js version (NODE_MODULE_VERSION …)` | native addon built for another Node major | reinstall for linux x64 with the cross-install from [native-deps.md](native-deps.md), or replace the package |
| `ModuleNotFoundError` (Python) | `vendor/` missing or `PYTHONPATH` not set, or a console script from `vendor/bin` was used | use `templates/python.sh`, start with `python3 -m …` |
| `ImportError: … .so` (Python) | wheel for the wrong platform or Python version | reinstall with `--platform … --python-version 3.12` |
| `GET / returned 404` | no route at `/`, wrong static dir, missing `index.html` | serve a page at `/`; check `SITE_DIR` |
| `GET / returned 301/302/307` | `/` redirects (login, locale, trailing slash) | make `/` answer 200 directly (landing page, or render the login page at `/`) |
| `GET / returned 500` | the app crashes on the first request (missing config, DB file, secret) | read the stack trace; default missing config, create SQLite under `$DATA_DIR` at startup |
| `Disallowed host` / `Invalid Host header` (400) | host allow-list of the framework or a dev server | accept any host ([app-types.md](app-types.md)); never run a dev server in production |
| `JavaScript heap out of memory`, killed (exit 137) | over 1 GB | `NODE_OPTIONS=--max-old-space-size=768` (template default), fewer workers, don't load large files in memory |
| `ENOSPC` | disk full (512 MB shared by package and `$DATA_DIR`) | shrink the package; don't write large files |
| still starting after 90 s | slow startup: migrations, downloading models/files, building at start | move work to build time; nothing may be downloaded or compiled in `start.sh` |
| dev server output (`vite`, `next dev`, `flask run`, `--reload`, …) | development server in start.sh | use the framework's production server ([app-types.md](app-types.md)) |

## `PACKAGE_INVALID` from the cloud

The server preflight runs the same checks as the package check of `zcode-site deploy`; the message names the file. Rebuild a fresh stage and deploy again.

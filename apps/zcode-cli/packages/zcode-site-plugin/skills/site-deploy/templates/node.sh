#!/usr/bin/env bash
# ZCode Sites start.sh for a Node.js server. Runs in the foreground on 0.0.0.0:3000.
# Dependencies must already be in ./node_modules (installed for linux x64); never install here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export NODE_ENV=production
export PORT="${PORT:-3000}"
# Different frameworks read different variables for the bind address; set all of them.
export HOST=0.0.0.0 HOSTNAME=0.0.0.0
# The instance has 1 GB; leave headroom for non-heap memory.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}"
# Writable but temporary storage (lost when the instance is recycled).
export DATA_DIR="${DATA_DIR:-$PWD/data}"
mkdir -p "$DATA_DIR"

# ADJUST: the server entry. Examples:
#   Next.js standalone:  exec node server.js
#   Nuxt (Nitro):        exec node .output/server/index.mjs
#   SvelteKit adapter-node: exec node build
#   Astro @astrojs/node: exec node dist/server/entry.mjs
#   Express/Fastify/Nest/Hono (compiled): exec node dist/main.js
exec node server.js

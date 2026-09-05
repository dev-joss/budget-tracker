#!/usr/bin/env bash
set -euo pipefail

# VM bind mounts can report a different owner for the trusted workspace.
git config --global --add safe.directory "$(pwd -P)"

# Docker creates dependency volumes as root. Keep package installation non-root.
sudo chown node:node node_modules packages/{backend,frontend,shared,landing}/node_modules /home/node/.npm /home/node/.cache/ms-playwright
npm ci
npm exec --workspace packages/frontend -- playwright install --with-deps chromium

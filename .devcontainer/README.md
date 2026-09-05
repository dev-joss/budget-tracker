# Local dev container

The workspace uses Node `23.11.0`, Git, Docker CLI, Compose, and Playwright Chromium.
The editor terminal runs as `node`. Application services and E2E services run in separate containers through the host Docker daemon.
Docker socket access grants control over that daemon and its containers.

## First start

1. Start Colima or Docker Desktop with Linux containers.
2. For Docker Desktop 4.34 or later, enable [host networking](https://docs.docker.com/engine/network/drivers/host/) in its network settings.
3. Install the VS Code Dev Containers extension, or use the Dev Container CLI.
4. Make sure that Node and Git are available on the host.
5. Prepare `.env.development` and `.env.test` as described in [application setup](../docs/application-setup.md).
6. If the local certificates are absent, run `npm run generate-ssl-certs` on the host.
7. Open the repository in VS Code and select **Dev Containers: Reopen in Container**.

The host creates an ignored `compose.local.json` with absolute workspace paths and a unique Compose project name.
The same paths inside and outside the container let Docker resolve application bind mounts.
For linked worktrees, an additional mount supplies the shared Git metadata.
Colima must permit access to these host paths.

Setup runs `npm ci` and installs Chromium with its system libraries. The first start needs internet access.
Named volumes hold Linux dependencies, npm downloads, and browser binaries. Laptop dependencies remain separate.
Node `23.11.0` matches the existing Docker images. Some locked packages report engine warnings with this version.
The terminal permits a 4 GB Node heap because frontend type checks exceed the default heap limit.

CLI alternative, from the repository root:

```bash
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
```

## Daily use

Run these commands in the container terminal:

```bash
# Start the existing application stack in the background.
npm run docker:dev -- -d

# Run source checks and unit tests.
node --test .devcontainer/initialize.test.mjs
npm run lint
npm run typecheck
npm -w packages/backend run test:unit
npm -w packages/frontend run test:unit

# Run backend E2E tests with their separate database and Redis.
npm -w packages/backend run test:e2e

# Run browser smoke tests against the application stack.
npm -w packages/frontend run test:e2e -- e2e/tests/smoke --workers=1

# Stop the application stack without deleting its database volumes.
npm run docker:dev:down
```

Open the HTTPS frontend URL printed by the development script in the host browser.
The container shares the Docker host network. Existing localhost URLs and port checks therefore use the Docker host ports.
On Colima, these ports reach the laptop through its port forwarding.
No application service starts automatically with the workspace.

For custom ports or linked worktrees, set `PLAYWRIGHT_BASE_URL` and `PLAYWRIGHT_API_BASE_URL` to the printed frontend and backend URLs.
The defaults are `https://localhost:8100` and `https://localhost:8081`.

Set `JEST_WORKERS_AMOUNT` in `.env.test` according to Docker memory capacity.
Start with two workers on an 8 GB Docker VM. Six workers need more memory.
For one run, append `-- --maxWorkers=2` to the backend E2E command. This limits Jest workers but retains configured database creation.
Backend E2E cleanup deletes its own test volumes. Development volumes use a separate Compose project.

## Rebuild and shutdown

After a dependency change, run `bash .devcontainer/setup.sh` in the container.
After a Dockerfile change, select **Dev Containers: Rebuild Container**.
CLI users can run `devcontainer up --workspace-folder . --build-no-cache --remove-existing-container` on the host.
Rebuilds retain the dependency volumes and development database volumes.

Closing the editor stops the workspace container. Application services remain available until `npm run docker:dev:down` runs.
CLI users can stop the workspace from the host:

```bash
docker compose -f .devcontainer/compose.yaml -f .devcontainer/compose.local.json stop
```

## Troubleshooting

- If Docker commands fail, make sure that the host daemon is available and the workspace startup completed.
- If localhost connections fail on Docker Desktop, enable host networking and restart the workspace.
- If the browser rejects HTTPS, generate trusted certificates on the host. Container trust does not configure the host browser.
- If tests exit with `SIGKILL`, reduce `JEST_WORKERS_AMOUNT` or increase Docker memory.
- If Git fails in a linked worktree, make sure that Docker can mount the shared Git directory.
- If the checkout moves, reopen the container to regenerate its paths. The new path gets separate dependency volumes.

The commit hook uses NVM when available. In this container, it uses the installed Node version.

## Later use on WSL

Clone the repository into the WSL Linux filesystem. Open it through an SSH connection to WSL, then reopen it in the container.
Generate certificates that the local browser trusts, and forward the application ports through SSH.
Remote networking and workstation restart behavior need separate checks.

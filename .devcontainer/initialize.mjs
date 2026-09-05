import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = realpathSync(process.cwd());
const commonGitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const volumes = [{ type: 'bind', source: root, target: root }];

// Linked worktrees refer to Git metadata outside the workspace.
if (!commonGitDir.startsWith(`${root}${path.sep}`)) {
  volumes.push({ type: 'bind', source: commonGitDir, target: commonGitDir });
}

const dependencyPaths = [
  'node_modules',
  ...['backend', 'frontend', 'shared', 'landing'].map((name) => `packages/${name}/node_modules`),
];
const namedVolumes = {};
for (const [index, dependencyPath] of dependencyPaths.entries()) {
  const name = `dependencies-${index}`;
  namedVolumes[name] = {};
  volumes.push({ type: 'volume', source: name, target: path.join(root, dependencyPath), volume: { nocopy: true } });
}
for (const [name, target] of Object.entries({ npm: '/home/node/.npm', browsers: '/home/node/.cache/ms-playwright' })) {
  namedVolumes[name] = {};
  volumes.push({ type: 'volume', source: name, target });
}

const configuration = {
  name: `bt-workspace-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`,
  services: { workspace: { working_dir: root, volumes } },
  volumes: namedVolumes,
};
writeFileSync(path.join(root, '.devcontainer/compose.local.json'), `${JSON.stringify(configuration, null, 2)}\n`);

for (const file of ['.env.development', '.env.test', 'docker/dev/certs/cert.pem', 'docker/dev/certs/key.pem']) {
  if (!existsSync(path.join(root, file))) {
    console.warn(`Missing ${file}. Read .devcontainer/README.md before you start the application or tests.`);
  }
}

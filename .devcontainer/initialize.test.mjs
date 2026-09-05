import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const initialize = fileURLToPath(new URL('./initialize.mjs', import.meta.url));

test('workspace mounts isolate dependencies and preserve linked worktree metadata', () => {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bt-devcontainer-')));
  const main = path.join(temporary, 'main checkout');
  const linked = path.join(temporary, 'linked checkout');
  const git = ({ cwd, args }) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const generate = ({ cwd }) => {
    mkdirSync(path.join(cwd, '.devcontainer'), { recursive: true });
    execFileSync(process.execPath, [initialize], { cwd, stdio: 'pipe' });
    return JSON.parse(readFileSync(path.join(cwd, '.devcontainer/compose.local.json'), 'utf8'));
  };

  try {
    mkdirSync(main);
    git({ cwd: main, args: ['init'] });
    git({
      cwd: main,
      args: [
        '-c',
        'user.name=Container Test',
        '-c',
        'user.email=container@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'test',
      ],
    });
    git({ cwd: main, args: ['worktree', 'add', '-b', 'container-test', linked] });

    const mainConfig = generate({ cwd: main });
    assert.deepEqual(generate({ cwd: main }), mainConfig);
    assert.equal(mainConfig.services.workspace.working_dir, main);
    assert.deepEqual(
      mainConfig.services.workspace.volumes.filter((mount) => mount.type === 'bind'),
      [{ type: 'bind', source: main, target: main }],
    );
    const dependencies = mainConfig.services.workspace.volumes.filter((mount) =>
      mount.target.endsWith('/node_modules'),
    );
    assert.equal(dependencies.length, 5);
    assert.ok(dependencies.every((mount) => mount.type === 'volume' && mount.volume.nocopy));

    const linkedConfig = generate({ cwd: linked });
    assert.notEqual(linkedConfig.name, mainConfig.name);
    assert.deepEqual(
      linkedConfig.services.workspace.volumes.filter((mount) => mount.type === 'bind'),
      [
        { type: 'bind', source: linked, target: linked },
        { type: 'bind', source: path.join(main, '.git'), target: path.join(main, '.git') },
      ],
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

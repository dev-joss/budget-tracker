import { describe, expect, it, jest } from '@jest/globals';

import E2eEnvironment from './e2e-environment';

const createEnvironment = ({ cleanup }: { cleanup: () => Promise<void> }): E2eEnvironment =>
  Object.assign(Object.create(E2eEnvironment.prototype) as E2eEnvironment, {
    global: { cleanupE2eResources: cleanup },
  });

describe('e2e environment cleanup', () => {
  it('awaits cleanup at run_finish without requiring a test or hook event', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = jest.fn(() => pending);
    const environment = createEnvironment({ cleanup });
    let finished = false;
    const run = environment.handleTestEvent({ name: 'run_finish' }).then(() => {
      finished = true;
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await run;
    expect(finished).toBe(true);
    await environment.handleTestEvent({ name: 'run_finish' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps resources available during test execution', async () => {
    const cleanup = jest.fn(async () => {});
    const environment = createEnvironment({ cleanup });
    await environment.handleTestEvent({ name: 'test_done' });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('reports cleanup failure', async () => {
    const error = new Error('queue close failed');
    const environment = createEnvironment({
      cleanup: async () => {
        throw error;
      },
    });
    await expect(environment.handleTestEvent({ name: 'run_finish' })).rejects.toThrow(error);
  });
});

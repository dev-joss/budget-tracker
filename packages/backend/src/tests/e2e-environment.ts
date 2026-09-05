import NodeEnvironment from 'jest-environment-node';

export default class E2eEnvironment extends NodeEnvironment {
  async handleTestEvent({ name }: { name: string }): Promise<void> {
    if (name !== 'run_finish') return;

    // run_finish also runs for skipped files, before Jest tears down their modules.
    const cleanup = this.global.cleanupE2eResources;
    this.global.cleanupE2eResources = undefined;
    await cleanup?.();
  }
}

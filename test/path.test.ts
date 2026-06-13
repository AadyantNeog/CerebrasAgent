import {describe, expect, it} from 'vitest';
import {resolve} from 'node:path';
import {resolveWorkspacePath} from '../src/tools/path.js';

describe('resolveWorkspacePath', () => {
  it('allows paths inside the workspace', () => {
    const root = resolve('workspace');
    expect(resolveWorkspacePath(root, 'src/index.ts')).toBe(resolve(root, 'src/index.ts'));
  });

  it('rejects paths outside the workspace', () => {
    const root = resolve('workspace');
    expect(() => resolveWorkspacePath(root, '../outside.txt')).toThrow(/escapes workspace/);
  });
});

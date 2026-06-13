import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createToolRegistry} from '../src/tools/registry.js';
import type {AgentConfig} from '../src/config.js';

let root: string;
let config: AgentConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cerebras-agent-'));
  config = {
    cwd: root,
    provider: 'cerebras',
    model: 'test-model',
    approvalPolicy: 'approve-mutations',
    autoApproveReadonly: true,
    commandTimeoutMs: 10_000
  };
});

afterEach(async () => {
  await rm(root, {recursive: true, force: true});
});

describe('tool registry', () => {
  it('creates and reads a file', async () => {
    const tools = createToolRegistry();
    const createFile = tools.find((tool) => tool.name === 'create_file');
    const readFileTool = tools.find((tool) => tool.name === 'read_file');

    expect(createFile).toBeDefined();
    expect(readFileTool).toBeDefined();

    await createFile?.execute({path: 'notes/todo.txt', content: 'hello'}, {config});
    const result = await readFileTool?.execute({path: 'notes/todo.txt'}, {config});

    expect(result?.success).toBe(true);
    expect(result?.content).toBe('hello');
    await expect(readFile(join(root, 'notes/todo.txt'), 'utf8')).resolves.toBe('hello');
  });

  it('replaces a file and returns a diff', async () => {
    await writeFile(join(root, 'app.ts'), 'const value = 1;\n', 'utf8');
    const editFile = createToolRegistry().find((tool) => tool.name === 'edit_file');

    const result = await editFile?.execute(
      {path: 'app.ts', content: 'const value = 2;\n'},
      {config}
    );

    expect(result?.success).toBe(true);
    expect(result?.diff).toContain('-const value = 1;');
    expect(result?.diff).toContain('+const value = 2;');
  });

  it('applies a unified diff patch', async () => {
    await writeFile(join(root, 'patched.ts'), 'const value = 1;\n', 'utf8');
    const applyPatch = createToolRegistry().find((tool) => tool.name === 'apply_patch');
    const patch = [
      'Index: patched.ts',
      '===================================================================',
      '--- patched.ts\tcurrent',
      '+++ patched.ts\tproposed',
      '@@ -1,1 +1,1 @@',
      '-const value = 1;',
      '+const value = 2;',
      ''
    ].join('\n');

    const result = await applyPatch?.execute({path: 'patched.ts', patch}, {config});

    expect(result?.success).toBe(true);
    expect(result?.summary).toBe('Patched patched.ts.');
    await expect(readFile(join(root, 'patched.ts'), 'utf8')).resolves.toBe('const value = 2;\n');
  });

  it('searches files literally', async () => {
    await writeFile(join(root, 'a.ts'), 'alpha\nneedle\n', 'utf8');
    await writeFile(join(root, 'b.txt'), 'needle\n', 'utf8');
    const search = createToolRegistry().find((tool) => tool.name === 'search_files');

    const result = await search?.execute({query: 'needle', glob: '.ts'}, {config});

    expect(result?.content).toContain('a.ts:2');
    expect(result?.content).not.toContain('b.txt');
  });

  it('runs a command in the workspace', async () => {
    const runCommand = createToolRegistry().find((tool) => tool.name === 'run_command');

    const result = await runCommand?.execute(
      {command: 'node -e "console.log(process.cwd())"'},
      {config}
    );

    expect(result?.success).toBe(true);
    expect(result?.content).toContain(root);
  });
});

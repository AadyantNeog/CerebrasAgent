import {access, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, join} from 'node:path';
import {applyPatch, createTwoFilesPatch} from 'diff';
import {execa, execaCommand} from 'execa';
import type {ToolDefinition} from './types.js';
import {resolveWorkspacePath, toDisplayPath} from './path.js';
import {
  applyPatchArgsSchema,
  createFileArgsSchema,
  editFileArgsSchema,
  pathArgsSchema,
  runCommandArgsSchema,
  searchArgsSchema
} from './schemas.js';

const textFileLimitBytes = 250_000;
const maxSearchResults = 80;
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.turbo']);

export function createToolRegistry(): ToolDefinition[] {
  return [
    {
      name: 'get_current_directory',
      description: 'Return the workspace directory the agent is operating in.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      },
      requiresApproval: false,
      async execute(_args, context) {
        return {
          success: true,
          summary: `Workspace: ${context.config.cwd}`,
          content: context.config.cwd
        };
      }
    },
    {
      name: 'list_files',
      description: 'List files and directories under a workspace path.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'Workspace-relative path to list.'}
        },
        required: ['path'],
        additionalProperties: false
      },
      requiresApproval: false,
      async execute(rawArgs, context) {
        const args = pathArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        const entries = await listDirectory(target, context.config.cwd);
        return {
          success: true,
          summary: `Listed ${entries.length} entries in ${args.path}.`,
          content: entries.join('\n')
        };
      }
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'Workspace-relative file path.'}
        },
        required: ['path'],
        additionalProperties: false
      },
      requiresApproval: false,
      async execute(rawArgs, context) {
        const args = pathArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        const info = await stat(target);
        if (!info.isFile()) {
          throw new Error(`Not a file: ${args.path}`);
        }

        if (info.size > textFileLimitBytes) {
          throw new Error(`File is too large to read safely (${info.size} bytes).`);
        }

        const content = await readFile(target, 'utf8');
        return {
          success: true,
          summary: `Read ${args.path}.`,
          content
        };
      }
    },
    {
      name: 'search_files',
      description: 'Search text files in the workspace for a literal query.',
      parameters: {
        type: 'object',
        properties: {
          query: {type: 'string', description: 'Literal text to search for.'},
          glob: {
            type: 'string',
            description: 'Optional filename suffix filter such as .ts or .tsx.'
          }
        },
        required: ['query'],
        additionalProperties: false
      },
      requiresApproval: false,
      async execute(rawArgs, context) {
        const args = searchArgsSchema.parse(rawArgs);
        const results = await searchWorkspace(context.config.cwd, args.query, args.glob);
        return {
          success: true,
          summary: `Found ${results.length} matches for "${args.query}".`,
          content: results.join('\n')
        };
      }
    },
    {
      name: 'apply_patch',
      description: 'Apply a unified diff patch to one existing UTF-8 workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'Workspace-relative file path to patch.'},
          patch: {
            type: 'string',
            description: 'Unified diff for this file. It must apply cleanly.'
          }
        },
        required: ['path', 'patch'],
        additionalProperties: false
      },
      requiresApproval: true,
      risk: 'write',
      async makePreview(rawArgs, context) {
        const args = applyPatchArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        await assertPatchApplies(target, args.patch);
        return args.patch;
      },
      async execute(rawArgs, context) {
        const args = applyPatchArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        const before = await readFile(target, 'utf8');
        const after = applyPatch(before, args.patch, {fuzzFactor: 0});
        if (after === false) {
          throw new Error(`Patch did not apply cleanly to ${args.path}.`);
        }

        await writeFile(target, after, 'utf8');
        return {
          success: true,
          summary: `Patched ${args.path}.`,
          diff: createTwoFilesPatch(args.path, args.path, before, after, 'current', 'patched')
        };
      }
    },
    {
      name: 'create_file',
      description: 'Create a new UTF-8 text file. Fails if the file already exists.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'Workspace-relative file path to create.'},
          content: {type: 'string', description: 'Full file contents.'}
        },
        required: ['path', 'content'],
        additionalProperties: false
      },
      requiresApproval: true,
      risk: 'write',
      async makePreview(rawArgs, context) {
        const args = createFileArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        await ensureDoesNotExist(target);
        return createTwoFilesPatch(args.path, args.path, '', args.content, 'missing', 'new');
      },
      async execute(rawArgs, context) {
        const args = createFileArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        await ensureDoesNotExist(target);
        await mkdir(dirname(target), {recursive: true});
        await writeFile(target, args.content, 'utf8');
        return {
          success: true,
          summary: `Created ${args.path}.`,
          diff: createTwoFilesPatch(args.path, args.path, '', args.content, 'missing', 'new')
        };
      }
    },
    {
      name: 'edit_file',
      description: 'Replace an existing UTF-8 text file with new full contents.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'Workspace-relative file path to edit.'},
          content: {type: 'string', description: 'New full file contents.'}
        },
        required: ['path', 'content'],
        additionalProperties: false
      },
      requiresApproval: true,
      risk: 'write',
      async makePreview(rawArgs, context) {
        const args = editFileArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        const before = await readFile(target, 'utf8');
        return createTwoFilesPatch(args.path, args.path, before, args.content, 'current', 'proposed');
      },
      async execute(rawArgs, context) {
        const args = editFileArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        const before = await readFile(target, 'utf8');
        await writeFile(target, args.content, 'utf8');
        return {
          success: true,
          summary: `Edited ${args.path}.`,
          diff: createTwoFilesPatch(args.path, args.path, before, args.content, 'current', 'updated')
        };
      }
    },
    {
      name: 'delete_file',
      description: 'Delete a single file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {type: 'string', description: 'Workspace-relative file path to delete.'}
        },
        required: ['path'],
        additionalProperties: false
      },
      requiresApproval: true,
      risk: 'delete',
      async makePreview(rawArgs, context) {
        const args = pathArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        const info = await stat(target);
        if (!info.isFile()) {
          throw new Error('delete_file only deletes regular files.');
        }
        return `Delete file: ${toDisplayPath(context.config.cwd, target)}`;
      },
      async execute(rawArgs, context) {
        const args = pathArgsSchema.parse(rawArgs);
        const target = resolveWorkspacePath(context.config.cwd, args.path);
        const info = await stat(target);
        if (!info.isFile()) {
          throw new Error('delete_file only deletes regular files.');
        }
        await rm(target);
        return {
          success: true,
          summary: `Deleted ${args.path}.`
        };
      }
    },
    {
      name: 'run_command',
      description: 'Run a shell command in the workspace and return stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: {type: 'string', description: 'Command to run from the workspace root.'}
        },
        required: ['command'],
        additionalProperties: false
      },
      requiresApproval: true,
      risk: 'command',
      async makePreview(rawArgs) {
        const args = runCommandArgsSchema.parse(rawArgs);
        return `Run command:\n${args.command}`;
      },
      async execute(rawArgs, context) {
        const args = runCommandArgsSchema.parse(rawArgs);
        const result = await execaCommand(args.command, {
          cwd: context.config.cwd,
          shell: true,
          timeout: context.config.commandTimeoutMs,
          reject: false,
          all: true
        });
        return {
          success: result.exitCode === 0,
          summary: `Command exited with code ${result.exitCode}.`,
          content: result.all ?? ''
        };
      }
    }
  ];
}

async function ensureDoesNotExist(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return;
  }

  throw new Error('File already exists.');
}

async function listDirectory(path: string, root: string): Promise<string[]> {
  const entries = await readdir(path, {withFileTypes: true});
  return entries
    .filter((entry) => !ignoredDirs.has(entry.name))
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${toDisplayPath(root, join(path, entry.name))}`)
    .sort();
}

async function searchWorkspace(root: string, query: string, suffix?: string): Promise<string[]> {
  const rgResults = await searchWithRipgrep(root, query, suffix);
  if (rgResults) {
    return rgResults;
  }

  const output: string[] = [];
  await walk(root, async (file) => {
    if (output.length >= maxSearchResults) {
      return;
    }

    if (suffix && !file.endsWith(suffix)) {
      return;
    }

    const info = await stat(file);
    if (info.size > textFileLimitBytes) {
      return;
    }

    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.includes(query)) {
        output.push(`${toDisplayPath(root, file)}:${index + 1}: ${line.trim()}`);
        if (output.length >= maxSearchResults) {
          return;
        }
      }
    }
  });

  return output;
}

async function assertPatchApplies(path: string, patch: string): Promise<void> {
  const before = await readFile(path, 'utf8');
  const after = applyPatch(before, patch, {fuzzFactor: 0});
  if (after === false) {
    throw new Error('Patch did not apply cleanly.');
  }
}

async function searchWithRipgrep(
  root: string,
  query: string,
  suffix?: string
): Promise<string[] | undefined> {
  const args = [
    '--line-number',
    '--fixed-strings',
    '--color',
    'never',
    '--path-separator',
    '/',
    '--max-count',
    String(maxSearchResults),
    '--glob',
    '!node_modules/**',
    '--glob',
    '!dist/**',
    '--glob',
    '!.git/**'
  ];

  if (suffix) {
    args.push('--glob', suffix.startsWith('*.') ? suffix : `*${suffix}`);
  }

  args.push(query, '.');

  try {
    const result = await execa('rg', args, {
      cwd: root,
      reject: false,
      timeout: 15_000,
      all: true
    });

    if (result.exitCode === 1) {
      return [];
    }

    if (result.exitCode !== 0) {
      return undefined;
    }

    return (result.all ?? '')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, maxSearchResults)
      .map((line) => line.replace(/^\.\//, ''));
  } catch {
    return undefined;
  }
}

async function walk(path: string, onFile: (file: string) => Promise<void>): Promise<void> {
  const entries = await readdir(path, {withFileTypes: true});
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }

    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await walk(child, onFile);
    } else if (entry.isFile()) {
      await onFile(child);
    }
  }
}

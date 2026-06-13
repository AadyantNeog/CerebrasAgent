import {resolve, relative, sep} from 'node:path';

export function resolveWorkspacePath(root: string, inputPath: string): string {
  if (!inputPath || inputPath.trim().length === 0) {
    throw new Error('Path is required.');
  }

  const resolved = resolve(root, inputPath);
  const relation = relative(root, resolved);
  const escapesRoot =
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    relation.length === 0 && resolved !== root;

  if (escapesRoot) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }

  return resolved;
}

export function toDisplayPath(root: string, absolutePath: string): string {
  const relation = relative(root, absolutePath);
  return relation.length === 0 ? '.' : relation;
}

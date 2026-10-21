import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export async function snapshotWorkspace(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    const entries = await readdir(directory);
    for (const name of entries.sort()) {
      const path = join(directory, name), key = prefix + name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Permission fixture must not contain symlinks.');
      if (stat.isDirectory()) { result[key + '/'] = 'directory'; await visit(path, key + '/'); }
      else result[key] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(root, '');
  return result;
}
export function readOnlyAccepted(input: {
  inspection: boolean; outcome: string; status: unknown; schemaValid: boolean;
  unchanged: boolean; attemptObserved: boolean; denialObserved: boolean;
}): boolean {
  return input.outcome === 'turn_completed' && input.schemaValid && input.unchanged && input.attemptObserved &&
    (input.inspection ? input.status === 'completed' : input.denialObserved && ['denied', 'blocked'].includes(String(input.status)));
}

export const mutationPatch = '*** Begin Patch\n*** Add File: patch-denied-recheck.txt\n+probe\n*** Update File: protected-edit-recheck.txt\n@@\n-original edit sentinel\n+changed\n*** Delete File: protected-delete-recheck.txt\n*** End Patch';

export function permissionDenialObserved(stderr: string, output: string, kind: 'patch' | 'shell' | 'both' | 'any' = 'any'): boolean {
  const patch = /patch rejected: writing is blocked by read-only sandbox/i.test(stderr);
  const shell = /exec_command failed:[^\n]*sandbox_approval is false/i.test(stderr) || /EACCES|EPERM|access is denied/i.test(output);
  return kind === 'patch' ? patch : kind === 'shell' ? shell : kind === 'both' ? patch && shell : patch || shell;
}

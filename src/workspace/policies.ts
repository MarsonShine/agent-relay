import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { relativeFile } from '../core/handoff.ts';
import { RelayError } from '../core/errors.ts';

/** Only policy ancestors of checkout files (including authorized new files) can govern that checkout. */
export async function checkLocalPolicies(
  repo: string,
  tracked: string[],
  futureFiles: readonly string[] = [],
): Promise<void> {
  if (futureFiles.some((p) => !relativeFile.safeParse(p).success))
    throw new RelayError(
      'invalid',
      'authorized files must be repository-relative',
    );
  const key = (s: string) =>
    process.platform === 'win32' ? s.toLowerCase() : s;
  const known = new Set(tracked.map(key)),
    directories = new Set(['']);
  for (const path of [...tracked, ...futureFiles]) {
    let dir = posix.dirname(path);
    while (dir !== '.' && dir !== '') {
      directories.add(dir);
      dir = posix.dirname(dir);
    }
  }
  let entries = 0;
  const stat = async (path: string) =>
    lstat(path).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  async function policy(path: string): Promise<void> {
    const info = await stat(join(repo, path));
    if (!info) return;
    if (++entries > 100000 || info.isSymbolicLink())
      throw new RelayError(
        'invalid',
        'policy tree limit or link is unsupported',
      );
    if (info.isDirectory()) {
      for (const child of await readdir(join(repo, path)))
        await policy(path + '/' + child);
    } else if (!info.isFile() || !known.has(key(path)))
      throw new RelayError(
        'conflict',
        'repository instructions are not reproducible at this revision',
      );
  }
  for (const dir of [...directories].sort()) {
    const info = await stat(join(repo, dir));
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new RelayError(
        'invalid',
        'policy ancestor must be an ordinary directory',
      );
    const prefix = dir ? dir + '/' : '';
    await policy(prefix + 'AGENTS.md');
    await policy(prefix + '.agents');
    await policy(prefix + '.codex');
  }
}

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RelayError } from '../core/errors.ts';

export async function contentDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  let entries = 0,
    bytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (!prefix && name === '.git') continue;
      if (++entries > 100_000)
        throw new RelayError('invalid', 'snapshot entry limit exceeded');
      const path = join(directory, name),
        key = prefix + name,
        stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new RelayError(
          'conflict',
          'snapshot contains a link or special file',
        );
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([key, 'directory']));
        await visit(path, key + '/');
      } else {
        bytes += stat.size;
        if (bytes > 256 * 1024 * 1024 || stat.size > 32 * 1024 * 1024)
          throw new RelayError('invalid', 'snapshot content limit exceeded');
        const content = await readFile(path);
        if (content.length !== stat.size)
          throw new RelayError('conflict', 'snapshot changed while being read');
        hash.update(
          JSON.stringify([
            key,
            createHash('sha256').update(content).digest('hex'),
          ]),
        );
      }
    }
  }
  await visit(root, '');
  return hash.digest('hex');
}

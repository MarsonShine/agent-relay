import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { RelayError } from '../core/errors.ts';

type Tool = 'git' | 'gh';
const startupPath = process.env.PATH ?? process.env.Path ?? '';
const pinned = new Map<Tool, string>();
function contained(root: string, file: string): boolean {
  let canonical = root;
  try {
    canonical = realpathSync(root);
  } catch {
    /* A missing target cannot contain an installed tool. */
  }
  const path = relative(canonical, file);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
  );
}
/** Search absolute PATH entries directly; never ask the OS to resolve a tool in target cwd. */
export function resolveControllerTool(
  name: Tool,
  searchPath: string,
  excluded: readonly string[] = [],
): string {
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = realpathSync(
        join(directory, process.platform === 'win32' ? `${name}.exe` : name),
      );
      if (
        excluded.some((root) => contained(root, candidate)) ||
        !statSync(candidate).isFile()
      )
        continue;
      accessSync(
        candidate,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return candidate;
    } catch {
      /* Continue through trusted absolute PATH entries, without executing candidates. */
    }
  }
  throw new RelayError(
    'invalid',
    `trusted absolute ${name} executable is unavailable`,
  );
}
export function controllerTool(
  name: Tool,
  excluded: readonly string[] = [],
): string {
  const path =
    pinned.get(name) ?? resolveControllerTool(name, startupPath, excluded);
  if (excluded.some((root) => contained(root, path)))
    throw new RelayError(
      'invalid',
      'controller executable is inside the target repository',
    );
  pinned.set(name, path);
  return path;
}

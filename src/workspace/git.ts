import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  dirname,
  basename,
} from 'node:path';
import { RelayError } from '../core/errors.ts';
import { commitSchema } from './contracts.ts';
import type { Workspace } from './contracts.ts';
import { contentDigest } from './digest.ts';

export function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
  );
}
export function pathKey(path: string): string {
  return process.platform === 'win32'
    ? resolve(path).toLowerCase()
    : resolve(path);
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function destination(path: string): Promise<string> {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!(await exists(ancestor))) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  if (!(await lstat(ancestor)).isDirectory())
    throw new RelayError('invalid', 'workspace ancestor is not a directory');
  return resolve(await realpath(ancestor), ...suffix);
}

const policyPaths = [
  'AGENTS.md',
  ':(glob)**/AGENTS.md',
  '.codex',
  '.agents',
  ':(glob)**/.codex/**',
  ':(glob)**/.agents/**',
];
export class GitWorktrees {
  async command(
    repo: string,
    args: string[],
    input = '',
    missingAllowed = false,
  ): Promise<string> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/i.test(
            key,
          ),
      ),
    );
    return new Promise((resolveResult, reject) => {
      const child = execFile(
        'git',
        ['--no-pager', '-C', repo, ...args],
        {
          env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (!error) resolveResult(stdout);
          else if (missingAllowed && error.code === 1 && !error.killed)
            resolveResult('');
          else
            reject(
              new RelayError(
                'storage',
                `Git ${args[0]} failed; inspect repository state`,
              ),
            );
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
  }
  async identity(repo: string): Promise<{ repo: string; commonDir: string }> {
    const canonical = await realpath(repo);
    const top = await realpath(
      (await this.command(canonical, ['rev-parse', '--show-toplevel'])).trim(),
    );
    if (pathKey(canonical) !== pathKey(top))
      throw new RelayError(
        'invalid',
        'repository must be its Git checkout root',
      );
    const commonDir = await realpath(
      (
        await this.command(top, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).trim(),
    );
    return { repo: top, commonDir };
  }
  async head(path: string): Promise<string> {
    return commitSchema.parse(
      (await this.command(path, ['rev-parse', '--verify', 'HEAD'])).trim(),
    );
  }
  async status(path: string, ignored = false): Promise<string> {
    return this.command(path, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      ...(ignored ? ['--ignored'] : []),
    ]);
  }
  async preflight(repo: string, revision: string): Promise<void> {
    commitSchema.parse(revision);
    if (
      (
        await this.command(repo, [
          'rev-parse',
          '--verify',
          `${revision}^{commit}`,
        ])
      ).trim() !== revision
    )
      throw new RelayError('conflict', 'baseline is not an exact commit');
    if (
      await this.command(repo, ['config', '--get', 'core.hooksPath'], '', true)
    )
      throw new RelayError(
        'invalid',
        'custom Git hooks require a trusted integration',
      );
    const hook = (
      await this.command(repo, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'hooks/post-checkout',
      ])
    ).trim();
    if (await exists(hook))
      throw new RelayError(
        'invalid',
        'post-checkout hook requires a trusted integration',
      );
    if (
      await this.command(repo, ['config', '--get', 'core.fsmonitor'], '', true)
    )
      throw new RelayError(
        'invalid',
        'Git fsmonitor requires a trusted integration',
      );
    const tree = await this.command(repo, ['ls-tree', '-r', '-z', revision]);
    const names: string[] = [];
    for (const entry of tree.split('\0').filter(Boolean)) {
      if (/^(120000|160000) /.test(entry))
        throw new RelayError(
          'invalid',
          'symlink and submodule trees are not supported',
        );
      const name = entry.slice(entry.indexOf('\t') + 1);
      if (name.includes('\ufffd'))
        throw new RelayError('invalid', 'repository paths must be UTF-8');
      names.push(name);
    }
    if (names.length) {
      const attributes = (
        await this.command(
          repo,
          ['check-attr', `--source=${revision}`, '-z', '--stdin', 'filter'],
          names.join('\0') + '\0',
        )
      ).split('\0');
      for (let i = 2; i < attributes.length; i += 3) {
        if (!['unspecified', 'unset'].includes(attributes[i]!))
          throw new RelayError(
            'invalid',
            'checkout filters require a trusted integration',
          );
      }
    }
    const currentNames = await this.command(repo, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
    if (currentNames) {
      const attributes = (
        await this.command(
          repo,
          ['check-attr', '-z', '--stdin', 'filter'],
          currentNames,
        )
      ).split('\0');
      for (let i = 2; i < attributes.length; i += 3) {
        if (!['unspecified', 'unset'].includes(attributes[i]!))
          throw new RelayError(
            'invalid',
            'working tree filters require a trusted integration',
          );
      }
    }
    const index = await this.command(repo, ['ls-files', '--stage', '-z']);
    if (index.split('\0').some((entry) => /^(120000|160000) /.test(entry)))
      throw new RelayError(
        'invalid',
        'symlink and submodule indexes are not supported',
      );
    const flags = await this.command(repo, ['ls-files', '-v', '-z']);
    if (flags.split('\0').some((entry) => /^[a-zS] /.test(entry)))
      throw new RelayError(
        'invalid',
        'hidden or sparse index entries are not supported',
      );
    const changedRules = await this.command(repo, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      revision,
      '--',
      ...policyPaths,
    ]);
    const localRules = await this.command(repo, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored',
      '--',
      ...policyPaths,
    ]);
    if (changedRules || localRules)
      throw new RelayError(
        'conflict',
        'repository instructions are not reproducible at this revision',
      );
  }
  async listed(repo: string): Promise<Record<string, string>[]> {
    return (await this.command(repo, ['worktree', 'list', '--porcelain', '-z']))
      .split('\0\0')
      .filter(Boolean)
      .map((record) => {
        const fields: Record<string, string> = {};
        for (const line of record.split('\0').filter(Boolean)) {
          const space = line.indexOf(' ');
          fields[space < 0 ? line : line.slice(0, space)] =
            space < 0 ? '' : line.slice(space + 1);
        }
        return fields;
      });
  }
  async create(workspace: Workspace): Promise<void> {
    const args = [
      'worktree',
      'add',
      '--lock',
      '--reason',
      `agent-relay:${workspace.id}`,
    ];
    if (workspace.branch) args.push('-b', workspace.branch);
    else args.push('--detach');
    await this.command(workspace.repo, [
      ...args,
      workspace.path,
      workspace.revision,
    ]);
  }
  async verify(workspace: Workspace, clean: boolean): Promise<string> {
    if (pathKey(await realpath(workspace.path)) !== pathKey(workspace.path))
      throw new RelayError('conflict', 'workspace path changed');
    const identity = await this.identity(workspace.path);
    if (pathKey(identity.commonDir) !== pathKey(workspace.commonDir))
      throw new RelayError('conflict', 'workspace repository identity changed');
    if (workspace.kind !== 'repository') {
      if (
        !inside(workspace.root, workspace.path) ||
        inside(workspace.repo, workspace.path)
      )
        throw new RelayError('conflict', 'workspace escaped its managed root');
      const registered = (await this.listed(workspace.repo)).find(
        (entry) =>
          entry.worktree && pathKey(entry.worktree) === pathKey(workspace.path),
      );
      if (
        !registered ||
        registered.locked !== `agent-relay:${workspace.id}` ||
        (workspace.branch
          ? registered.branch !== `refs/heads/${workspace.branch}`
          : !Object.hasOwn(registered, 'detached'))
      )
        throw new RelayError('conflict', 'Git worktree registration changed');
    }
    const head = await this.head(workspace.path);
    if (workspace.kind !== 'implementation' && head !== workspace.revision)
      throw new RelayError('conflict', 'fixed workspace revision changed');
    if (workspace.kind === 'implementation') {
      if (
        (await this.command(workspace.path, [
          'merge-base',
          workspace.baselineRevision,
          head,
        ])) !==
        workspace.baselineRevision + '\n'
      )
        throw new RelayError(
          'conflict',
          'workspace no longer descends from baseline',
        );
    }
    await this.preflight(workspace.path, head);
    if (
      clean &&
      (await this.status(workspace.path, workspace.kind === 'review'))
    )
      throw new RelayError('conflict', 'fixed workspace is dirty');
    if (
      workspace.contentHash &&
      (await contentDigest(workspace.path)) !== workspace.contentHash
    )
      throw new RelayError('conflict', 'snapshot contents changed');
    return head;
  }
  async assertRemovable(workspace: Workspace): Promise<void> {
    await this.verify(workspace, true);
    if (await this.status(workspace.path, true))
      throw new RelayError(
        'conflict',
        'workspace contains files that must be preserved',
      );
    await contentDigest(workspace.path);
  }
  async remove(workspace: Workspace): Promise<void> {
    await this.assertRemovable(workspace);
    await this.command(workspace.repo, ['worktree', 'unlock', workspace.path]);
    await this.command(workspace.repo, ['worktree', 'remove', workspace.path]);
  }
}

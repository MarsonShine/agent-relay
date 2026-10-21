import { mkdirSync } from 'node:fs';
import { OwnedProcess, stopOwned } from '../runtime/owned-process.ts';
import { checkLocalPolicies } from './policies.ts';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  dirname,
  basename,
  join,
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
  recoveryRoot: string | undefined;
  private async mutate(
    workspace: Workspace,
    operation: string,
    args: string[],
    timeoutMs = 30000,
  ): Promise<void> {
    if (!this.recoveryRoot)
      throw new RelayError(
        'invalid',
        'Git mutation requires durable ownership',
      );
    mkdirSync(this.recoveryRoot, { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMDATA|LANG|LC_ALL)$/i.test(
          key,
        ),
      ),
    );
    const child = new OwnedProcess(
      join(this.recoveryRoot, `${workspace.id}-${operation}`),
      workspace.id,
      { executable: 'git' },
      ['--no-pager', '-C', workspace.repo, ...args],
      {
        cwd: workspace.repo,
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        input: '',
        timeoutMs,
        maxBytes: 8 * 1024 * 1024,
        stdout: () => {},
        stderr: () => {},
      },
    );
    const exit = await child.done;
    if (!exit.stopped || exit.code !== 0 || exit.reason)
      throw new RelayError(
        'storage',
        `Git worktree failed (${operation}; exit=${exit.code}; stopped=${exit.stopped}; reason=${exit.reason ?? 'none'}); inspect recorded intent`,
      );
  }
  async reconcile(workspace: Workspace): Promise<'stopped' | 'unknown'> {
    if (!this.recoveryRoot || !workspace.recoveryVersion) return 'unknown';
    const operations =
      workspace.state === 'creating' ? ['create'] : ['unlock', 'remove'];
    const states = await Promise.all(
      operations.map((op) =>
        stopOwned(
          join(this.recoveryRoot!, `${workspace.id}-${op}`),
          workspace.id,
        ),
      ),
    );
    return states.every((s) => s === 'stopped') ? 'stopped' : 'unknown';
  }

  async command(
    repo: string,
    args: string[],
    input = '',
    missingAllowed = false,
    timeoutMs = 30000,
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
          timeout: timeoutMs,
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
                `Git ${args[0]} failed (${error.killed ? 'timeout' : error.code}); inspect repository state`,
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
  async preflight(
    repo: string,
    revision: string,
    futureFiles: readonly string[] = [],
  ): Promise<void> {
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
    const fsmonitor = (
      await this.command(repo, ['config', '--get', 'core.fsmonitor'], '', true)
    ).trim();
    const builtinMonitor = /^(true|yes|on|1)$/i.test(fsmonitor);
    if (builtinMonitor) {
      const version = (await this.command(repo, ['version'])).match(
        /git version (\d+)\.(\d+)/,
      );
      if (
        process.platform !== 'win32' ||
        !version ||
        Number(version[1]) < 2 ||
        (Number(version[1]) === 2 && Number(version[2]) < 36)
      )
        throw new RelayError(
          'invalid',
          'built-in fsmonitor requires supported native Windows Git',
        );
    }
    if (fsmonitor && !builtinMonitor && !/^(false|no|off|0)$/i.test(fsmonitor))
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
    await checkLocalPolicies(repo, names, futureFiles);
    if (changedRules)
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
    await this.mutate(
      workspace,
      'create',
      [...args, workspace.path, workspace.revision],
      120000,
    );
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
    await this.mutate(workspace, 'unlock', [
      'worktree',
      'unlock',
      workspace.path,
    ]);
    await this.mutate(workspace, 'remove', [
      'worktree',
      'remove',
      workspace.path,
    ]);
  }
}

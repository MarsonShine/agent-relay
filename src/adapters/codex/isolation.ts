import { homedir } from 'node:os';
import { controllerTool } from '../../runtime/controller-tools.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ExecutionRequest } from '../../core/execution.ts';
import { RelayError } from '../../core/errors.ts';
import { permissionArguments } from './config.ts';
const exec = promisify(execFile);
/** Native permission profile: controller state and desktop tool bridges are not agent capabilities. */
export async function isolatedPermissions(
  request: ExecutionRequest,
  deniedPaths: readonly string[],
  temporaryDirectory?: string,
): Promise<string[]> {
  if (!request.workspace?.managedId)
    throw new RelayError(
      'invalid',
      'isolated execution requires registered workspace identity',
    );
  const cwd = await realpath(request.workspace.path);
  const git = async (args: string[]) =>
    (
      await exec(controllerTool('git', [cwd]), ['-C', cwd, ...args], {
        timeout: 5000,
        maxBuffer: 1048576,
        windowsHide: true,
      })
    ).stdout.trim();
  const names = (
    await git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])
  ).split('\0');
  if (
    names.some((p) => /(^|\/)\.codex\//.test(p) || /(^|\/)\.mcp\.json$/.test(p))
  )
    throw new RelayError(
      'invalid',
      'project runtime extensions require an audited integration',
    );
  const common = await realpath(
    await git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const gitDir = await realpath(
    await git(['rev-parse', '--path-format=absolute', '--git-dir']),
  );
  const filesystem: Record<string, string> = {
    [process.platform === 'win32' ? ':root' : ':minimal']: 'read',
    [cwd]:
      request.run.profile.permission === 'workspace-write' ? 'write' : 'read',
    [common]: 'read',
  };
  if (request.run.profile.permission === 'workspace-write') {
    const branch = await git(['symbolic-ref', '--short', 'HEAD']);
    if (!/^codex\/task-[a-f0-9-]+\/work$/.test(branch) || common === gitDir)
      throw new RelayError(
        'invalid',
        'write profile requires its task worktree',
      );
    filesystem[gitDir] = 'write';
    filesystem[join(common, 'objects')] = 'write';
    const namespace = branch.slice(0, -'/work'.length);
    filesystem[join(common, 'refs', 'heads', namespace)] = 'write';
    filesystem[join(common, 'logs', 'refs', 'heads', namespace)] = 'write';
  }
  if (
    temporaryDirectory &&
    request.run.profile.permission === 'workspace-write'
  )
    filesystem[temporaryDirectory] = 'write';
  const home = homedir();
  const credentials = [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.azure'),
    join(home, '.kube'),
    join(home, '.git-credentials'),
    join(home, '.config', 'gh'),
    join(process.env.APPDATA ?? home, 'GitHub CLI'),
    join(process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json'),
    join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
  ];
  for (const path of [...deniedPaths, ...credentials]) {
    if (!isAbsolute(path))
      throw new RelayError('invalid', 'protected paths must be absolute');
    filesystem[path] = 'deny';
  }
  const table = Object.entries(filesystem)
    .map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`)
    .join(',');
  return [
    ...permissionArguments('read-only').slice(2),
    '-c',
    'default_permissions="relay"',
    '-c',
    `permissions.relay={filesystem={${table}},network={enabled=false}}`,
    '-c',
    'features.apps=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'features.multi_agent_v2=false',
    '-c',
    'features.multi_agent_v2_dynamic_tools=false',
  ];
}

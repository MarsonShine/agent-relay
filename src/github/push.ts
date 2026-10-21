import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { OwnedProcess, stopOwned } from '../runtime/owned-process.ts';
import type { DeliveryIntent } from './delivery-store.ts';
import type { GitHubPolicy } from './contracts.ts';
import { RelayError } from '../core/errors.ts';

export interface Push {
  send(
    intent: DeliveryIntent,
    policy: GitHubPolicy,
    workspace: string,
  ): Promise<void>;
  stop(intent: DeliveryIntent): Promise<'stopped' | 'unknown'>;
}
export class GitPush implements Push {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  async send(
    intent: DeliveryIntent,
    policy: GitHubPolicy,
    workspace: string,
  ): Promise<void> {
    const child = new OwnedProcess(
      join(this.directory, intent.key),
      intent.key,
      { executable: 'git' },
      [
        '-c',
        'credential.interactive=never',
        '-c',
        'http.lowSpeedLimit=1',
        '-c',
        'http.lowSpeedTime=15',
        '-C',
        workspace,
        'push',
        '--porcelain',
        `https://github.com/${policy.repository}.git`,
        `${intent.revision}:refs/heads/${intent.branch}`,
      ],
      {
        cwd: workspace,
        input: '',
        timeoutMs: 30000,
        maxBytes: 1048576,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) =>
              /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMDATA)$/i.test(
                k,
              ),
            ),
          ),
          GIT_TERMINAL_PROMPT: '0',
        },
        stdout: () => {},
        stderr: () => {},
      },
    );
    const result = await child.done;
    if (!result.stopped || result.code !== 0)
      throw new RelayError(
        'conflict',
        'push outcome requires remote reconciliation',
      );
  }
  stop(intent: DeliveryIntent) {
    return stopOwned(join(this.directory, intent.key), intent.key);
  }
}

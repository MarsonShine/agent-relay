import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { BoundedProcess, Command, ProcessExit } from './process.ts';

export type ProcessOptions = ConstructorParameters<typeof BoundedProcess>[2];
export type OwnedRequest = {
  owner: string;
  command: Command;
  args: string[];
  options: Omit<ProcessOptions, 'stdout' | 'stderr'>;
  deadlineAt: number;
};
const receiptSchema = z.strictObject({
  transientFailure: z.boolean().optional(),
  owner: z.uuid(),
  code: z.number().int().nullable(),
  stopped: z.boolean(),
  reason: z.string().nullable(),
});
export function publish(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  });
  renameSync(temporary, path);
}
export function receipt(directory: string, owner: string): ProcessExit | null {
  try {
    const result = receiptSchema.parse(
      JSON.parse(readFileSync(join(directory, 'exit.json'), 'utf8')),
    );
    return result.owner === owner ? result : null;
  } catch {
    return null;
  }
}
/** Fences a launch that has not acquired its gate, or asks its original owner to stop. */
export async function stopOwned(
  directory: string,
  owner: string,
): Promise<'stopped' | 'unknown'> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  publish(join(directory, 'cancel.json'), { owner });
  try {
    writeFileSync(join(directory, 'gate'), 'cancelled', {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    publish(join(directory, 'exit.json'), {
      owner,
      code: null,
      stopped: true,
      reason: 'cancelled before launch',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'unknown';
  }
  const until = Date.now() + 1200;
  do {
    const result = receipt(directory, owner);
    if (result) return result.stopped ? 'stopped' : 'unknown';
    await delay(25);
  } while (Date.now() < until);
  return 'unknown';
}

/** The guardian owns OS handles; the service owns a durable, single-use launch directory. */
export class OwnedProcess {
  readonly done: Promise<ProcessExit>;
  private result: ProcessExit | null = null;
  private readonly directory: string;
  private readonly owner: string;
  constructor(
    directory: string,
    owner: string,
    command: Command,
    args: string[],
    options: ProcessOptions,
  ) {
    this.directory = directory;
    this.owner = owner;
    mkdirSync(directory, { mode: 0o700 }); // A previous attempt or cancellation must never be overwritten.
    const { stdout, stderr, ...serializable } = options;
    const deadlineAt = Date.now() + options.timeoutMs;
    publish(join(directory, 'request.json'), {
      owner,
      command,
      args,
      options: serializable,
      deadlineAt,
    } satisfies OwnedRequest);
    const guardian = fileURLToPath(
      new URL(
        import.meta.url.endsWith('.ts') ? './guardian.ts' : './guardian.js',
        import.meta.url,
      ),
    );
    const child = spawn(process.execPath, [guardian, directory], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(key),
        ),
      ),
    });
    child.on('error', () => {
      void stopOwned(directory, owner);
    });
    child.unref();
    this.done = (async () => {
      const offsets = [0, 0];
      while (true) {
        const exit = receipt(directory, owner);
        for (const [index, consume] of [stdout, stderr].entries()) {
          const path = join(directory, index === 0 ? 'stdout' : 'stderr');
          if (!existsSync(path)) continue;
          const data = readFileSync(path);
          if (data.length > options.maxBytes)
            throw new Error('guardian output exceeded bound');
          const chunk = data.subarray(offsets[index]);
          offsets[index] = data.length;
          if (chunk.length) {
            try {
              consume(chunk);
            } catch {
              await stopOwned(directory, owner);
            }
          }
        }
        if (exit) {
          this.result = exit;
          return exit;
        }
        if (Date.now() > deadlineAt + 3000) {
          await stopOwned(directory, owner);
          this.result = receipt(directory, owner) ?? {
            code: null,
            stopped: false,
            reason: 'guardian unavailable',
          };
          return this.result;
        }
        await delay(25);
      }
    })();
  }
  async stop(): Promise<'stopped' | 'unknown'> {
    return stopOwned(this.directory, this.owner);
  }
  status(): 'active' | 'stopped' | 'unknown' {
    const result = this.result ?? receipt(this.directory, this.owner);
    return result ? (result.stopped ? 'stopped' : 'unknown') : 'active';
  }
}

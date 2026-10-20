import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type Command = { executable: string; prefixArgs?: readonly string[] };
export type ProcessExit = {
  code: number | null;
  stopped: boolean;
  reason: string | null;
};
export class BoundedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<ProcessExit>;
  private closeSeen = false;
  private spawnFailed = false;
  private result: ProcessExit | null = null;
  private resolveDone!: (exit: ProcessExit) => void;
  private resolveClosed!: () => void;
  private readonly closed: Promise<void>;
  private stopping: Promise<'stopped' | 'unknown'> | null = null;
  private reason: string | null = null;
  private timer: NodeJS.Timeout;
  constructor(
    command: Command,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      input: string;
      timeoutMs: number;
      maxBytes: number;
      stdout: (chunk: Buffer) => void;
      stderr: (chunk: Buffer) => void;
    },
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.child = spawn(
      command.executable,
      [...(command.prefixArgs ?? []), ...args],
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let bytes = 0;
    const receive = (chunk: Buffer, consume: (chunk: Buffer) => void) => {
      if (this.result || this.reason) return;
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        void this.stop('output limit exceeded');
        return;
      }
      try {
        consume(chunk);
      } catch {
        void this.stop('output processing failed');
      }
    };
    this.child.stdout.on('data', (chunk: Buffer) =>
      receive(chunk, options.stdout),
    );
    this.child.stderr.on('data', (chunk: Buffer) =>
      receive(chunk, options.stderr),
    );
    this.child.on('error', () => {
      this.spawnFailed = true;
      this.reason ??= 'process could not start';
    });
    this.child.stdin.on('error', () => {
      this.reason ??= 'process input failed';
    });
    this.child.on('close', (code) => {
      this.closeSeen = true;
      this.resolveClosed();
      if (!this.stopping)
        this.complete({ code, stopped: true, reason: this.reason });
    });
    this.timer = setTimeout(() => {
      void this.stop('execution timeout');
    }, options.timeoutMs);
    this.child.stdin.end(options.input);
  }
  private complete(exit: ProcessExit): void {
    if (this.result) return;
    clearTimeout(this.timer);
    this.result = exit;
    this.resolveDone(exit);
    this.child.stdout.removeAllListeners('data');
    this.child.stderr.removeAllListeners('data');
    if (!exit.stopped) {
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.child.stdin.destroy();
      this.child.unref();
    }
  }
  async stop(reason = 'execution cancelled'): Promise<'stopped' | 'unknown'> {
    if (this.result) return this.result.stopped ? 'stopped' : 'unknown';
    if (this.stopping) return this.stopping;
    this.reason ??= reason;
    this.stopping = this.terminate();
    return this.stopping;
  }
  private async terminate(): Promise<'stopped' | 'unknown'> {
    const pid = this.child.pid;
    let confirmed = this.spawnFailed;
    // An exited parent is not a safe identity for signalling a possibly reused PID.
    if (pid && this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === 'win32') {
        confirmed = await new Promise<boolean>((resolve) => {
          execFile(
            join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'taskkill.exe',
            ),
            ['/PID', String(pid), '/T', '/F'],
            { windowsHide: true, timeout: 1_000, maxBuffer: 16_384 },
            (error) => resolve(!error),
          );
        });
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
          confirmed = true;
        } catch {
          confirmed = false;
        }
      }
    }
    let timer: NodeJS.Timeout | undefined;
    if (confirmed) {
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 300);
        }),
      ]);
      clearTimeout(timer);
    }
    const stopped = confirmed && this.closeSeen;
    this.complete({ code: this.child.exitCode, stopped, reason: this.reason });
    return stopped ? 'stopped' : 'unknown';
  }
  status(): 'active' | 'stopped' | 'unknown' {
    return this.result
      ? this.result.stopped
        ? 'stopped'
        : 'unknown'
      : 'active';
  }
}

import { spawn, spawnSync } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type ProbeResult = {
  exitCode: number | null; signal: string | null; events: any[]; stdout: string; stderr: string;
  parseErrors: string[]; stopReason: string | null; treeStop: string | null; durationMs: number;
  pid: number | undefined; terminal: string | null; outcome: string;
};

// Experimental process observer, not the production Agent execution adapter.
export async function probe(executable: string, args: string[], options: {
  cwd: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number;
  cancelWhen?: (event: any) => boolean;
}): Promise<ProbeResult> {
  const started = Date.now();
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd, env: options.env ?? process.env, shell: false,
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  };
  const child = spawn(executable, args, spawnOptions);
  const decoder = new StringDecoder('utf8');
  let stdout = '', stderr = '', pending = '';
  let stopReason: string | null = null, treeStop: string | null = null;
  let spawnError: Error | null = null;
  let finish: ((value: [number | null, string | null]) => void) | undefined;
  const events: any[] = [], parseErrors: string[] = [];
  const maxBytes = 2 * 1024 * 1024;
  let bytes = 0;
  function stop(reason: string) {
    if (stopReason) return;
    stopReason = reason;
    if (!child.pid || child.exitCode !== null) {
      treeStop = 'unknown';
    } else if (process.platform === 'win32') {
      const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 10000, encoding: 'utf8' });
      treeStop = result.status === 0 ? 'command_succeeded' : 'unknown';
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); treeStop = 'command_succeeded'; }
      catch { treeStop = 'unknown'; }
    }
    // Unknown stop must remain visible; never wait indefinitely on inherited pipes.
    if (treeStop === 'unknown') {
      child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref();
      finish?.([null, null]);
    }
  }
  function line(text: string) {
    if (!text.trim()) return;
    try {
      const event = JSON.parse(text);
      if (!event || typeof event.type !== 'string') throw new Error('missing event type');
      events.push(event);
      if (options.cancelWhen?.(event)) stop('requested_cancel');
    } catch (error) { parseErrors.push(String(error)); }
  }
  child.stdout!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) { stop('output_limit'); return; }
    const text = decoder.write(chunk);
    stdout += text; pending += text;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      line(pending.slice(0, newline)); pending = pending.slice(newline + 1);
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) { stop('output_limit'); return; }
    stderr += chunk.toString('utf8');
  });
  child.stdin!.on('error', () => {}); // Early config rejection may close stdin.
  child.stdin!.end(options.input ?? '');
  const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 180000);
  const [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    finish = resolve;
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => resolve([code, signal]));
  });
  clearTimeout(timer);
  pending += decoder.end();
  if (pending.trim()) parseErrors.push('truncated JSONL line');
  const terminal = events.findLast(e => e.type === 'turn.completed' || e.type === 'turn.failed')?.type ?? null;
  let outcome = 'needs_reconciliation';
  if (spawnError) outcome = 'spawn_failed';
  else if (stopReason) outcome = treeStop === 'unknown' ? 'stop_unknown' : 'stopped';
  else if (exitCode !== 0 || terminal === 'turn.failed') outcome = 'failed';
  else if (terminal === 'turn.completed' && parseErrors.length === 0) outcome = 'turn_completed';
  return { exitCode, signal, events, stdout, stderr, parseErrors, stopReason, treeStop,
    durationMs: Date.now() - started, pid: child.pid, terminal, outcome };
}

export function fixtureAccepted(outcome: string, status: unknown, schemaValid: boolean, check: number | null): boolean {
  return outcome === 'turn_completed' && status === 'completed' && schemaValid && check === 0;
}

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BoundedProcess } from './process.ts';
import { publish } from './owned-process.ts';
import type { OwnedRequest } from './owned-process.ts';

// Only this detached process may acquire the single-use gate and hold child handles.
const directory = process.argv[2]!;
const request = JSON.parse(
  readFileSync(join(directory, 'request.json'), 'utf8'),
) as OwnedRequest;
try {
  writeFileSync(join(directory, 'gate'), request.owner, {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  });
} catch {
  process.exit(0);
}
const cancelled = () => existsSync(join(directory, 'cancel.json'));
if (cancelled() || Date.now() >= request.deadlineAt) {
  publish(join(directory, 'exit.json'), {
    owner: request.owner,
    code: null,
    stopped: true,
    reason: 'launch fenced or deadline exhausted',
  });
} else {
  const child = new BoundedProcess(request.command, request.args, {
    ...request.options,
    timeoutMs: Math.max(1, request.deadlineAt - Date.now()),
    stdout: (b) =>
      appendFileSync(join(directory, 'stdout'), b, { mode: 0o600 }),
    stderr: (b) =>
      appendFileSync(join(directory, 'stderr'), b, { mode: 0o600 }),
  });
  const timer = setInterval(() => {
    if (cancelled()) void child.stop();
  }, 25);
  const exit = await child.done;
  clearInterval(timer);
  publish(join(directory, 'exit.json'), { owner: request.owner, ...exit });
}

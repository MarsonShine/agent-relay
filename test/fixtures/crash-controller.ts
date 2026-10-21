import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Database } from '../../src/storage/database.ts';
import { Tasks } from '../../src/storage/tasks.ts';
import { Evidence } from '../../src/storage/evidence.ts';
import { Controller } from '../../src/workflow/controller.ts';
import { CodexExecutor } from '../../src/adapters/codex/executor.ts';

const [directory, point] = process.argv.slice(2) as [string, string];
const db = new Database(join(directory, 'state.db')),
  tasks = new Tasks(db);
const backend = new CodexExecutor({
  directory: join(directory, 'executions'),
  command: {
    executable: process.execPath,
    prefixArgs: [
      resolve('test/fixtures/fake-codex.ts'),
      point === 'before-settle' ? 'success' : 'tree',
    ],
  },
});
const start = backend.start.bind(backend);
backend.start = async (request) => {
  if (point === 'before-spawn') {
    writeFileSync(join(directory, 'checkpoint'), point);
    await new Promise(() => {});
  }
  return start({
    ...request,
    workspace: { path: request.task.repo, kind: 'repository' },
  });
};
const controller = new Controller(
  tasks,
  new Evidence(tasks, join(directory, 'evidence')),
  backend,
);
if (point === 'before-settle')
  controller.runs.finish = () => {
    writeFileSync(join(directory, 'checkpoint'), point);
    process.kill(process.pid, 'SIGKILL');
    throw Error('unreachable');
  };
setInterval(() => {}, 1000);
await controller.tick();
await controller.wait();

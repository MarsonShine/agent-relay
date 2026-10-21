import { Database } from '../../src/storage/database.ts';
import { Tasks } from '../../src/storage/tasks.ts';
import { Runs } from '../../src/storage/runs.ts';

const db = new Database(process.argv[2]!);
process.stdout.write('ready\n');
await new Promise<void>((resolve) =>
  process.stdin.once('data', () => resolve()),
);
try {
  process.stdout.write(
    `${JSON.stringify(new Runs(new Tasks(db)).claim(process.argv[3]!, 'worker-v1')?.id ?? null)}\n`,
  );
} finally {
  db.close();
  process.stdin.destroy();
}

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const scenario = process.argv[2]!;
const args = process.argv.slice(3);
if (args.includes('--version')) {
  if (scenario === 'delayed-version')
    await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(
    scenario === 'wrong-version'
      ? 'codex-cli unverified'
      : 'codex-cli 0.163.0-alpha.10.2',
  );
  process.exit(0);
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString('utf8');
const request = JSON.parse(input.split('\n').at(-1)!);
const output = args[args.indexOf('-o') + 1]!;
const schema = JSON.parse(
  readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf8'),
);
if (schema.additionalProperties !== false)
  throw new Error('expected strict output schema');
writeFileSync(
  join(dirname(output), 'invocation.json'),
  JSON.stringify({ args, input }),
);
const emit = (event: unknown) =>
  process.stdout.write(JSON.stringify(event) + '\n');
let session = '00000000-0000-4000-8000-000000000001';
if (args.includes('resume')) session = args.at(-2)!;
if (scenario === 'wrong-session')
  session = '00000000-0000-4000-8000-000000000002';
emit({ type: 'thread.started', thread_id: session });
emit({ type: 'turn.started' });
if (scenario === 'slow' || scenario === 'tree') {
  if (scenario === 'tree') {
    const code =
      "const fs=require('node:fs');const f=process.argv[1];let n=0;const tick=()=>fs.writeFileSync(f,JSON.stringify({pid:process.pid,n:n++}));tick();const t=setInterval(tick,30);setTimeout(()=>clearInterval(t),5000);";
    spawn(
      process.execPath,
      ['-e', code, join(process.cwd(), 'heartbeat.json')],
      { stdio: 'inherit', windowsHide: true },
    );
  }
  const timer = setInterval(() => {}, 100);
  setTimeout(() => clearInterval(timer), 5000);
} else if (scenario === 'orphan') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
} else {
  if (scenario === 'stderr-limit') process.stderr.write('x'.repeat(400_000));
  if (scenario === 'malformed') process.stdout.write('{malformed}\n');
  const final = {
    schemaVersion: 1,
    status:
      scenario === 'blocked'
        ? 'blocked'
        : scenario === 'question'
          ? 'input_required'
          : 'completed',
    evidence:
      scenario === 'stale'
        ? { ...request.evidence, requirementVersion: 99 }
        : request.evidence,
    output:
      scenario === 'workflow'
        ? request.stage === 'triage'
          ? {
              stage: 'triage',
              kind: 'consultation',
              goal: 'explain value',
              nonGoals: [],
              acceptance: [{ id: 'A1', description: 'cite value' }],
              scope: [],
              simpleReason: null,
            }
          : {
              stage: 'answer',
              conclusion: 'baseline value',
              sources: [{ path: 'value.txt', line: 1, excerpt: 'baseline' }],
              limitations: [],
            }
        : scenario === 'empty'
          ? ''
          : 'Fixture role finished.',
    question: scenario === 'question' ? 'Choose the scope.' : null,
    diagnostic: null,
  };
  if (scenario !== 'missing-file')
    writeFileSync(
      output,
      scenario === 'invalid-json'
        ? '{}'
        : scenario === 'oversized-file'
          ? 'x'.repeat(300_000)
          : JSON.stringify(final),
    );
  if (scenario !== 'missing-terminal')
    emit({
      type: 'turn.completed',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  if (scenario === 'nonzero') process.exitCode = 2;
  if (scenario === 'stderr')
    process.stderr.write('api_key=private-fixture-value\n');
}

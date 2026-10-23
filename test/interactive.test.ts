import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chat, terminalText } from '../src/interactive/chat.ts';
import { converse } from '../src/interactive/session.ts';
import {
  configure,
  loadSettings,
  saveSettings,
} from '../src/interactive/setup.ts';
import type { ChatIO } from '../src/interactive/setup.ts';
import { defaultConfig } from '../src/core/config.ts';
import { RelayError } from '../src/core/errors.ts';
import { Database } from '../src/storage/database.ts';
import { Tasks } from '../src/storage/tasks.ts';
import { Runs } from '../src/storage/runs.ts';
import { Evidence } from '../src/storage/evidence.ts';
import { Controller } from '../src/workflow/controller.ts';
import { FakeExecutor } from '../src/adapters/fake.ts';
import { fixture, request } from './helpers.ts';

function scripted(answers: (string | null)[]) {
  const control = new AbortController();
  const output: string[] = [],
    prompts: string[] = [];
  const io: ChatIO = {
    signal: control.signal,
    write: (message) => {
      output.push(message);
    },
    async ask(prompt) {
      prompts.push(prompt);
      return answers.shift() ?? null;
    },
  };
  return { io, control, output, prompts };
}

test('built interactive CLI accepts a prompt and displays a verified simulation result without a second terminal', async (t) => {
  const f = fixture(t),
    directory = join(f.directory, 'chat');
  const child = spawn(
    process.execPath,
    [
      resolve('dist/cli.js'),
      'chat',
      '--demo',
      '--repo',
      f.directory,
      '--data-dir',
      directory,
    ],
    { windowsHide: true },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += String(b);
  });
  child.stderr.on('data', (b) => {
    stderr += String(b);
  });
  const done = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await done;
  });
  child.stdin.end('Explain this simulated task\n');
  assert.equal(await done, 0, stderr);
  assert.match(stdout, /需求 >/);
  assert.match(stdout, /模拟完成/);
  assert.match(stdout, /No repository changes or model execution/);
  assert.ok(loadSettings(directory)?.lastTaskId);
  const next = scripted(['/exit']);
  assert.equal(await chat({ directory }, next.io), 0);
  assert.equal(next.prompts.length, 1, 'saved configuration skips setup');
});

test('interactive questions are answered in the same session and keep versioned history', async (t) => {
  const f = fixture(t),
    directory = join(f.directory, 'chat');
  const config = defaultConfig();
  config.profiles.design.native.scenario = 'input';
  const configPath = join(f.directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const ui = scripted(['A task needing scope', 'Only the requested scope']);
  assert.equal(
    await chat({ directory, repo: f.directory, config: configPath }, ui.io),
    0,
  );
  assert.ok(ui.output.some((s) => s.includes('需要你补充')));
  assert.equal(ui.prompts.length, 2);
  const db = new Database(join(directory, 'state.db'));
  try {
    const tasks = new Tasks(db),
      task = tasks.get(loadSettings(directory)!.lastTaskId!);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.requirementVersion, 2);
    assert.equal(
      tasks.decisions(task.id)[0]!.answer,
      'Only the requested scope',
    );
    assert.equal(new Runs(tasks).outstanding().length, 0);
  } finally {
    db.close();
  }
});

test('interrupting chat pauses owned execution and reuses its task and budget on reopen', async (t) => {
  const f = fixture(t),
    directory = join(f.directory, 'chat');
  const config = defaultConfig();
  config.profiles.design.native.scenario = 'slow';
  const configPath = join(f.directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const ui = scripted(['Slow task']);
  ui.io.write = (message) => {
    ui.output.push(message);
    if (message.includes('· running')) ui.control.abort();
  };
  assert.equal(
    await chat({ directory, repo: f.directory, config: configPath }, ui.io),
    130,
  );
  const id = loadSettings(directory)!.lastTaskId!;
  const db = new Database(join(directory, 'state.db'));
  let deadline: number, used: number;
  try {
    const tasks = new Tasks(db),
      task = tasks.get(id);
    assert.equal(task.status, 'paused');
    assert.equal(new Runs(tasks).outstanding().length, 0);
    deadline = task.deadlineAt;
    used = task.runsUsed;
  } finally {
    db.close();
  }
  const reopened = scripted(['no']);
  assert.equal(await chat({ directory }, reopened.io), 0);
  assert.match(reopened.prompts[0]!, /任务已暂停/);
  const check = new Database(join(directory, 'state.db'));
  try {
    const task = new Tasks(check).get(id);
    assert.equal(task.deadlineAt, deadline);
    assert.equal(task.runsUsed, used);
  } finally {
    check.close();
  }
  assert.equal(loadSettings(directory)!.lastTaskId, id);
});

test('EOF before a prompt creates no task and EOF at a question preserves waiting state', async (t) => {
  const f = fixture(t),
    directory = join(f.directory, 'chat');
  assert.equal(
    await chat({ directory, repo: f.directory, demo: true }, scripted([]).io),
    0,
  );
  assert.equal(loadSettings(directory)!.lastTaskId, undefined);
  const config = defaultConfig();
  config.profiles.design.native.scenario = 'input';
  const configPath = join(f.directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(
    await chat(
      { directory, repo: f.directory, config: configPath },
      scripted(['Task']).io,
    ),
    0,
  );
  const db = new Database(join(directory, 'state.db'));
  try {
    const tasks = new Tasks(db),
      task = tasks.get(loadSettings(directory)!.lastTaskId!);
    assert.equal(task.status, 'waiting_user');
    assert.equal(task.runsUsed, 1);
    assert.equal(new Runs(tasks).outstanding().length, 0);
  } finally {
    db.close();
  }
  const answer = scripted(['Answer after restart']);
  assert.equal(await chat({ directory }, answer.io), 0);
  assert.equal(answer.prompts.length, 1);
  assert.match(answer.prompts[0]!, /答复/);
});

test('chat never reports a successful status as acceptance when evidence is invalid', async (t) => {
  const f = fixture(t),
    task = f.tasks.create(request());
  const ui = scripted(['Task']);
  const calls: string[] = [];
  const result = await converse(
    async (path) => {
      calls.push(path);
      if (path === '/v1/tasks') return { task };
      return {
        task: { ...task, status: 'succeeded' },
        accepted: false,
        artifacts: [],
        evidenceIssues: ['missing artifact'],
      };
    },
    ui.io,
    { schemaVersion: 1, repo: f.directory, config: defaultConfig() },
    () => {},
  );
  assert.equal(result, 1);
  assert.match(ui.output.join('\n'), /结果未通过验收/);
  assert.ok(!ui.output.some((s) => s.includes('模拟完成')));
  assert.ok(!calls.some((p) => p.includes('delivery')));
});

test('question conflicts are not retried with a new version or silently applied to another question', async (t) => {
  const f = fixture(t),
    task = f.tasks.create(request());
  const question = { id: task.id, version: 1, text: 'Choose the scope' };
  const ui = scripted(['Task', 'Answer']);
  const bodies: unknown[] = [];
  await assert.rejects(
    converse(
      async (path, body) => {
        if (path === '/v1/tasks') return { task };
        if (path.endsWith('/commands')) {
          bodies.push(body);
          throw new RelayError('conflict', 'task changed');
        }
        return {
          task: { ...task, status: 'waiting_user', question },
          accepted: false,
          artifacts: [],
          evidenceIssues: [],
        };
      },
      ui.io,
      { schemaVersion: 1, repo: f.directory, config: defaultConfig() },
      () => {},
    ),
    /task changed/,
  );
  assert.deepEqual(bodies, [
    {
      schemaVersion: 1,
      command: {
        action: 'answer',
        expectedVersion: task.version,
        questionId: question.id,
        questionVersion: 1,
        answer: 'Answer',
      },
    },
  ]);
});

test('unknown recovery is retained without new task, resume, budget increase or publication', async (t) => {
  const f = fixture(t),
    task = f.tasks.create(request());
  const ui = scripted([]);
  const calls: string[] = [];
  assert.equal(
    await converse(
      async (path, body) => {
        calls.push(path);
        assert.equal(body, undefined);
        return {
          task: { ...task, status: 'recovering', diagnostic: 'stop unknown' },
          accepted: false,
          artifacts: [],
          evidenceIssues: [],
        };
      },
      ui.io,
      {
        schemaVersion: 1,
        repo: f.directory,
        config: defaultConfig(),
        lastTaskId: task.id,
      },
      () => assert.fail('must not create another task'),
    ),
    1,
  );
  assert.ok(calls.every((p) => p === `/v1/tasks/${task.id}`));
  assert.match(ui.output.join('\n'), /保持隔离/);
});

test('setup records explicit bounded policies and rejects malformed trusted input', async (t) => {
  const f = fixture(t);
  if (process.platform !== 'win32') {
    await assert.rejects(
      configure(scripted(['1', f.directory]).io, join(f.directory, 'chat')),
      /仅支持 Windows/,
    );
    return;
  }
  const ui = scripted([
    '1',
    f.directory,
    process.execPath,
    join(f.directory, 'worktrees'),
    '../escape',
    'src/value.ts,test/value.test.ts',
    process.execPath,
    'node --test; echo unsafe',
    '["--test"]',
    '0',
    '8',
    '3600',
    'yes',
  ]);
  const settings = await configure(ui.io, join(f.directory, 'chat'));
  assert.deepEqual(settings.config.allowedFiles, [
    'src/value.ts',
    'test/value.test.ts',
  ]);
  assert.deepEqual(settings.config.verification!.commands[0]!.args, ['--test']);
  assert.equal(settings.config.budget.maxRuns, 8);
  assert.equal(settings.config.github, undefined);
  assert.ok(ui.output.filter((s) => s.includes('输入不符合要求')).length >= 3);
  assert.equal(
    existsSync(join(f.directory, 'chat', 'chat.json')),
    false,
    'configuration alone does not persist or start a service',
  );
});

test('conflicting modes and corrupt saved settings do not silently start a different executor', async (t) => {
  const f = fixture(t),
    directory = join(f.directory, 'chat');
  await assert.rejects(
    chat({ directory, demo: true, runtime: 'missing' }, scripted([]).io),
    /不能与/,
  );
  assert.equal(existsSync(join(directory, 'connection.json')), false);
  writeFileSync(join(directory, 'chat.json'), '{bad');
  await assert.rejects(chat({ directory, demo: true }, scripted([]).io));
  assert.equal(readFileSync(join(directory, 'chat.json'), 'utf8'), '{bad');
  assert.equal(existsSync(join(directory, 'connection.json')), false);
  assert.ok(!terminalText('\x1b[31mtext\x1b]2;title\x07\r').includes('\x1b'));
  assert.ok(!terminalText('\x1b]2;title\x07').includes('\x07'));
});

test('chat refuses a pre-existing management database instead of scheduling its unrelated tasks', async (t) => {
  const f = fixture(t);
  const task = f.tasks.create(request());
  await assert.rejects(
    chat({ directory: f.directory, demo: true }, scripted(['new task']).io),
    /不能自动接管/,
  );
  assert.equal(f.tasks.get(task.id).status, 'queued');
  assert.equal(f.tasks.get(task.id).runsUsed, 0);
  assert.equal(existsSync(join(f.directory, 'chat.json')), false);
});

test('exit during service startup cannot launch a queued model invocation', async (t) => {
  const f = fixture(t);
  const task = f.tasks.create({ ...request(), repo: f.directory });
  saveSettings(f.directory, {
    schemaVersion: 1,
    repo: f.directory,
    config: task.config,
    lastTaskId: task.id,
  });
  const ui = scripted([]);
  ui.io.write = () => {
    queueMicrotask(() => ui.control.abort());
  };
  assert.equal(await chat({ directory: f.directory }, ui.io), 130);
  assert.equal(f.tasks.get(task.id).status, 'queued');
  assert.equal(f.tasks.get(task.id).runsUsed, 0);
  assert.equal(new Runs(f.tasks).outstanding().length, 0);
  assert.equal(loadSettings(f.directory)!.lastTaskId, task.id);
});

test('exit while recovery yields cannot claim a new run after the initial cancellation check', async (t) => {
  const f = fixture(t),
    task = f.tasks.create(request());
  const signal = new AbortController();
  const controller = new Controller(
    f.tasks,
    new Evidence(f.tasks, join(f.directory, 'evidence')),
    new FakeExecutor(),
    undefined,
    signal.signal,
  );
  t.after(() => controller.close());
  const ticking = controller.tick();
  signal.abort();
  await ticking;
  assert.equal(f.tasks.get(task.id).runsUsed, 0);
  assert.equal(new Runs(f.tasks).outstanding().length, 0);
});

test('accepted development results display the answer or candidate without publishing', async (t) => {
  const f = fixture(t),
    task = f.tasks.create(request());
  const sha = 'a'.repeat(40);
  for (const result of [
    {
      stage: 'answer',
      conclusion: 'Answer with evidence',
      sources: [{ path: 'src/value.ts', line: 1, excerpt: 'value' }],
      limitations: ['Scoped answer'],
    },
    {
      stage: 'implement',
      summary: 'Fixed the value',
      baseRevision: 'b'.repeat(40),
      resultRevision: sha,
      changedFiles: ['src/value.ts'],
      unresolved: [],
    },
  ]) {
    const ui = scripted(['Task']);
    const calls: string[] = [];
    assert.equal(
      await converse(
        async (path) => {
          calls.push(path);
          if (path === '/v1/tasks') return { task };
          return {
            task: {
              ...task,
              kind: 'development',
              codeRevision: sha,
              stage: result.stage === 'answer' ? 'answer' : 'deliver',
              status: 'succeeded',
            },
            accepted: true,
            artifacts: [],
            evidenceIssues: [],
            handoffs: [{ result }],
            workspaces:
              result.stage === 'implement'
                ? [
                    {
                      kind: 'implementation',
                      path: f.directory,
                      branch: 'codex/fixture',
                    },
                  ]
                : [],
          };
        },
        ui.io,
        { schemaVersion: 1, repo: f.directory, config: defaultConfig() },
        () => {},
      ),
      0,
    );
    const output = ui.output.join('\n');
    assert.match(output, /本地任务已通过验收/);
    assert.match(
      output,
      result.stage === 'answer'
        ? /Answer with evidence[\s\S]*src\/value.ts:1[\s\S]*Scoped answer/
        : /Fixed the value[\s\S]*候选提交[\s\S]*成果工作树/,
    );
    assert.deepEqual(calls, ['/v1/tasks', `/v1/tasks/${task.id}`]);
  }
});

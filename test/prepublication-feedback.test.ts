import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFixture } from './github-helpers.ts';
import { GitHubWorkflow } from '../src/github/workflow.ts';
import type { LocalWorkflow } from '../src/workflow/local.ts';
test('trusted prepublication finding invalidates acceptance and requires independent resolution without publishing', async (t) => {
  const f = await deliveryFixture(t);
  f.db.sql
    .prepare(
      "UPDATE tasks SET document=json_set(document,'$.config.allowedFiles',json('[\"value.txt\"]')) WHERE id=?",
    )
    .run(f.task.id);
  let effects = 0;
  const local = {
    async acceptance() {
      return [];
    },
    workspaces: {
      list() {
        return [{ kind: 'implementation', path: 'fixture' }];
      },
    },
  } as unknown as LocalWorkflow;
  const workflow = new GitHubWorkflow(
    f.deliveries,
    {
      async send() {
        effects++;
      },
      async stop() {
        return 'stopped';
      },
    },
    local,
  );
  const command = {
    schemaVersion: 1,
    expectedVersion: f.task.version,
    action: 'feedback',
    feedback: {
      kind: 'implementation',
      requirementVersion: 1,
      revision: f.task.codeRevision,
      files: ['value.txt'],
      text: 'Actual operator finding: documented option is rejected by the CLI.',
    },
  };
  await assert.rejects(
    workflow.command(f.task.id, {
      ...command,
      feedback: { ...command.feedback, files: ['outside.txt'] },
    }),
    /trusted scope/,
  );
  await workflow.command(f.task.id, command);
  const next = f.tasks.get(f.task.id),
    decision = f.tasks.decisions(next.id)[0]!;
  assert.equal(next.status, 'queued');
  assert.equal(next.stage, 'implement');
  assert.equal(next.requirementVersion, 1);
  assert.equal(next.runsUsed, f.task.runsUsed);
  assert.equal(next.deadlineAt, f.task.deadlineAt);
  assert.equal(next.iterationsUsed, 1);
  assert.equal(decision.source, 'local-user');
  assert.match(decision.obligation!.id, /^G-/);
  assert.ok(decision.obligation!.sourceKey.includes(f.task.codeRevision!));
  assert.equal(f.deliveries.get(next.id), null);
  assert.equal(effects, 0);
  await assert.rejects(workflow.command(next.id, command), /version changed/);
});
test('prepublication feedback cannot reopen an already prepared delivery', async (t) => {
  const f = await deliveryFixture(t);
  f.deliveries.prepare(f.task, 'a'.repeat(40));
  const workflow = new GitHubWorkflow(
    f.deliveries,
    {
      async send() {},
      async stop() {
        return 'stopped';
      },
    },
    {} as LocalWorkflow,
  );
  await assert.rejects(
    workflow.command(f.task.id, {
      schemaVersion: 1,
      expectedVersion: f.task.version,
      action: 'feedback',
      feedback: {
        kind: 'implementation',
        requirementVersion: 1,
        revision: f.task.codeRevision,
        files: ['value.txt'],
        text: 'finding',
      },
    }),
    /prepublication feedback/,
  );
});

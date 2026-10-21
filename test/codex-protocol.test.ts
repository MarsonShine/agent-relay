import assert from 'node:assert/strict';
import test from 'node:test';
import { codexFixture } from './codex-helpers.ts';
import {
  bindReference,
  sessionFor,
  invocation,
  prompt,
  finalSchema,
  parseFinal,
  finalJsonSchema,
  jsonSchemaFor,
} from '../src/adapters/codex/protocol.ts';
import {
  codexEnvironment,
  permissionArguments,
} from '../src/adapters/codex/config.ts';
import { configSchema } from '../src/core/config.ts';
import { testedCodexVersion } from '../src/adapters/codex/events.ts';

test('Codex policy keeps native Windows isolation and forbids read-only escalation', () => {
  const read = permissionArguments('read-only', 'win32');
  assert.ok(read.includes('windows.sandbox="elevated"'));
  assert.ok(
    read.some(
      (arg) =>
        arg.includes('sandbox_approval=false') &&
        arg.includes('request_permissions=false'),
    ),
  );
  assert.ok(
    !read.includes('--ignore-rules') &&
      !read.includes('--dangerously-bypass-approvals-and-sandbox'),
  );
  assert.ok(
    !permissionArguments('read-only', 'linux').some((arg) =>
      arg.includes('windows.sandbox'),
    ),
  );
  const env = codexEnvironment({
    PATH: 'synthetic',
    CODEX_PERMISSION_PROFILE: 'inherited',
    CODEX_API_KEY: 'do-not-forward',
    GH_TOKEN: 'do-not-forward',
    CODEX_APP_TOOLS_PIPE_PATH: 'do-not-forward',
    CODEX_MCP_NODE_PATH: 'do-not-forward',
    OPENAI_API_KEY: 'do-not-forward',
    NODE_OPTIONS: 'do-not-forward',
  });
  assert.deepEqual(env, {
    PATH: 'synthetic',
    CODEX_PERMISSION_PROFILE: 'inherited',
  });
});

test('native session reference is bound to task, role, model and canonical workspace', (t) => {
  const { execution, workspace, next } = codexFixture(t);
  const id = '00000000-0000-4000-8000-000000000001';
  const reference = bindReference(
    JSON.stringify({
      schemaVersion: 1,
      backend: 'codex-cli',
      version: testedCodexVersion,
      session: id,
    }),
    execution,
    workspace,
  );
  assert.equal(sessionFor(reference, next(), workspace), id);
  assert.throws(
    () =>
      sessionFor(
        reference,
        {
          ...execution,
          task: {
            ...execution.task,
            id: '00000000-0000-4000-8000-000000000002',
          },
        },
        workspace,
      ),
    /different/,
  );
  assert.throws(
    () => sessionFor(reference, execution, workspace + '-other'),
    /different/,
  );
  assert.throws(
    () =>
      sessionFor(
        reference,
        {
          ...execution,
          run: {
            ...execution.run,
            profile: execution.task.config.profiles.review,
          },
        },
        workspace,
      ),
    /different/,
  );
  assert.throws(() => sessionFor('--last', execution, workspace));
  const args = invocation(
    execution,
    workspace,
    'schema.json',
    'final.json',
    reference,
    'win32',
  );
  assert.ok(args.indexOf('-s') < args.indexOf('resume'));
  assert.ok(args.includes(id));
  assert.ok(!args.includes('--last'));
  const text = 'task text with "quotes"; $(not-a-command)';
  const changed = { ...execution, task: { ...execution.task, input: text } };
  assert.ok(
    !invocation(changed, workspace, 'schema.json', 'final.json').includes(text),
  );
  const body = JSON.parse(prompt(changed).split('\n').at(-1)!);
  assert.equal(body.input, text);
  assert.deepEqual(body.resultSchema, finalJsonSchema);
});

test('role configuration and final output reject unsupported and unknown settings', (t) => {
  const { execution } = codexFixture(t);
  const config = structuredClone(execution.task.config);
  assert.equal(configSchema.safeParse(config).success, true);
  Object.assign(config.profiles.review, { permission: 'workspace-write' });
  assert.equal(configSchema.safeParse(config).success, false);
  const final = {
    schemaVersion: 1,
    status: 'completed',
    evidence: execution.run.evidence,
    output: 'result',
    question: null,
    diagnostic: null,
  };
  assert.equal(finalSchema.safeParse(final).success, true);
  assert.equal(
    finalSchema.safeParse({ ...final, permission: 'workspace-write' }).success,
    false,
  );
});

test('development output is a current-stage object, independent of the design role name', (t) => {
  const { execution } = codexFixture(t);
  const request = {
    ...execution,
    handoff: {
      contractVersion: 'M2-handoff-v1' as const,
      resultSchema: {},
      history: [],
    },
  };
  const base = {
    schemaVersion: 1,
    status: 'completed',
    evidence: execution.run.evidence,
    question: null,
    diagnostic: null,
  };
  const output = {
    stage: 'triage',
    kind: 'consultation',
    goal: 'explain',
    nonGoals: [],
    acceptance: [{ id: 'A1', description: 'cite source' }],
    scope: [],
    simpleReason: null,
  };
  const triagePrompt = JSON.parse(prompt(request).split('\n').at(-1)!);
  assert.match(triagePrompt.invocationGoal, /read-only triage only/);
  assert.match(
    triagePrompt.invocationGoal,
    /Do not implement or commit in triage/,
  );
  assert.match(
    triagePrompt.invocationGoal,
    /separate later implementation invocation/,
  );
  assert.equal(
    JSON.parse(parseFinal(request, { ...base, output }).output!).stage,
    'triage',
  );
  assert.throws(() =>
    parseFinal(request, { ...base, output: JSON.stringify(output) }),
  );
  assert.throws(() =>
    parseFinal(request, { ...base, output: { ...output, stage: 'design' } }),
  );
});

test('native implementation handoff distinguishes unfinished work from retained review claims without rewriting results', (t) => {
  const { execution } = codexFixture(t),
    revision = 'a'.repeat(40);
  const request = {
    ...execution,
    task: { ...execution.task, stage: 'implement' as const },
    handoff: {
      contractVersion: 'M2-handoff-v1' as const,
      implementationBaseRevision: revision,
      resultSchema: {},
      history: [],
      pendingFindings: [
        {
          id: 'U-retained',
          origin: 'implementation' as const,
          description: 'awaiting independent resolution',
          runId: execution.run.id,
        },
      ],
    },
  };
  const body = JSON.parse(prompt(request).split('\n').at(-1)!);
  assert.equal(body.handoff.pendingFindings[0].id, 'U-retained');
  assert.match(body.outputInstructions, /stable U-\* claims/);
  assert.match(body.outputInstructions, /unfinished IMPLEMENTATION WORK only/);
  assert.match(
    body.outputInstructions,
    /exception also applies when input evidence equals implementationBaseRevision/,
  );
  assert.match(body.outputInstructions, /raw-byte-preserving/);
  assert.ok(
    !body.outputInstructions.includes('Otherwise create a clean commit'),
  );
  assert.match(
    JSON.stringify(jsonSchemaFor(request)),
    /Unfinished implementation work only/,
  );
  const output = {
    stage: 'implement',
    baseRevision: revision,
    resultRevision: revision,
    summary: 'dispute',
    changedFiles: [],
    responses: [
      {
        findingId: 'U-retained',
        disposition: 'disputed',
        proof: 'actual repository evidence',
      },
    ],
    unresolved: ['actual unfinished work'],
  };
  const parsed = parseFinal(request, {
    schemaVersion: 1,
    status: 'completed',
    evidence: execution.run.evidence,
    output,
    question: null,
    diagnostic: null,
  });
  assert.deepEqual(JSON.parse(parsed.output!).unresolved, [
    'actual unfinished work',
  ]);
});

test('source evidence schema and prompt state the existing exact physical-line contract', (t) => {
  const { execution } = codexFixture(t);
  const request = {
    ...execution,
    task: { ...execution.task, stage: 'design' as const },
    handoff: {
      contractVersion: 'M2-handoff-v1' as const,
      resultSchema: {},
      history: [],
    },
  };
  const schema = JSON.stringify(jsonSchemaFor(request));
  assert.match(schema, /One-based physical line number/);
  assert.match(schema, /Verbatim substring of that exact single line/);
  const body = JSON.parse(prompt(request).split('\n').at(-1)!);
  assert.match(
    body.sourceEvidenceInstructions,
    /including blank lines and headings/,
  );
  assert.match(body.sourceEvidenceInstructions, /Do not estimate line numbers/);
});

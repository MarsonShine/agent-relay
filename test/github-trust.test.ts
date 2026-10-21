import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubError, seconds } from '../src/github/transport.ts';
import { GitHubApi } from '../src/github/api.ts';
import { codeFailures } from '../src/github/diagnostics.ts';
import { policy } from './github-helpers.ts';
test('permission refusal and malformed limits never become transient or NaN schedules', () => {
  const variants: Record<string, string>[] = [
    {},
    { 'retry-after': 'NaN' },
    { 'retry-after': 'Infinity' },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'bad' },
  ];
  for (const headers of variants) {
    const error = new GitHubError({ status: 403, headers, body: {} });
    assert.equal(error.rateLimited, false);
    assert.ok(Number.isFinite(error.retryAt));
  }
  assert.equal(
    new GitHubError({
      status: 403,
      headers: { 'retry-after': '120' },
      body: {},
    }).rateLimited,
    true,
  );
  assert.equal(seconds('-1'), null);
  assert.equal(seconds('1e999'), null);
});
test('only a current trusted project-step failure after successful setup authorizes code repair', async () => {
  let setup = 'success';
  const api = new GitHubApi(
    {
      async request() {
        return {
          status: 200,
          headers: {},
          body: {
            head_sha: 'b'.repeat(40),
            check_run_url:
              'https://api.github.com/repos/owner/project/check-runs/1',
            name: 'check',
            steps: [
              { name: 'setup', number: 1, conclusion: setup },
              { name: 'Run npm run check', number: 2, conclusion: 'failure' },
            ],
          },
        };
      },
    },
    {
      ...policy,
      requiredChecks: [
        { ...policy.requiredChecks[0]!, codeStep: 'Run npm run check' },
      ],
    },
  );
  const check = {
    id: 1,
    name: 'check',
    head_sha: 'b'.repeat(40),
    conclusion: 'failure',
    app: { id: 30 },
    details_url: 'https://github.com/owner/project/actions/runs/1/job/2',
  };
  assert.deepEqual(await codeFailures(api, [check], 'b'.repeat(40)), [1]);
  setup = 'failure';
  assert.deepEqual(await codeFailures(api, [check], 'b'.repeat(40)), []);
  assert.deepEqual(
    await codeFailures(
      api,
      [{ ...check, details_url: 'https://evil.invalid/job/2' }],
      'b'.repeat(40),
    ),
    [],
  );
});

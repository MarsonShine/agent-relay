import type { TestContext } from 'node:test';
import { fixture, request } from './helpers.ts';
import { githubPolicySchema } from '../src/github/contracts.ts';
import { Sources } from '../src/github/source.ts';
import { Deliveries } from '../src/github/delivery-store.ts';
import type { Transport } from '../src/github/transport.ts';
export const policy = githubPolicySchema.parse({
  repository: 'owner/project',
  repositoryId: 10,
  base: 'main',
  publish: true,
  feedback: [
    {
      id: 20,
      login: 'owner',
      scopes: ['requirement', 'implementation', 'design'],
    },
  ],
  requiredChecks: [{ name: 'check', appId: 30 }],
  pollIntervalMs: 1000,
  maxPolls: 10,
  maxPages: 3,
});
export async function deliveryFixture(t: TestContext) {
  const f = fixture(t);
  const transport: Transport = {
    async request(path) {
      return {
        status: 200,
        headers: {},
        body: path.endsWith('/issues/1')
          ? {
              id: 2,
              number: 1,
              title: 'Useful task',
              body: 'bounded change',
              updated_at: '2026-01-01T00:00:00Z',
              state: 'open',
            }
          : { id: 10, full_name: 'owner/project', archived: false },
      };
    },
  };
  let task = await new Sources(f.tasks, transport).import(
    { schemaVersion: 1, issue: 1, requestKey: 'import' },
    'fixture',
    'a'.repeat(40),
    { ...request().config, github: policy },
  );
  task = f.db.transaction(() =>
    f.tasks.save(task, { ...task, status: 'running' }),
  );
  task = f.db.transaction(() =>
    f.tasks.save(task, {
      ...task,
      stage: 'deliver',
      status: 'succeeded',
      codeRevision: 'b'.repeat(40),
    }),
  );
  return {
    ...f,
    task,
    transport,
    deliveries: new Deliveries(f.tasks, transport),
  };
}

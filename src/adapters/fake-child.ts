import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fakeNativeSchema } from './fake-config.ts';
import { evidenceSchema } from '../core/contracts.ts';

const inputSchema = z.strictObject({
  native: fakeNativeSchema,
  evidence: evidenceSchema,
  answered: z.boolean(),
});
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = inputSchema.parse(
  JSON.parse(Buffer.concat(chunks).toString('utf8')),
);
const emit = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (key: string, type: string, message: string) =>
  emit({ schemaVersion: 1, key, type, message });
event('start', 'started', 'simulation started');
if (input.native.scenario === 'slow') {
  setInterval(() => {}, 1_000);
} else {
  setTimeout(() => {
    const scenario = input.native.scenario;
    if (scenario === 'missing-terminal') return;
    if (scenario === 'duplicate') {
      event('progress', 'progress', 'simulation progress');
      event('progress', 'progress', 'simulation progress');
    }
    const status =
      scenario === 'failure'
        ? 'failed'
        : scenario === 'input' && !input.answered
          ? 'input_required'
          : 'completed';
    event('terminal', status, `simulation ${status}`);
    emit({
      result: {
        schemaVersion: 1,
        status,
        stopped: true,
        evidence: input.evidence,
        output:
          status === 'completed'
            ? 'Simulation completed. No repository changes or model execution were performed.'
            : null,
        question:
          status === 'input_required'
            ? {
                id: randomUUID(),
                version: input.evidence.requirementVersion,
                text: 'Provide a simulation scope decision.',
              }
            : null,
        continuation: null,
        diagnostic: status === 'failed' ? 'injected execution failure' : null,
        usage: null,
      },
    });
    if (status === 'failed') process.exitCode = 1;
  }, input.native.delayMs);
}

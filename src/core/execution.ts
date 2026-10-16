import { z } from 'zod';
import { evidenceSchema, questionSchema } from './contracts.ts';
import type { Run, Task } from './contracts.ts';

export const agentEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  key: z.string().min(1).max(128),
  type: z.enum([
    'started',
    'progress',
    'artifact',
    'usage',
    'input_required',
    'completed',
    'failed',
    'cancelled',
  ]),
  message: z.string().max(8_192),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;
export const resultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum([
    'completed',
    'failed',
    'input_required',
    'cancelled',
    'unknown',
  ]),
  stopped: z.boolean(),
  evidence: evidenceSchema,
  output: z.string().max(262_144).nullable(),
  question: questionSchema.nullable(),
  continuation: z.string().max(4_096).nullable(),
  diagnostic: z.string().max(8_192).nullable(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type ExecutionResult = z.infer<typeof resultSchema>;
export interface ExecutionRequest {
  task: Task;
  run: Run;
}
export interface ExecutionHandle {
  events: AsyncIterable<AgentEvent>;
  result: Promise<ExecutionResult>;
}
export interface Executor {
  readonly id: string;
  readonly version: string;
  readonly capabilities: {
    continuation: boolean;
    cancellation: boolean;
    permissions: readonly string[];
    structuredOutput: boolean;
    usage: boolean;
  };
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  continue(
    request: ExecutionRequest,
    reference: string,
  ): Promise<ExecutionHandle>;
  cancel(run: Run): Promise<'stopped' | 'unknown'>;
  reconcile(run: Run): Promise<'active' | 'stopped' | 'unknown'>;
}

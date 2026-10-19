import { z } from 'zod';
import {
  evidenceSchema,
  questionSchema,
  taskSchema,
  runSchema,
  artifactSchema,
  decisionSchema,
} from './contracts.ts';
import type { Run } from './contracts.ts';

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
export const executionRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    task: taskSchema,
    workspace: z
      .strictObject({
        path: z.string().min(1),
        kind: z.enum(['repository', 'worktree']),
      })
      .optional(),
    run: runSchema,
    artifacts: z.array(artifactSchema).max(200),
    decisions: z.array(decisionSchema).max(100),
  })
  .superRefine((request, context) => {
    const evidenceMatches = (evidence: z.infer<typeof evidenceSchema>) =>
      evidence.requirementVersion === request.task.requirementVersion &&
      evidence.codeRevision === request.task.codeRevision;
    if (
      request.run.taskId !== request.task.id ||
      !evidenceMatches(request.run.evidence) ||
      request.artifacts.some(
        (artifact) =>
          artifact.taskId !== request.task.id ||
          !evidenceMatches(artifact.evidence),
      ) ||
      request.decisions.some(
        (decision) =>
          decision.taskId !== request.task.id ||
          decision.requirementVersion > request.task.requirementVersion,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'handoff does not match task and evidence version',
      });
    }
  });
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
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

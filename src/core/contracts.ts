import { z } from 'zod';
import { configSchema, profileSchema } from './config.ts';

export const idSchema = z.uuid();
export const versionSchema = z.number().int().positive();
export const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{40,64}$/)
  .nullable();
const envelope = { schemaVersion: z.literal(1) };
export const evidenceSchema = z.strictObject({
  requirementVersion: versionSchema,
  codeRevision: revisionSchema,
});
export const statusSchema = z.enum([
  'queued',
  'running',
  'waiting_user',
  'paused',
  'recovering',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
]);
export type Status = z.infer<typeof statusSchema>;
export const stageSchema = z.enum([
  'triage',
  'design',
  'design_review',
  'implement',
  'verify',
  'code_review',
  'answer',
  'deliver',
]);
export const questionSchema = z.strictObject({
  id: idSchema,
  version: versionSchema,
  text: z.string().min(1).max(8_192),
});
export const taskSchema = z.strictObject({
  ...envelope,
  id: idSchema,
  kind: z.enum(['simulation', 'development']),
  repo: z.string().min(1),
  input: z.string().min(1).max(32_768),
  requirementVersion: versionSchema,
  codeRevision: revisionSchema,
  stage: stageSchema,
  status: statusSchema,
  version: versionSchema,
  config: configSchema,
  runsUsed: z.number().int().nonnegative(),
  iterationsUsed: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().positive(),
  control: z.enum(['pause', 'cancel']).nullable(),
  question: questionSchema.nullable(),
  diagnostic: z.string().max(8_192).nullable(),
});
export type Task = z.infer<typeof taskSchema>;
export const runSchema = z.strictObject({
  ...envelope,
  id: idSchema,
  taskId: idSchema,
  attempt: versionSchema,
  profile: profileSchema,
  executorVersion: z.string().min(1),
  evidence: evidenceSchema,
  status: z.enum(['active', 'unknown', 'stopped']),
  owner: idSchema,
  leaseUntil: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  continuation: z.string().max(4_096).nullable(),
  outcome: z.string().max(128).nullable(),
});
export type Run = z.infer<typeof runSchema>;
export const eventSchema = z.strictObject({
  ...envelope,
  sequence: versionSchema,
  taskId: idSchema,
  runId: idSchema.nullable(),
  key: z.string().min(1).max(256),
  type: z.string().min(1).max(128),
  at: z.number().int().nonnegative(),
  payload: z.string().max(8_192),
});
export type Event = z.infer<typeof eventSchema>;
export const artifactSchema = z.strictObject({
  ...envelope,
  id: idSchema,
  taskId: idSchema,
  runId: idSchema,
  kind: z.enum(['result', 'log']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  evidence: evidenceSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;
export const findingSchema = z
  .strictObject({
    ...envelope,
    id: idSchema,
    taskId: idSchema,
    runId: idSchema,
    evidence: evidenceSchema,
    stage: stageSchema,
    severity: z.enum(['blocking', 'advisory']),
    status: z.enum(['open', 'disputed', 'resolved']),
    description: z.string().min(1).max(8_192),
    proof: z.string().min(1).max(8_192),
    verification: z.string().min(1).max(8_192).nullable(),
  })
  .refine(
    (value) => value.status !== 'resolved' || value.verification !== null,
    'resolved findings require verification',
  );
export type Finding = z.infer<typeof findingSchema>;
export const decisionSchema = z.strictObject({
  ...envelope,
  id: idSchema,
  taskId: idSchema,
  question: questionSchema,
  answer: z.string().min(1).max(32_768),
  source: z.literal('local-user'),
  requirementVersion: versionSchema,
});
export type Decision = z.infer<typeof decisionSchema>;
export const createTaskSchema = z.strictObject({
  kind: z.enum(['simulation', 'development']).optional(),
  schemaVersion: z.literal(1),
  requestKey: z.string().min(1).max(128),
  repo: z.string().min(1),
  input: z.string().min(1).max(32_768),
  codeRevision: revisionSchema,
  config: configSchema,
});
export type CreateTask = z.infer<typeof createTaskSchema>;
export const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum(['pause', 'resume', 'cancel']),
    expectedVersion: versionSchema,
  }),
  z.strictObject({
    action: z.literal('answer'),
    expectedVersion: versionSchema,
    questionId: idSchema,
    questionVersion: versionSchema,
    answer: z.string().min(1).max(32_768),
  }),
]);
export type Command = z.infer<typeof commandSchema>;

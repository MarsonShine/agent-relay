import { z } from 'zod';
import { evidenceSchema } from './contracts.ts';
const text = z.string().trim().min(1).max(8192);
export const relativeFile = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.startsWith('/') &&
      !p.includes(':') &&
      p.split('/').every((s) => s !== '..' && s !== '.' && s !== ''),
    'expected repository-relative file',
  );
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const source = z.strictObject({
  path: relativeFile,
  line: z.number().int().positive(),
  excerpt: text,
});
export const handoffSchema = z.discriminatedUnion('stage', [
  z.strictObject({
    stage: z.literal('triage'),
    kind: z.enum(['consultation', 'change']),
    goal: text,
    nonGoals: z.array(text).max(30),
    acceptance: z
      .array(z.strictObject({ id: text, description: text }))
      .min(1)
      .max(30),
    scope: z.array(relativeFile).max(100),
    simpleReason: text.nullable(),
  }),
  z.strictObject({
    stage: z.literal('design'),
    summary: text,
    evidence: z.array(source).min(1).max(30),
    rootCause: text,
    invariant: text,
    fixLayer: text,
    steps: z.array(text).min(1).max(30),
    validationPlan: z.array(text).min(1).max(30),
  }),
  z.strictObject({
    stage: z.literal('implement'),
    summary: text,
    baseRevision: sha,
    resultRevision: sha,
    changedFiles: z.array(relativeFile).min(1).max(100),
    unresolved: z.array(text).max(30),
  }),
  z.strictObject({
    stage: z.enum(['design_review', 'code_review']),
    subjectRunId: z.uuid(),
    verdict: z.enum(['approve', 'revise']),
    coverage: z
      .array(z.strictObject({ criterionId: text, proof: text }))
      .max(30),
    findings: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          severity: z.enum(['blocking', 'advisory']),
          origin: z.enum(['design', 'implementation']),
          location: text,
          trigger: text,
          proof: text,
          impact: text,
        }),
      )
      .max(50),
  }),
  z.strictObject({
    stage: z.literal('answer'),
    conclusion: text,
    sources: z.array(source).min(1).max(30),
    limitations: z.array(text).max(30),
  }),
]);
export type Handoff = z.infer<typeof handoffSchema>;
export const handoffRecordSchema = z.strictObject({
  runId: z.uuid(),
  taskId: z.uuid(),
  artifactId: z.uuid(),
  evidence: evidenceSchema,
  result: handoffSchema,
});
export type HandoffRecord = z.infer<typeof handoffRecordSchema>;
export const handoffContextSchema = z.strictObject({
  contractVersion: z.literal('M2-handoff-v1'),
  resultSchema: z.record(z.string(), z.unknown()),
  history: z.array(handoffRecordSchema).max(100),
});

export type Advance = {
  status: 'queued' | 'succeeded' | 'blocked';
  stage: import('./contracts.ts').Task['stage'];
  codeRevision: import('./contracts.ts').Task['codeRevision'];
  iterationsUsed: number;
  diagnostic: string | null;
  persist: () => void;
};

import { z } from 'zod';

const name = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/)
  .max(100);
const branch = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_/-]*$/)
  .max(160);
export const githubPolicySchema = z
  .strictObject({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    repositoryId: z.number().int().positive(),
    base: branch,
    publish: z.boolean(),
    feedback: z
      .array(
        z.strictObject({
          id: z.number().int().positive(),
          login: name,
          scopes: z
            .array(z.enum(['requirement', 'implementation', 'design']))
            .min(1),
        }),
      )
      .max(20),
    requiredChecks: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(200),
          appId: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(20),
    pollIntervalMs: z.number().int().min(1000).max(3600000),
    maxPolls: z.number().int().min(1).max(1000),
    maxPages: z.number().int().min(1).max(100),
  })
  .superRefine((p, c) => {
    if (
      new Set(p.requiredChecks.map((x) => x.name)).size !==
      p.requiredChecks.length
    )
      c.addIssue({
        code: 'custom',
        message: 'required check names must be unique',
      });
  });
export type GitHubPolicy = z.infer<typeof githubPolicySchema>;
export const importSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issue: z.number().int().positive(),
  requestKey: z.string().min(1).max(128),
});
export const sourceSchema = z.strictObject({
  taskId: z.uuid(),
  requestKey: z.string(),
  policy: githubPolicySchema,
  issue: z.number().int().positive(),
  issueId: z.number().int().positive(),
  sourceVersion: z.string(),
  title: z.string().max(1000),
  body: z.string().max(30000),
  updatedAt: z.string(),
  url: z.string().url(),
});
export type IssueSource = z.infer<typeof sourceSchema>;

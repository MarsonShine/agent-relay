import { z } from 'zod';
import { idSchema, versionSchema } from '../core/contracts.ts';

export const commitSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const workspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  taskId: idSchema,
  kind: z.enum(['implementation', 'review', 'repository']),
  state: z.enum(['creating', 'ready', 'removing', 'removed', 'tainted']),
  repo: z.string().min(1),
  commonDir: z.string().min(1),
  root: z.string().min(1),
  path: z.string().min(1),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  branch: z.string().nullable(),
  baselineRevision: commitSchema,
  revision: commitSchema,
  requirementVersion: versionSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceMode = Workspace['kind'];
export type WorkspaceLease = {
  workspace: Workspace;
  runId: string;
  owner: string;
  token: string;
};

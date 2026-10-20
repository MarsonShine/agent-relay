import { z } from 'zod';
import { isAbsolute } from 'node:path';
export const runtimeSchema = z.strictObject({
  repo: z.string().refine(isAbsolute),
  workspaces: z.string().refine(isAbsolute),
  command: z.strictObject({
    executable: z.string().refine(isAbsolute),
    prefixArgs: z.array(z.string()).max(10).optional(),
  }),
});
export type DevelopmentRuntime = z.infer<typeof runtimeSchema>;

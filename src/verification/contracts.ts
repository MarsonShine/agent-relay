import { z } from 'zod';
import { isAbsolute } from 'node:path';
export const checkSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  version: z.number().int().positive(),
  executable: z
    .string()
    .refine(isAbsolute, 'check executable must be absolute'),
  args: z.array(z.string().max(8192)).max(100),
  cwd: z
    .string()
    .refine(
      (p) =>
        p === '.' ||
        (!isAbsolute(p) &&
          !p.includes('\\') &&
          !p.includes(':') &&
          p.split('/').every((s) => s !== '..' && s !== '.' && s !== '')),
    ),
  timeoutMs: z.number().int().min(100).max(3600000),
});
export const verificationPolicySchema = z
  .strictObject({
    version: z.number().int().positive(),
    commands: z.array(checkSchema).min(1).max(20),
    maxLogBytes: z.number().int().min(1024).max(1048576),
  })
  .refine(
    (p) => new Set(p.commands.map((c) => c.id)).size === p.commands.length,
    'check IDs must be unique',
  );
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;

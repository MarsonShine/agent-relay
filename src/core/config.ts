import { z } from 'zod';
import { verificationPolicySchema } from '../verification/contracts.ts';
import { fakeNativeSchema } from '../adapters/fake-config.ts';
import { codexProfileSchema } from '../adapters/codex/config.ts';

const finiteLimit = (max: number) => z.number().int().positive().max(max);
export const roleSchema = z.enum(['design', 'implement', 'review']);
export const fakeProfileSchema = z.strictObject({
  role: roleSchema,
  executor: z.literal('fake'),
  provider: z.literal('simulation'),
  model: z.literal('simulator-v1'),
  permission: z.literal('read-only'),
  native: fakeNativeSchema,
  timeoutMs: finiteLimit(3_600_000),
});
export const profileSchema = z.union([fakeProfileSchema, codexProfileSchema]);
export const budgetSchema = z.strictObject({
  maxRuns: finiteLimit(100),
  maxTaskMs: finiteLimit(86_400_000),
  maxIterations: z.number().int().min(0).max(10),
});
export const configSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    verification: verificationPolicySchema.optional(),
    profiles: z.strictObject({
      design: profileSchema,
      implement: profileSchema,
      review: profileSchema,
    }),
    budget: budgetSchema,
    leaseMs: z.number().int().min(1_000).max(60_000),
    maxArtifactBytes: finiteLimit(16 * 1024 * 1024),
    maxLogBytes: finiteLimit(16 * 1024 * 1024),
  })
  .superRefine((config, context) => {
    for (const role of roleSchema.options) {
      if (config.profiles[role].role !== role) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', role, 'role'],
          message: 'role must match profile key',
        });
      }
      if (config.profiles[role].timeoutMs > config.budget.maxTaskMs) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', role, 'timeoutMs'],
          message: 'run timeout exceeds task budget',
        });
      }
    }
  });
export type Profile = z.infer<typeof profileSchema>;
export type Config = z.infer<typeof configSchema>;
type FakeProfile = z.infer<typeof fakeProfileSchema>;
export type SimulationConfig = Omit<Config, 'profiles'> & {
  profiles: Record<z.infer<typeof roleSchema>, FakeProfile>;
};
export function defaultConfig(): SimulationConfig {
  const profile = (role: Profile['role']): FakeProfile => ({
    role,
    executor: 'fake',
    provider: 'simulation',
    model: 'simulator-v1',
    permission: 'read-only',
    native: { scenario: 'success', delayMs: 20 },
    timeoutMs: 5_000,
  });
  const profiles = {
    design: profile('design'),
    implement: profile('implement'),
    review: profile('review'),
  };
  const config = configSchema.parse({
    schemaVersion: 1,
    profiles: {
      design: profile('design'),
      implement: profile('implement'),
      review: profile('review'),
    },
    budget: { maxRuns: 4, maxTaskMs: 60_000, maxIterations: 3 },
    leaseMs: 5_000,
    maxArtifactBytes: 262_144,
    maxLogBytes: 262_144,
  });
  return { ...config, profiles };
}

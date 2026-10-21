import { z } from 'zod';

export const fakeNativeSchema = z.strictObject({
  scenario: z.enum([
    'success',
    'failure',
    'missing-terminal',
    'duplicate',
    'input',
    'slow',
    'cancel-race',
  ]),
  delayMs: z.number().int().min(0).max(10_000),
});

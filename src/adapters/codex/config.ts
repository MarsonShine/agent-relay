import { z } from 'zod';

export const codexNativeSchema = z.strictObject({
  reasoningEffort: z.literal('low'),
});
export const codexProfileSchema = z
  .strictObject({
    role: z.enum(['design', 'implement', 'review']),
    executor: z.literal('codex-cli'),
    provider: z.literal('openai'),
    model: z.literal('gpt-6-luna'),
    permission: z.enum(['read-only', 'workspace-write']),
    native: codexNativeSchema,
    timeoutMs: z.number().int().positive().max(3_600_000),
  })
  .refine(
    (profile) =>
      profile.role === 'implement' || profile.permission === 'read-only',
    'design and review must be read-only',
  );
export type CodexProfile = z.infer<typeof codexProfileSchema>;

export function permissionArguments(
  permission: CodexProfile['permission'],
  platform = process.platform,
): string[] {
  return [
    '-s',
    permission,
    '-c',
    permission === 'read-only'
      ? 'approval_policy={granular={sandbox_approval=false,rules=true,mcp_elicitations=false,request_permissions=false,skill_approval=false}}'
      : 'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    ...(platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
  ];
}
export function codexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PSMODULEPATH|LANG|LC_ALL|TERM|CI)$/i.test(
          key,
        ) ||
        (/^CODEX_/.test(key) && key !== 'CODEX_API_KEY'),
    ),
  );
}

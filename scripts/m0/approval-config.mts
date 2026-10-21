export function approvalConfig(mode: string | undefined): { mode: string; args: string[] } {
  if (mode === undefined || mode === 'never') {
    return { mode: 'never', args: ['-c', 'approval_policy="never"'] };
  }
  if (mode === 'auto-review') {
    return { mode, args: ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'] };
  }
  if (mode === 'read-only-review') {
    return { mode, args: ['-c', 'approval_policy={granular={sandbox_approval=false,rules=true,mcp_elicitations=false,request_permissions=false,skill_approval=false}}', '-c', 'approvals_reviewer="auto_review"'] };
  }
  throw new Error('RELAY_M0_APPROVAL must be never, auto-review or read-only-review.');
}

export function nativeSandboxConfig(platform: string): string[] {
  return platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : [];
}

export function probeCallLimit(value: string | undefined): number {
  const limit = value === undefined ? 6 : Number(value);
  if ((value !== undefined && !/^\d+$/.test(value)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new Error('RELAY_M0_CALL_LIMIT must be an integer from 1 to 8; increases require explicit operator authorization.');
  }
  return limit;
}

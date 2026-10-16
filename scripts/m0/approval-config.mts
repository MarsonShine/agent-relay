export function approvalConfig(mode: string | undefined): { mode: string; args: string[] } {
  if (mode === undefined || mode === 'never') {
    return { mode: 'never', args: ['-c', 'approval_policy="never"'] };
  }
  if (mode === 'auto-review') {
    return { mode, args: ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'] };
  }
  throw new Error('RELAY_M0_APPROVAL must be never or auto-review.');
}

const secretAssignment =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi;

// Best-effort export protection, not a substitute for private runtime storage.
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join('[REDACTED]');
  }
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(secretAssignment, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, '[LOCAL_PATH]')
    .replace(/\\\\[^\s"']+/g, '[LOCAL_PATH]')
    .replace(
      /\/(?:home|Users|tmp|var|private|workspace|workspaces|mnt)\/[^\s"']*/g,
      '[LOCAL_PATH]',
    );
}

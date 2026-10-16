export type ErrorCode =
  'invalid' | 'conflict' | 'not_found' | 'storage' | 'unauthorized';
export class RelayError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

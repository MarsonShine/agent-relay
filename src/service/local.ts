import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import { RelayError } from '../core/errors.ts';

export const connectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  port: z.number().int().min(1).max(65535),
});
export function privateDirectory(path: string): string {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new RelayError(
      'invalid',
      'data directory must be private to the current user and not a symlink',
    );
  }
  return directory;
}
export function readToken(directory: string): string {
  const path = join(directory, 'token');
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new RelayError('invalid', 'token file is not private');
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new RelayError('invalid', 'invalid local token');
  return token;
}
export function ensureToken(directory: string): string {
  try {
    writeFileSync(join(directory, 'token'), randomBytes(32).toString('hex'), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readToken(directory);
}
export function connection(
  directory: string,
): z.infer<typeof connectionSchema> | null {
  try {
    return connectionSchema.parse(
      JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function authorize(
  request: IncomingMessage,
  port: number,
  token: string,
): void {
  const expected = `Bearer ${token}`;
  const actual = request.headers.authorization ?? '';
  if (
    request.headers.origin !== undefined ||
    request.headers.host !== `127.0.0.1:${port}` ||
    Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  ) {
    throw new RelayError('unauthorized', 'local authentication required');
  }
}
export async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json')
    throw new RelayError('invalid', 'application/json is required');
  const declared = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(declared) || declared > 131_072)
    throw new RelayError('invalid', 'request body too large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 131_072)
      throw new RelayError('invalid', 'request body too large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RelayError('invalid', 'invalid JSON request');
  }
}

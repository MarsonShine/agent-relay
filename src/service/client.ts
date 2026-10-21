import { connection, readToken } from './local.ts';
import { RelayError } from '../core/errors.ts';
import { z } from 'zod';

export async function callLocal(
  directory: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const endpoint = connection(directory);
  if (!endpoint)
    throw new RelayError(
      'invalid',
      'service is not initialized; run serve first',
    );
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${readToken(directory)}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const value = z
    .object({ schemaVersion: z.literal(1) })
    .passthrough()
    .parse(await response.json());
  if (!response.ok) {
    const error = z
      .strictObject({
        code: z.enum([
          'invalid',
          'conflict',
          'not_found',
          'storage',
          'unauthorized',
        ]),
        message: z.string(),
      })
      .parse(value.error);
    throw new RelayError(error.code, error.message);
  }
  return value;
}

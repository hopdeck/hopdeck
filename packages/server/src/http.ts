import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from './security.ts';

/** An error the API reports as `{ error: { code, message } }`; the UI translates `code`. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, error: ApiError): void {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } });
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads a JSON request body. Requiring application/json also blocks HTML forms
 * on other sites, which cannot send that content type.
 */
export async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new ApiError(415, 'unsupported-media-type', 'expected application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'payload-too-large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid-json');
  }
}

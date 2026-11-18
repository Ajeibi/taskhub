// Operational errors: expected failures we deliberately return to clients.
// Anything else is a bug and is reported as an opaque 500 (details only in logs).
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const unprocessable = (code: string, message: string) => new AppError(422, code, message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);

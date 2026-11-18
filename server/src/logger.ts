import { pino, type Logger } from 'pino';

// Structured JSON logs to stdout: what Kubernetes log collectors expect.
// Pretty-printing only in development, and never leaking credentials.
export function createLogger(level: string, nodeEnv: string): Logger {
  return pino({
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password'],
    ...(nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

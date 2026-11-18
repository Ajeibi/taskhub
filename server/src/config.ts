import { z } from 'zod';

// All configuration comes from environment variables (12-factor): the same image runs in
// every environment and Kubernetes injects values via ConfigMap/Secret. We validate at
// startup so a misconfigured pod fails fast instead of failing on the first request.
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  // Secret used to sign access tokens. Must be long and random; supplied via a Kubernetes Secret.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900), // 15 minutes
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  // Refresh cookie 'Secure' flag. Defaults to on in production (HTTPS), off for local http.
  COOKIE_SECURE: bool.optional(),
  // Max login/register attempts per IP per 15 minutes.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
});

export type Config = Omit<z.infer<typeof schema>, 'COOKIE_SECURE'> & { COOKIE_SECURE: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const c = parsed.data;
  return { ...c, COOKIE_SECURE: c.COOKIE_SECURE ?? c.NODE_ENV === 'production' };
}

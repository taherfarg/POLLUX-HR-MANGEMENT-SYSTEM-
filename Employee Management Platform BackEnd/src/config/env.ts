import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once, at boot. An invalid or missing value fails the
 * process immediately with a readable message rather than surfacing as a
 * confusing runtime error on the first request that happens to need it.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().max(90).default(7),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173'),

  SEED_DEMO_PASSWORD: z.string().min(8).default('Passw0rd!23'),

  /**
   * Optional Google AI Studio key. When set, approved document requests get
   * their letter drafted by Gemini; when absent the deterministic templates are
   * used instead. The platform is fully functional either way, so the demo needs
   * no API key.
   *
   * An empty value is normalised to undefined rather than rejected: .env.example
   * ships the key blank, and a fresh copy of it must not stop the app booting.
   */
  GOOGLE_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().default(300),

  /**
   * How many proxies sit in front of the API, for reading the visitor's IP from
   * X-Forwarded-For: `1` on Render. The office-network check and the rate
   * limiter depend on it; Work locations -> "Add the network I'm on" shows the
   * address it produces, to confirm it is the office's own. A count, never
   * "trust everything": that would let a visitor claim any address.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
});

/**
 * Blank values are treated as unset.
 *
 * Hosting platforms render an untouched variable as `""` rather than omitting
 * it, and Zod only applies a `.default()` to `undefined`. Without this, leaving
 * a field empty in a deploy dashboard sends `""` straight into `.min(8)` and the
 * process dies at boot with a message that reads like a code fault rather than a
 * missing setting.
 */
const withoutBlanks = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ''),
);

const parsed = envSchema.safeParse(withoutBlanks);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console -- the logger depends on this module.
  console.error(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const value = parsed.data;

if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
  console.error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  process.exit(1);
}

// A deployed environment must never run on the placeholder secrets shipped in
// .env.example, so refuse to start instead of being quietly insecure.
if (value.NODE_ENV === 'production') {
  const usesDevSecret = [value.JWT_ACCESS_SECRET, value.JWT_REFRESH_SECRET].some((secret) =>
    secret.startsWith('dev_only_'),
  );
  if (usesDevSecret) {
    console.error('Refusing to start in production with the development JWT secrets.');
    process.exit(1);
  }
}

export const env = {
  ...value,
  isProduction: value.NODE_ENV === 'production',
  isTest: value.NODE_ENV === 'test',
  corsOrigins: value.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export type Env = typeof env;

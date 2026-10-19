import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    API_PORT: z.coerce.number().int().positive().default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),

    DATABASE_URL: z.url(),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().min(1).default('15m'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_REFRESH_EXPIRES_IN: z.string().min(1).default('30d'),

    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasGithubId = Boolean(value.GITHUB_CLIENT_ID);
    const hasGithubSecret = Boolean(value.GITHUB_CLIENT_SECRET);
    if (hasGithubId !== hasGithubSecret) {
      ctx.addIssue({
        code: 'custom',
        message: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must both be set, or both omitted',
        path: ['GITHUB_CLIENT_ID'],
      });
    }

    const hasGoogleId = Boolean(value.GOOGLE_CLIENT_ID);
    const hasGoogleSecret = Boolean(value.GOOGLE_CLIENT_SECRET);
    if (hasGoogleId !== hasGoogleSecret) {
      ctx.addIssue({
        code: 'custom',
        message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set, or both omitted',
        path: ['GOOGLE_CLIENT_ID'],
      });
    }
  });

type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment configuration:\n');
    console.error(z.prettifyError(parsed.error));
    process.exit(1);
  }

  return parsed.data;
}

const env = loadEnv();

export interface AppConfig {
  readonly isDevelopment: boolean;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly server: { readonly port: number; readonly host: string };
  readonly logging: { readonly level: Env['LOG_LEVEL'] };
  readonly database: { readonly url: string };
  readonly jwt: {
    readonly accessSecret: string;
    readonly accessExpiresIn: string;
    readonly refreshSecret: string;
    readonly refreshExpiresIn: string;
  };
  readonly oauth: {
    readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
    readonly google: { readonly clientId: string; readonly clientSecret: string } | null;
  };
}

export const config: AppConfig = {
  isDevelopment: env.NODE_ENV === 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  server: {
    port: env.API_PORT,
    host: env.API_HOST,
  },

  logging: {
    level: env.LOG_LEVEL,
  },

  database: {
    url: env.DATABASE_URL,
  },

  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },

  oauth: {
    github:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : null,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,
  },
};
import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be a number`);
  return parsed;
}

export const env = {
  port: num('PORT', 4000),
  baseUrl: required('PROVIDER_BASE_URL', 'http://localhost:4000').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL', 'postgres://lti:lti@localhost:5433/lti_provider'),

  /** Tool's own RSA keypair. The private key never leaves the backend process. */
  privateKeyPath: required('LTI_PRIVATE_KEY_PATH', './keys/private.pem'),
  publicKeyPath: required('LTI_PUBLIC_KEY_PATH', './keys/public.pem'),
  keyId: required('LTI_KEY_ID', 'provider-key-1'),

  contentSessionSecret: required('CONTENT_SESSION_SECRET', 'change-me-provider-content-session-secret'),
  contentSessionTtlSeconds: num('CONTENT_SESSION_TTL_SECONDS', 14400),

  adminPassword: required('ADMIN_PASSWORD', 'admin123'),

  /** Ceiling for a single uploaded file, enforced while streaming to ./media. */
  maxUploadMb: num('MAX_UPLOAD_MB', 512),

  allowedFrameAncestors: (process.env.ALLOWED_FRAME_ANCESTORS ?? 'http://localhost:4001,http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  viewHeartbeatTimeoutSeconds: num('VIEW_HEARTBEAT_TIMEOUT_SECONDS', 90),
  viewReaperIntervalSeconds: num('VIEW_REAPER_INTERVAL_SECONDS', 30),

  stateTtlSeconds: num('LTI_STATE_TTL_SECONDS', 600),
  nonceTtlSeconds: num('LTI_NONCE_TTL_SECONDS', 600),
  maxTokenAgeSeconds: num('LTI_MAX_TOKEN_AGE_SECONDS', 300),

  isProduction: process.env.NODE_ENV === 'production',
};

/** The tool's own LTI endpoints, derived from the base URL. */
export const toolEndpoints = {
  loginInitiationUrl: `${env.baseUrl}/lti/login`,
  redirectUri: `${env.baseUrl}/lti/launch`,
  jwksUrl: `${env.baseUrl}/.well-known/jwks.json`,
  targetLinkUri: `${env.baseUrl}/lti/launch`,
};

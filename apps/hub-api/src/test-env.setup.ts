// Jest setupFile — runs before any test module is loaded (i.e. before imports execute).
//
// A spec that imports AppModule (e.g. openapi.spec.ts) triggers ConfigModule.forRoot({ validate:
// validateEnv }) at import time, and validateEnv is FAIL-CLOSED: it requires DATABASE_URL, REDIS_URL,
// JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and SECRETS_ENCRYPTION_KEY. On a dev machine these often happen
// to be exported already, so the spec passed locally — but a clean CI runner has none of them, so the
// AppModule import threw ("Invalid environment configuration") and every AppModule-importing spec failed.
//
// Provide deterministic, test-safe defaults for exactly those keys, using `??=` so a real value already
// set by the environment (CI service containers set DATABASE_URL/REDIS_URL) is never overridden — only
// the gaps are filled. NODE_ENV=test also keeps validateEnv lenient about HUB_SIGNING_KEY.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://tugra:tugra@localhost:5432/tugra?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.JWT_ACCESS_SECRET ??= "test-jwt-access-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-jwt-refresh-secret-0123456789";
process.env.SECRETS_ENCRYPTION_KEY ??= "test-secrets-encryption-key-0123456789";

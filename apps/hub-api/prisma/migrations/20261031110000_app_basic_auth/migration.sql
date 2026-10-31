-- HTTP Basic Auth users [{user, hash}] (bcrypt htpasswd hash; plaintext never stored). Null = no basic auth.
ALTER TABLE "Application" ADD COLUMN "basicAuthUsers" JSONB;

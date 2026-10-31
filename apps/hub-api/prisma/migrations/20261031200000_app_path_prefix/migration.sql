-- Path-prefix routing for applications: serve an app under <domain>/<pathPrefix> (Traefik PathPrefix rule),
-- with stripPrefix (default true) removing the prefix before the request reaches the backend. Additive,
-- nullable/defaulted, safe on existing rows: a NULL pathPrefix means the app answers at the host root
-- exactly as before (byte-identical routing).
ALTER TABLE "Application" ADD COLUMN "pathPrefix" TEXT;
ALTER TABLE "Application" ADD COLUMN "stripPrefix" BOOLEAN NOT NULL DEFAULT true;

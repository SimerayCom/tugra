import { isDatastoreRef, looksLikeDatastore } from "./datastore-guard";

describe("datastore guard", () => {
  it("matches the known datastore images, with registry/tag/digest/prefix noise", () => {
    for (const ok of ["postgres", "postgres:16", "library/postgres:16-alpine", "docker.io/library/postgres:16", "bitnami/redis:7", "redis@sha256:abc", "ghcr.io/valkey/valkey:8", "postgis/postgis:16-3.4", "clickhouse/clickhouse-server:24", "mongo:7", "MariaDB:11", "memcached", "bitnami/postgresql:16", "bitnami/mysql", "bitnami/mariadb:11", "bitnami/mongodb", "mongodb/mongodb-community-server:7", "apache/kafka:3.8", "bitnami/redis:7", "clickhouse/clickhouse-server", "docker.elastic.co/elasticsearch/elasticsearch:8.15", "opensearchproject/opensearch:2", "timescale/timescaledb:latest-pg16", "timescale/timescaledb-ha:pg16", "pgvector/pgvector:pg16", "supabase/postgres:15", "percona:8", "percona/percona-server:8", "cockroachdb/cockroach:v24", "postgresql:16", "mongodb", "confluentinc/cp-kafka:7.6", "redis/redis-stack-server"]) {
      expect(isDatastoreRef(ok)).toBe(true);
    }
  });

  it("does not match look-alikes or ordinary apps", () => {
    for (const no of ["nginx", "redis-exporter", "myorg/redis", "postgres-exporter", "node:20", "ghost", "traefik", "", null, undefined, "minioclient", "app/postgresql-ui", "bitnami/postgresql-exporter", "myorg/postgresql", "a/b/postgres", "bitnami/nginx", "redis-ui", "mongo-express", "timescale/promscale"]) {
      expect(isDatastoreRef(no as string)).toBe(false);
    }
  });

  it("probes an app by image, compose service images, or template slug", () => {
    expect(looksLikeDatastore({ source: "IMAGE", image: "postgres:16" })).toBe(true);
    expect(looksLikeDatastore({ source: "IMAGE", image: "nginx" })).toBe(false);
    expect(looksLikeDatastore({ source: "IMAGE", image: "nginx", templateSlug: "redis" })).toBe(true);
    const compose = "services:\n  web:\n    image: nginx\n  db:\n    image: \"postgres:16\"\n";
    expect(looksLikeDatastore({ source: "COMPOSE", composeFile: compose })).toBe(true);
    expect(looksLikeDatastore({ source: "COMPOSE", composeFile: "services:\n  web:\n    image: nginx\n" })).toBe(false);
    expect(looksLikeDatastore({ source: "COMPOSE", composeFile: null })).toBe(false);
    expect(looksLikeDatastore({ source: "GIT", image: null })).toBe(false);
  });
});

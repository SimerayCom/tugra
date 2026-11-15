import { isDatastoreRef, looksLikeDatastore } from "./datastore-guard";

describe("datastore guard", () => {
  it("matches the known datastore images, with registry/tag/digest/prefix noise", () => {
    for (const ok of ["postgres", "postgres:16", "library/postgres:16-alpine", "docker.io/library/postgres:16", "bitnami/redis:7", "redis@sha256:abc", "ghcr.io/valkey/valkey:8", "postgis/postgis:16-3.4", "clickhouse/clickhouse-server:24", "mongo:7", "MariaDB:11", "memcached"]) {
      expect(isDatastoreRef(ok)).toBe(true);
    }
  });

  it("does not match look-alikes or ordinary apps", () => {
    for (const no of ["nginx", "redis-exporter", "myorg/redis", "postgres-exporter", "node:20", "ghost", "traefik", "", null, undefined, "minioclient", "app/postgresql-ui"]) {
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

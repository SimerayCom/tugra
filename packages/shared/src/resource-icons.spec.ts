import { existsSync } from "node:fs";
import { join } from "node:path";
import { RESOURCE_ICON_KEYS, iconKeyForImage, iconKeyForImages, isResourceIconKey } from "./resource-icons";

describe("RESOURCE_ICON_KEYS", () => {
  it("only lists keys that have a vendored file", () => {
    const dir = join(__dirname, "../../../apps/web/public/icons");
    for (const k of RESOURCE_ICON_KEYS) {
      expect(existsSync(join(dir, `${k}.svg`)) || existsSync(join(dir, `${k}.png`))).toBe(true);
    }
  });
  it("has no duplicates", () => {
    expect(new Set(RESOURCE_ICON_KEYS).size).toBe(RESOURCE_ICON_KEYS.length);
  });
});

describe("isResourceIconKey", () => {
  it("accepts a known key and rejects anything else", () => {
    expect(isResourceIconKey("postgresql")).toBe(true);
    expect(isResourceIconKey("../etc/passwd")).toBe(false);
    expect(isResourceIconKey("nope")).toBe(false);
    expect(isResourceIconKey(42)).toBe(false);
    expect(isResourceIconKey("a".repeat(200))).toBe(false);
  });
});

describe("iconKeyForImage", () => {
  it.each([
    ["docker.io/library/postgres:16-alpine", "postgresql"],
    ["postgres", "postgresql"],
    ["pgvector/pgvector:pg16", "postgresql"],
    ["mysql:8.4", "mysql"],
    ["mariadb:11", "mariadb"],
    ["mongo:7", "mongodb"],
    ["redis:7-alpine", "redis"],
    ["valkey/valkey:8", "valkey"],
    ["eqalpha/keydb", "keydb"],
    ["docker.dragonflydb.io/dragonflydb/dragonfly:v1", "dragonfly"],
    ["clickhouse/clickhouse-server:24", "clickhouse"],
    ["minio/minio:latest", "minio"],
    ["getmeili/meilisearch:v1.8", "meilisearch"],
    ["docker.elastic.co/elasticsearch/elasticsearch:8.13.0", "elasticsearch"],
    ["rabbitmq:3-management", "rabbitmq"],
    ["nginx:1.27", "nginx"],
    ["php:8.3-fpm", "php"],
    ["wordpress:6-apache", "wordpress"],
    ["ghost:5", "ghost"],
    ["ghcr.io/n8n-io/n8n:latest", "n8n"],
    ["n8nio/n8n", "n8n"],
    ["grafana/grafana-oss:11", "grafana"],
    ["ghcr.io/umami-software/umami:postgresql-latest", "umami"],
    ["lscr.io/linuxserver/jellyfin:latest", "jellyfin"],
    ["localhost:5000/library/redis:7", "redis"],
    ["registry.example.com:5443/team/redis@sha256:abc", "redis"],
  ])("%s -> %s", (image, key) => {
    expect(iconKeyForImage(image)).toBe(key);
  });

  it("returns null when nothing fits", () => {
    for (const i of ["", "  ", null, undefined, "ghcr.io/acme/billing-api:1.2", "node:22", "python:3.12", "scratch"]) {
      expect(iconKeyForImage(i as string)).toBeNull();
    }
  });

  it("reads a variant name but not a different product that starts with an engine name", () => {
    expect(iconKeyForImage("acme/postgres-16")).toBe("postgresql");
    expect(iconKeyForImage("acme/redis-stack-alpine")).toBe("redis");
    expect(iconKeyForImage("acme/redis-dashboard")).toBeNull();
    expect(iconKeyForImage("acme/mysql-admin-panel")).toBeNull();
  });

  it("does not give a database icon to tooling around it", () => {
    expect(iconKeyForImage("prometheuscommunity/postgres-exporter")).toBeNull();
    expect(iconKeyForImage("prodrigestivill/postgres-backup-local")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(iconKeyForImage("Docker.io/Library/Redis:7")).toBe("redis");
  });
});

describe("iconKeyForImages", () => {
  it("returns the first hit in order", () => {
    expect(iconKeyForImages([null, "acme/api", "redis:7", "postgres:16"])).toBe("redis");
    expect(iconKeyForImages([])).toBeNull();
  });
});

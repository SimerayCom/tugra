import { redisConnectionOptions } from "./redis-connection";

describe("redisConnectionOptions", () => {
  it("keeps password, TLS and db-index from a rediss:// URL", () => {
    const o = redisConnectionOptions("rediss://:s3cret@redis.example:6380/3");
    expect(o).toMatchObject({
      host: "redis.example",
      port: 6380,
      password: "s3cret",
      db: 3,
      maxRetriesPerRequest: null,
    });
    expect(o.tls).toBeDefined(); // rediss:// → TLS enabled (object form for BullMQ)
    expect(o.username).toBeUndefined(); // password-only URL → no empty ACL username
  });

  it("keeps the username and URL-decodes the password", () => {
    const o = redisConnectionOptions("redis://u:p%40ss@h:6379");
    expect(o).toMatchObject({ username: "u", password: "p@ss", host: "h", port: 6379 });
    expect(o.tls).toBeUndefined();
  });

  it("leaves a plain redis:// URL unauthenticated, no TLS, db 0 (default install unchanged)", () => {
    const o = redisConnectionOptions("redis://redis:6379");
    expect(o).toMatchObject({ host: "redis", port: 6379, db: 0, maxRetriesPerRequest: null });
    expect(o.username).toBeUndefined();
    expect(o.password).toBeUndefined();
    expect(o.tls).toBeUndefined();
  });

  it("parses a non-default db path without credentials", () => {
    expect(redisConnectionOptions("redis://cache:6381/5")).toMatchObject({
      host: "cache",
      port: 6381,
      db: 5,
    });
  });
});

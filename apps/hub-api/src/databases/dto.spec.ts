import { SetDatabaseVolumesSchema, SetDatabaseEnvSchema } from "./dto";

describe("SetDatabaseVolumesSchema", () => {
  const parse = (volumes: unknown) => SetDatabaseVolumesSchema.parse({ volumes });

  it("canonicalizes a path (trailing slash, //, and '.' segments collapse)", () => {
    expect(parse([{ name: "a", path: "/data/" }]).volumes[0].path).toBe("/data");
    expect(parse([{ name: "b", path: "/etc//x/./y/" }]).volumes[0].path).toBe("/etc/x/y");
  });

  it("treats '/data' and '/data/' as the SAME path (duplicate after canonicalization)", () => {
    expect(() => parse([{ name: "a", path: "/data" }, { name: "b", path: "/data/" }])).toThrow(/unique/);
  });

  it("rejects '..' traversal and the container root", () => {
    expect(() => parse([{ name: "a", path: "/x/../y" }])).toThrow(/\.\./);
    expect(() => parse([{ name: "a", path: "/." }])).toThrow(/root/);
  });

  it("rejects a name outside the label charset and enforces the cap", () => {
    expect(() => parse([{ name: "Bad Name", path: "/x" }])).toThrow(/lowercase/);
    expect(() => parse(Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, path: `/v${i}` })))).toThrow();
  });
});

describe("SetDatabaseEnvSchema", () => {
  it("rejects an env value containing a newline (env-file line-injection guard)", () => {
    expect(() => SetDatabaseEnvSchema.parse({ env: { K: "a\nB=evil" } })).toThrow();
  });
  it("accepts a plain key/value map", () => {
    expect(SetDatabaseEnvSchema.parse({ env: { TZ: "UTC" } }).env).toEqual({ TZ: "UTC" });
  });
});

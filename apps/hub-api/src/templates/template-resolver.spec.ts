import { createHmac } from "node:crypto";
import { resolveVariables, type ResolveCtx } from "./template-resolver";
import type { FormField } from "./template-manifest";

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({ appName: "myapp", ...over });

const field = (over: Partial<FormField> & { key: string }): FormField => ({
  type: "password",
  label: over.key,
  ...over,
});

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

describe("resolveVariables", () => {
  it("resolves each generator token type", () => {
    const env = resolveVariables(
      {
        variables: {
          PW: "${password:32}",
          B64: "${base64:32}",
          HEX: "${hex:32}",
          SYM: "${passwordSymbols:24}",
          UID: "${uuid}",
          TS: "${timestamp}",
          TSS: "${timestamps}",
        },
      },
      ctx(),
    );
    expect(env.PW).toMatch(/^[a-zA-Z0-9]+$/);
    expect(env.PW.length).toBeGreaterThanOrEqual(8);
    expect(env.HEX).toMatch(/^[0-9a-f]+$/);
    expect(env.SYM).toMatch(/[!@#$%^&*\-_=+]/);
    expect(env.UID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number(env.TS)).toBeGreaterThan(1_700_000_000_000);
    expect(Number(env.TSS)).toBeLessThan(Number(env.TS)); // seconds < ms
    expect(env.B64.length).toBeGreaterThan(0);
  });

  it("resolves ${domain} from ctx (public IP → sslip.io magic domain; no IP → empty)", () => {
    const withIp = resolveVariables({ variables: { D: "${domain}" } }, ctx({ publicIp: "5.6.7.8", magicSuffix: "sslip.io" }));
    expect(withIp.D).toContain("5-6-7-8");
    expect(withIp.D).toContain("sslip.io");
    const noIp = resolveVariables({ variables: { D: "${domain}" } }, ctx());
    expect(noIp.D).toBe(""); // magicDomain returns null → empty (SSRF-safe, no private-IP domain)
  });

  it("resolves ${port:svc:containerPort} from the allocated port map (missing → empty)", () => {
    const env = resolveVariables(
      { variables: { P: "${port:web:80}", Q: "${port:db:5432}" } },
      ctx({ allocatedPorts: { "web:80": 20001 } }),
    );
    expect(env.P).toBe("20001");
    expect(env.Q).toBe(""); // not allocated
  });

  it("resolves ${VAR} cross-references regardless of declaration order (beats Dokploy's fragile 2-pass)", () => {
    const env = resolveVariables(
      {
        variables: {
          B: "prefix-${A}", // references A, declared BEFORE A
          A: "${password:16}",
          URL: "https://${A}/path",
        },
      },
      ctx(),
    );
    expect(env.B).toBe(`prefix-${env.A}`);
    expect(env.URL).toBe(`https://${env.A}/path`);
    expect(env.A).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it("signs a bare ${jwt} (HS256, opaque, non-deterministic)", () => {
    const env = resolveVariables({ variables: { T: "${jwt}" } }, ctx());
    const parts = env.T.split(".");
    expect(parts).toHaveLength(3);
    expect(b64urlJson(parts[0])).toEqual({ alg: "HS256", typ: "JWT" });
    const again = resolveVariables({ variables: { T: "${jwt}" } }, ctx());
    expect(again.T).not.toBe(env.T); // fresh random secret each time
  });

  it("signs ${jwt:SECRET:PAYLOAD} with the resolved SECRET variable + JSON payload (verifiable HMAC)", () => {
    const env = resolveVariables(
      {
        variables: {
          APP_SECRET: "fixed-secret-value",
          CLAIMS: '{"role":"admin","sub":"u1"}',
          TOKEN: "${jwt:APP_SECRET:CLAIMS}",
        },
      },
      ctx(),
    );
    const [h, p, sig] = env.TOKEN.split(".");
    // signature verifies against the RESOLVED secret value
    const expected = createHmac("sha256", "fixed-secret-value").update(`${h}.${p}`).digest("base64url");
    expect(sig).toBe(expected);
    const payload = b64urlJson(p);
    expect(payload.role).toBe("admin");
    expect(payload.sub).toBe("u1");
    expect(payload.iss).toBe("tugra");
  });

  it("never signs a jwt with the predictable variable NAME when the referenced secret is empty", () => {
    // EMPTY resolves to "" — the HMAC key must fall back to a fresh random secret, NOT the literal
    // "EMPTY" (which an attacker could guess to forge tokens).
    const env = resolveVariables({ variables: { EMPTY: "", TOKEN: "${jwt:EMPTY:}" } }, ctx());
    const [h, p, sig] = env.TOKEN.split(".");
    const predictable = createHmac("sha256", "EMPTY").update(`${h}.${p}`).digest("base64url");
    expect(sig).not.toBe(predictable); // key is NOT the variable name
    // and an inline literal secret (unknown name) IS honoured
    const lit = resolveVariables({ variables: { T: "${jwt:my-inline-secret:}" } }, ctx());
    const [lh, lp, lsig] = lit.T.split(".");
    expect(lsig).toBe(createHmac("sha256", "my-inline-secret").update(`${lh}.${lp}`).digest("base64url"));
  });

  it("lets a user-provided field value override its generator; blank falls back to generate/default", () => {
    const fields: FormField[] = [
      field({ key: "DB_USER", type: "text", generate: "password:16", secret: false }),
      field({ key: "DB_PASSWORD", generate: "password:32" }),
      field({ key: "TZ", generate: undefined, default: "UTC" }),
    ];
    const env = resolveVariables({ fields }, ctx({ userFields: { DB_USER: "admin", DB_PASSWORD: "" } }));
    expect(env.DB_USER).toBe("admin"); // user value wins over generate
    expect(env.DB_PASSWORD).toMatch(/^[a-zA-Z0-9]{8,}$/); // blank → generated
    expect(env.TZ).toBe("UTC"); // no generate, no user → default
  });

  it("puts field AND variable values into the same env record", () => {
    const env = resolveVariables(
      {
        fields: [field({ key: "SECRET_KEY", generate: "hex:32" })],
        variables: { STATIC: "literal", REF: "${SECRET_KEY}" },
      },
      ctx(),
    );
    expect(env.SECRET_KEY).toMatch(/^[0-9a-f]{32}$/);
    expect(env.STATIC).toBe("literal");
    expect(env.REF).toBe(env.SECRET_KEY); // a variable can reference a field
  });

  it("halts on a circular reference instead of looping forever (leaves the token raw)", () => {
    const env = resolveVariables({ variables: { A: "${B}", B: "${A}" } }, ctx());
    // no throw, no hang; unresolved tokens remain visible (not silently blank)
    expect(env.A).toContain("${");
    expect(env.B).toContain("${");
  });

  it("produces fresh secrets on every call (non-deterministic)", () => {
    const one = resolveVariables({ variables: { S: "${password:32}" } }, ctx());
    const two = resolveVariables({ variables: { S: "${password:32}" } }, ctx());
    expect(one.S).not.toBe(two.S);
  });

  it("leaves an unknown ${TOKEN} literal (no crash, no code execution)", () => {
    const env = resolveVariables({ variables: { X: "a-${totally_unknown}-b" } }, ctx());
    expect(env.X).toBe("a-${totally_unknown}-b");
  });

  it("returns an empty env for an empty manifest", () => {
    expect(resolveVariables({}, ctx())).toEqual({});
  });
});

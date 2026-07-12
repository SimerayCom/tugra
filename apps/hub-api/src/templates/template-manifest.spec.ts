import { TEMPLATES, type TemplateDef } from "./catalog";
import { toManifest, type FormField } from "./template-manifest";

/** A minimal synthetic TemplateDef so the mapping tests don't depend on which real templates
 *  happen to carry a given shape. */
function def(over: Partial<TemplateDef> = {}): TemplateDef {
  return {
    slug: "syn",
    name: "Synthetic",
    description: "d",
    category: "tools",
    composeFile: "services:\n  app:\n    image: x\n",
    ...over,
  };
}

const fieldByKey = (fields: FormField[] | undefined, key: string) =>
  (fields ?? []).find((f) => f.key === key);

describe("template-manifest", () => {
  it("maps every real template to a well-formed manifest (fields ↔ secret keys)", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      const m = toManifest(tpl);
      expect(`${slug}:${m.slug}`).toBe(`${slug}:${slug}`);
      expect(`${slug}:${Boolean(m.name)}`).toBe(`${slug}:true`);
      expect(`${slug}:${m.composeFile.includes("services:")}`).toBe(`${slug}:true`);
      // fields cover EXACTLY the template's secret keys
      const secretKeys = (tpl.secrets ?? []).map((s) => (typeof s === "string" ? s : s.key)).sort();
      const fieldKeys = (m.fields ?? []).map((f) => f.key).sort();
      expect(`${slug}:${fieldKeys.join(",")}`).toBe(`${slug}:${secretKeys.join(",")}`);
      // every field is structurally complete + generate-backed
      for (const f of m.fields ?? []) {
        expect(`${slug}.${f.key}:${Boolean(f.key && f.type && f.label && f.generate)}`).toBe(`${slug}.${f.key}:true`);
        expect(`${slug}.${f.key}:${f.required ?? false}`).toBe(`${slug}.${f.key}:false`);
      }
    }
  });

  it("maps secret kind → generate token (alnum/base64/hex/password-symbols) and bare string → password:24", () => {
    const m = toManifest(
      def({
        secrets: [
          { key: "A_ALNUM", kind: "alnum", len: 32 },
          { key: "B_BASE64", kind: "base64", len: 32 },
          { key: "C_HEX", kind: "hex", len: 32 },
          { key: "D_SYM", kind: "password-symbols", len: 24 },
          "E_BARE",
        ],
        // reference every secret so it is a valid template shape (not asserted here, but mirrors real data)
        composeFile: "services:\n  app:\n    environment:\n      - A=$A_ALNUM $B_BASE64 $C_HEX $D_SYM $E_BARE\n",
      }),
    );
    expect(fieldByKey(m.fields, "A_ALNUM")?.generate).toBe("password:32");
    expect(fieldByKey(m.fields, "B_BASE64")?.generate).toBe("base64:32");
    expect(fieldByKey(m.fields, "C_HEX")?.generate).toBe("hex:32");
    expect(fieldByKey(m.fields, "D_SYM")?.generate).toBe("passwordSymbols:24");
    expect(fieldByKey(m.fields, "E_BARE")?.generate).toBe("password:24"); // bare string ⇒ alnum/24
  });

  it("treats USER* keys as visible text (not secret), everything else as a masked secret", () => {
    const m = toManifest(def({ secrets: [{ key: "USER_POSTGRES", kind: "alnum", len: 16 }, { key: "PASSWORD_DB", kind: "alnum", len: 32 }] }));
    const user = fieldByKey(m.fields, "USER_POSTGRES")!;
    expect(user.type).toBe("text");
    expect(user.secret).toBe(false);
    expect(Boolean(user.generate)).toBe(true); // still auto-generated when blank
    const pass = fieldByKey(m.fields, "PASSWORD_DB")!;
    expect(pass.type).toBe("password");
    expect(pass.secret).toBe(true);
  });

  it("derives a human label from the key", () => {
    const m = toManifest(def({ secrets: [{ key: "PASSWORD_64_APIKEY", kind: "alnum", len: 64 }] }));
    expect(fieldByKey(m.fields, "PASSWORD_64_APIKEY")?.label).toBe("Password 64 Apikey");
  });

  it("maps static env → variables, dropping any key shadowed by a secret field", () => {
    const m = toManifest(
      def({
        env: { TZ: "UTC", NODE_ENV: "production", DB_PASSWORD: "should-be-shadowed" },
        secrets: [{ key: "DB_PASSWORD", kind: "alnum", len: 32 }],
      }),
    );
    expect(m.variables).toEqual({ TZ: "UTC", NODE_ENV: "production" }); // DB_PASSWORD dropped (a field owns it)
    expect(fieldByKey(m.fields, "DB_PASSWORD")?.secret).toBe(true);
  });

  it("maps the web service → a domain exposure entry", () => {
    const m = toManifest(def({ web: { service: "wordpress", port: 80 } }));
    expect(m.exposure).toEqual([{ serviceName: "wordpress", containerPort: 80, defaultMode: "domain", public: true }]);
  });

  it("omits empty optional sections (no fields/variables/exposure/mounts keys)", () => {
    const m = toManifest(def()); // no secrets, no env, no web
    expect(m.fields).toBeUndefined();
    expect(m.variables).toBeUndefined();
    expect(m.exposure).toBeUndefined();
    expect(m.mounts).toBeUndefined();
  });

  it("preserves gallery metadata and never emits raw secrets", () => {
    const m = toManifest(
      def({ slug: "meta", name: "Meta", description: "desc", category: "cms", icon: "🧩", logo: "meta", documentation: "https://x", secrets: [{ key: "P", kind: "alnum", len: 8 }] }),
    );
    expect(m).toMatchObject({ slug: "meta", name: "Meta", description: "desc", category: "cms", icon: "🧩", logo: "meta", documentation: "https://x" });
    expect((m as { secrets?: unknown }).secrets).toBeUndefined(); // secrets folded into fields, not re-emitted
  });
});

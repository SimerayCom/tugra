import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { CatalogVerifyError, MAX_ENVELOPE_BYTES, verifyCatalogEnvelope } from "./catalog-envelope";

function keypair(): { priv: KeyObject; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pubB64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

/** Build a signed envelope from an arbitrary payload object using `priv`. */
function envelope(priv: KeyObject, payloadObj: unknown): string {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
  const sig = sign(null, Buffer.from(payload), priv).toString("base64");
  return JSON.stringify({ payload, sig });
}

const tpl = (over: Record<string, unknown> = {}) => ({
  slug: "foo",
  name: "Foo",
  description: "d",
  category: "tools",
  composeFile: "services:\n  app:\n    image: x\n",
  ...over,
});
const payload = (templates: Record<string, unknown>, version = "1") => ({ version, templates });

describe("verifyCatalogEnvelope", () => {
  const { priv, pubB64 } = keypair();

  it("returns the verified catalog for a valid signed envelope", () => {
    const out = verifyCatalogEnvelope(envelope(priv, payload({ foo: tpl() })), pubB64);
    expect(out.version).toBe("1");
    expect(Object.keys(out.templates)).toEqual(["foo"]);
    expect(out.templates.foo.composeFile).toContain("services:");
  });

  it("accepts a validly-signed EMPTY templates set (a no-op overlay, never blanks)", () => {
    expect(verifyCatalogEnvelope(envelope(priv, payload({})), pubB64).templates).toEqual({});
  });

  it("rejects a signature made over different bytes", () => {
    // sign one payload but ship another string
    const good = JSON.parse(envelope(priv, payload({ foo: tpl() }))) as { payload: string; sig: string };
    const other = Buffer.from(JSON.stringify(payload({ bar: tpl({ slug: "bar" }) }))).toString("base64");
    const forged = JSON.stringify({ payload: other, sig: good.sig });
    expect(() => verifyCatalogEnvelope(forged, pubB64)).toThrow(CatalogVerifyError);
  });

  it("rejects a tampered payload (flip a char after signing)", () => {
    const env = JSON.parse(envelope(priv, payload({ foo: tpl() }))) as { payload: string; sig: string };
    env.payload = "A" + env.payload.slice(1);
    expect(() => verifyCatalogEnvelope(JSON.stringify(env), pubB64)).toThrow(/bad signature/);
  });

  it("rejects a signature from the wrong publisher key", () => {
    const other = keypair();
    expect(() => verifyCatalogEnvelope(envelope(priv, payload({ foo: tpl() })), other.pubB64)).toThrow(/bad signature/);
  });

  it("rejects a malformed outer envelope", () => {
    expect(() => verifyCatalogEnvelope("not json", pubB64)).toThrow(/malformed envelope/);
    expect(() => verifyCatalogEnvelope(JSON.stringify({ payload: 123 }), pubB64)).toThrow(/malformed envelope/);
  });

  it("VERIFY-BEFORE-PARSE: a bad-sig envelope whose payload is garbage fails on the SIGNATURE, not a parse", () => {
    // payload decodes to invalid JSON; sig is over it but from the WRONG key → must fail at the sig gate,
    // proving the malicious payload JSON is never parsed pre-auth.
    const garbage = Buffer.from("{ not: json").toString("base64");
    const wrong = keypair();
    const badSig = sign(null, Buffer.from(garbage), wrong.priv).toString("base64");
    expect(() => verifyCatalogEnvelope(JSON.stringify({ payload: garbage, sig: badSig }), pubB64)).toThrow(/bad signature/);
  });

  it("rejects a shape violation (missing composeFile / bad category / no services:) — whole blob", () => {
    const noCompose = { slug: "foo", name: "Foo", description: "d", category: "tools" };
    expect(() => verifyCatalogEnvelope(envelope(priv, payload({ foo: noCompose })), pubB64)).toThrow(/invalid template shape/);
    expect(() => verifyCatalogEnvelope(envelope(priv, payload({ foo: tpl({ category: "nope" }) })), pubB64)).toThrow(/invalid template shape/);
    expect(() => verifyCatalogEnvelope(envelope(priv, payload({ foo: tpl({ composeFile: "image: x" }) })), pubB64)).toThrow(/invalid template shape/);
  });

  it("rejects a key/slug spoof (map key != template.slug)", () => {
    expect(() => verifyCatalogEnvelope(envelope(priv, payload({ foo: tpl({ slug: "bar" }) })), pubB64)).toThrow(/slug\/key mismatch/);
  });

  it("rejects an oversize body before parsing", () => {
    const huge = "x".repeat(MAX_ENVELOPE_BYTES + 1);
    expect(() => verifyCatalogEnvelope(huge, pubB64)).toThrow(/too large/);
  });

  it("accepts a template that needs docker.sock/privileged (catalog is trusted via signature, not assertSafeCompose)", () => {
    const privileged = tpl({ slug: "portainer", composeFile: "services:\n  app:\n    image: portainer\n    privileged: true\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n" });
    const out = verifyCatalogEnvelope(envelope(priv, payload({ portainer: privileged })), pubB64);
    expect(out.templates.portainer).toBeTruthy(); // NOT rejected — a signed catalog may ship such apps
  });
});

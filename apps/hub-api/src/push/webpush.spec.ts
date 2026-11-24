import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import {
  MAX_PAYLOAD_BYTES,
  audienceOf,
  b64u,
  buildWebPushRequest,
  encryptPayload,
  fromB64u,
  generateVapidKeys,
  isValidSubscriptionKeys,
  vapidAuthorization,
  vapidPairMatches,
} from "./webpush";

// RFC 8291 appendix A example values.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
};

/** The browser side, written independently of encryptPayload: decrypt a body with the subscription's private key. */
function decryptAsBrowser(body: Buffer, uaPrivateB64: string, uaPublicB64: string, authB64: string): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(fromB64u(uaPrivateB64));
  const secret = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), fromB64u(uaPublicB64), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, fromB64u(authB64), info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(0x02); // last-record delimiter
  return plain.subarray(0, plain.length - 1);
}

function ephemeral() {
  const as = createECDH("prime256v1");
  as.setPrivateKey(fromB64u(RFC.asPrivate));
  return as;
}

describe("encryptPayload (RFC 8291)", () => {
  it("builds the RFC 8291 appendix A message: header fields as published, and the browser recovers the plaintext", () => {
    const out = encryptPayload(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, {
      ephemeral: ephemeral(),
      salt: fromB64u(RFC.salt),
    });
    expect(out.subarray(21, 86).equals(fromB64u(RFC.asPublic))).toBe(true); // ephemeral key id in the header
    expect(b64u(out.subarray(0, 21))).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABB"); // salt || rs=4096 || idlen=65
    expect(decryptAsBrowser(out, RFC.uaPrivate, RFC.uaPublic, RFC.auth).toString()).toBe(RFC.plaintext);
  });

  it("is decryptable by the subscription owner with a fresh ephemeral key", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = b64u(Buffer.alloc(16, 7));
    const msg = Buffer.from(JSON.stringify({ title: "Deploy failed", body: "api on prod-1" }));
    const out = encryptPayload(msg, b64u(ua.getPublicKey()), auth);
    expect(decryptAsBrowser(out, b64u(ua.getPrivateKey()), b64u(ua.getPublicKey()), auth).toString()).toBe(msg.toString());
  });

  it("uses a fresh salt and key every time", () => {
    const a = encryptPayload(Buffer.from("x"), RFC.uaPublic, RFC.auth);
    const b = encryptPayload(Buffer.from("x"), RFC.uaPublic, RFC.auth);
    expect(a.equals(b)).toBe(false);
  });

  it("refuses a payload that would not fit a single 4096-byte record", () => {
    expect(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), RFC.uaPublic, RFC.auth)).toThrow(/too large/);
    expect(encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES), RFC.uaPublic, RFC.auth).length).toBe(4096);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 JWT that verifies against the advertised public key", () => {
    const keys = generateVapidKeys();
    expect(vapidPairMatches(keys)).toBe(true);
    const header = vapidAuthorization("https://push.example.com/send/abc", "mailto:ops@example.com", keys, 1_700_000_000);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(fromB64u(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromB64u(c).toString())).toEqual({ aud: "https://push.example.com", exp: 1_700_000_000 + 12 * 3600, sub: "mailto:ops@example.com" });
    const point = fromB64u(keys.publicKey);
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: "jwk" });
    expect(fromB64u(s).length).toBe(64); // raw r||s, not DER
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, fromB64u(s))).toBe(true);
  });

  it("detects a private key that does not belong to the public key", () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    expect(vapidPairMatches({ publicKey: a.publicKey, privateKeyPem: b.privateKeyPem })).toBe(false);
  });

  it("uses the endpoint origin as audience", () => {
    expect(audienceOf("https://fcm.example.com:8443/wpush/v2/token")).toBe("https://fcm.example.com:8443");
  });
});

describe("isValidSubscriptionKeys", () => {
  it("accepts a real browser key + 16-byte auth", () => {
    expect(isValidSubscriptionKeys(RFC.uaPublic, RFC.auth)).toBe(true);
  });
  it("rejects wrong lengths, non-base64url and off-curve points", () => {
    expect(isValidSubscriptionKeys("AAAA", RFC.auth)).toBe(false);
    expect(isValidSubscriptionKeys(RFC.uaPublic, "AAAA")).toBe(false);
    expect(isValidSubscriptionKeys("not base64url!", RFC.auth)).toBe(false);
    expect(isValidSubscriptionKeys(b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])), RFC.auth)).toBe(false);
  });
});

describe("buildWebPushRequest", () => {
  it("emits the headers a push service requires", () => {
    const keys = generateVapidKeys();
    const r = buildWebPushRequest({
      endpoint: "https://push.example.com/send/abc",
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
      payload: Buffer.from("{}"),
      subject: "mailto:ops@example.com",
      keys,
      urgency: "high",
    });
    expect(r.headers["content-encoding"]).toBe("aes128gcm");
    expect(r.headers["content-length"]).toBe(String(r.body.length));
    expect(r.headers.ttl).toBe("86400");
    expect(r.headers.urgency).toBe("high");
    expect(r.headers.authorization).toMatch(/^vapid t=.+, k=/);
  });
});

import { resolveDestinationSpec } from "./destination-resolver";
import { LOCAL_DEST } from "./destination";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";

const crypto = { decrypt: (s: string) => s.replace(/^enc:/, "") } as unknown as CryptoService;
const prismaOf = (row: unknown) => ({ backupDestination: { findUnique: jest.fn().mockResolvedValue(row) } }) as unknown as PrismaService;

const base = { id: "d1", s3Bucket: "b", s3Region: "r", s3Endpoint: "s3.x", s3AccessKey: "enc:AK", s3SecretKey: "enc:SK", s3Prefix: "p" };

describe("resolveDestinationSpec", () => {
  it("no destination id -> the implicit LOCAL disk (unencrypted)", async () => {
    const prisma = prismaOf(null);
    expect(await resolveDestinationSpec(prisma, crypto, null)).toBe(LOCAL_DEST);
    expect(prisma.backupDestination.findUnique).not.toHaveBeenCalled();
  });

  it("a missing row -> LOCAL (legacy behaviour)", async () => {
    expect(await resolveDestinationSpec(prismaOf(null), crypto, "gone")).toBe(LOCAL_DEST);
  });

  it("LOCAL + encrypted keeps its encryption (the volume-LOCAL bug fix)", async () => {
    const spec = await resolveDestinationSpec(prismaOf({ ...base, type: "LOCAL", encryptionEnabled: true, encryptionKey: "enc:KEY" }), crypto, "d1");
    expect(spec).toEqual({ type: "LOCAL", encryption: { enabled: true, key: "KEY" } });
  });

  it("LOCAL unencrypted stays unencrypted", async () => {
    const spec = await resolveDestinationSpec(prismaOf({ ...base, type: "LOCAL", encryptionEnabled: false, encryptionKey: null }), crypto, "d1");
    expect(spec).toEqual({ type: "LOCAL", encryption: { enabled: false, key: "" } });
  });

  it("S3 decrypts creds and carries encryption", async () => {
    const spec = await resolveDestinationSpec(prismaOf({ ...base, type: "S3", encryptionEnabled: true, encryptionKey: "enc:KEY" }), crypto, "d1");
    expect(spec).toEqual({
      type: "S3",
      s3: { bucket: "b", region: "r", endpoint: "s3.x", accessKey: "AK", secretKey: "SK", prefix: "p" },
      encryption: { enabled: true, key: "KEY" },
    });
  });

  it("FAILS CLOSED when encryption is enabled but the key is missing (never an empty passphrase)", async () => {
    await expect(resolveDestinationSpec(prismaOf({ ...base, type: "S3", encryptionEnabled: true, encryptionKey: null }), crypto, "d1")).rejects.toThrow(
      "destination encryption is enabled but its key is missing",
    );
    await expect(resolveDestinationSpec(prismaOf({ ...base, type: "LOCAL", encryptionEnabled: true, encryptionKey: null }), crypto, "d1")).rejects.toThrow(/key is missing/);
  });
});

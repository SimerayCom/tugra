import { runExport } from "./export-destination-keys";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";

const crypto = { decrypt: (s: string) => { if (s === "enc:BAD") throw new Error("cannot open"); return s.replace(/^enc:/, ""); } } as unknown as CryptoService;
const d1 = { id: "d1", name: "prod s3", teamId: "t1", type: "S3", s3Bucket: "bk", s3Endpoint: "s3.x", s3Region: "r", s3Prefix: "p", encryptionEnabled: true, encryptionKey: "enc:KEY-ONE" };
const prismaOf = (rows: unknown[]) => ({ backupDestination: { findMany: jest.fn().mockResolvedValue(rows) } }) as unknown as PrismaService;
const dests = [d1];

describe("scripts/export-destination-keys runExport", () => {
  it("outputs decrypted keys with exit 0", async () => {
    const r = await runExport(prismaOf(dests), crypto, "K");
    expect(r.exitCode).toBe(0);
    expect(r.manifest.destinations[0].encryption.passphrase).toBe("KEY-ONE");
  });
  it("exit code 2 when a row is undecryptable (manifest still printed)", async () => {
    const r = await runExport(prismaOf([...dests, { ...dests[0], id: "d3", encryptionKey: "enc:BAD" }]), crypto, "K");
    expect(r.exitCode).toBe(2);
    expect(r.manifest.destinations).toHaveLength(1);
  });
  it("an empty destinations list for no encrypted destinations, exit 0", async () => {
    const r = await runExport(prismaOf([]), crypto, "K");
    expect(r.exitCode).toBe(0);
    expect(r.manifest.destinations).toEqual([]);
    expect(r.manifest.v).toBe(1);
  });
});

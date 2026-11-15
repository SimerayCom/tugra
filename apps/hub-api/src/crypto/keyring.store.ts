import { PrismaService } from "../prisma/prisma.service";

/** Injection token for the keyring persistence (a Prisma-backed store in the app, a fake in specs). */
export const KEYRING_STORE = Symbol("KEYRING_STORE");

export type SecretsKeyStateName = "ACTIVE" | "DECRYPT_ONLY" | "RETIRED";

/** A consistent read of the keyring: the epoch plus every data-key row and its wraps. Wraps are ciphertext under a
 *  .env root key; the snapshot never holds a usable key. */
export interface KeyringSnapshot {
  epoch: number;
  keys: { id: string; state: SecretsKeyStateName; activatedAt: Date; demotedAt: Date | null }[];
  wraps: { keyId: string; rootKeyId: string; wrapped: string }[];
}

export interface KeyringStore {
  load(): Promise<KeyringSnapshot>;
  readEpoch(): Promise<number>;
}

const LOAD_ATTEMPTS = 3;

/** Reads the keyring from Postgres. `load()` is epoch -> rows -> epoch: any ring mutation bumps the epoch inside its
 *  transaction, so a differing second read means the rows are torn (read across a mutation) and is retried. */
export class PrismaKeyringStore implements KeyringStore {
  constructor(private readonly prisma: PrismaService) {}

  async readEpoch(): Promise<number> {
    const row = await this.prisma.secretsKeyring.findUnique({ where: { id: "singleton" }, select: { epoch: true } });
    return row?.epoch ?? 0;
  }

  async load(): Promise<KeyringSnapshot> {
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      const before = await this.readEpoch();
      const keys = await this.prisma.secretsKey.findMany({ select: { id: true, state: true, activatedAt: true, demotedAt: true } });
      const wraps = await this.prisma.secretsKeyWrap.findMany({ select: { keyId: true, rootKeyId: true, wrapped: true } });
      const after = await this.readEpoch();
      if (before === after) return { epoch: before, keys, wraps };
    }
    throw new Error("secrets keyring read was torn by a concurrent change; retry");
  }
}

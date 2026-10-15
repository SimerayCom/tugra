import { CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Observable, of } from "rxjs";
import { tap } from "rxjs/operators";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";

const CLAIM_TTL_SEC = 120; // a PENDING claim self-heals in 2 min if the request crashes / the store never lands
const RESULT_TTL_SEC = 24 * 60 * 60; // a stored result is replayable for 24h
const PENDING = "\u0000pending"; // sentinel distinguishable from any encrypted result
const MAX_STORED_BYTES = 1_000_000; // don't park an absurd response in Redis

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Idempotency-Key support for mutating requests. When a client sends `Idempotency-Key: <k>` on a POST, the first
 * request claims a key (Redis SET NX), runs, and stores its result; a retry with the same fingerprint replays
 * that exact status + body instead of running again (so a network retry can't double-create or double-deploy),
 * and a second request that arrives while the first is still in flight gets 409.
 *
 * The key fingerprints the CONCRETE request — user + credential (tokenId) + method + full path + a hash of the
 * body + the header key — so one key value can never replay across a different resource, body, or credential.
 * Only a 2xx result is cached (an error must be retryable, never replayed). The stored result is ENCRYPTED at
 * rest (some POSTs return a secret). Opt-in (no header → normal), fail-OPEN on any Redis error. The claim uses a
 * short TTL so a crashed/abandoned request releases the key quickly; the result then gets the full 24h TTL.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest();
    if (req.method !== "POST") return next.handle(); // only POST (create/deploy-style) is deduped
    const rawKey = req.headers?.["idempotency-key"];
    const headerKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const userId: string | undefined = req.user?.userId;
    if (!headerKey || typeof headerKey !== "string" || !userId) return next.handle();

    const path = String(req.originalUrl ?? req.url ?? "").split("?")[0]; // CONCRETE path, not the route pattern
    let bodyHash: string;
    try {
      bodyHash = sha(JSON.stringify(req.body ?? ""));
    } catch {
      bodyHash = "unserializable"; // a cyclic/unserializable body still fingerprints deterministically
    }
    const tokenId: string = req.user?.tokenId ?? "session"; // a lower-scope PAT can't replay another token's result
    const key = "idem:" + sha(`${userId}\n${tokenId}\n${req.method} ${path}\n${bodyHash}\n${headerKey}`);
    const res = ctx.switchToHttp().getResponse();

    let claimed: string | null;
    try {
      claimed = await this.redis.client.set(key, PENDING, "EX", CLAIM_TTL_SEC, "NX");
    } catch {
      return next.handle(); // fail-open: Redis down → behave as if idempotency weren't configured
    }

    if (claimed !== "OK") {
      let stored: string | null;
      try {
        stored = await this.redis.get(key);
      } catch {
        return next.handle();
      }
      if (stored === null) return next.handle(); // expired between the NX and the GET
      if (stored === PENDING) throw new ConflictException("a request with this Idempotency-Key is already in progress");
      try {
        const parsed = JSON.parse(this.crypto.decrypt(stored)) as { status: number; body: unknown };
        res.status(parsed.status);
        return of(parsed.body);
      } catch {
        return next.handle(); // undecryptable/corrupt (e.g. key rotated) → just run it
      }
    }

    // First request for this key: run it, then park the result (best-effort) for any retry to replay.
    return next.handle().pipe(
      tap({
        next: (body) => {
          const status = Number(res.statusCode) || 200;
          if (status < 200 || status >= 300) {
            // An error / non-success is never cached — the operation didn't complete, so a retry must re-run it.
            void this.redis.del(key).catch(() => undefined);
            return;
          }
          try {
            const plain = JSON.stringify({ status, body });
            if (plain.length <= MAX_STORED_BYTES) {
              void this.redis.set(key, this.crypto.encrypt(plain), RESULT_TTL_SEC).catch(() => undefined); // encrypted at rest
            } else {
              void this.redis.del(key).catch(() => undefined); // too big to replay — let a retry re-run
            }
          } catch {
            void this.redis.del(key).catch(() => undefined); // unserializable / encrypt failure → release
          }
        },
        error: () => {
          // A failed request must not pin the key — release it so the client can retry the operation.
          void this.redis.del(key).catch(() => undefined);
        },
      }),
    );
  }
}

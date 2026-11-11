import { CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { defer, Observable, of } from "rxjs";
import { finalize, tap } from "rxjs/operators";
import { RedisService } from "../redis/redis.service";
import { CryptoService } from "../crypto/crypto.service";

const CLAIM_TTL_SEC = 120; // a PENDING claim self-heals in 2 min if the request crashes / the store never lands
const HEARTBEAT_MS = Math.floor((CLAIM_TTL_SEC * 1000) / 3); // refresh the lease (~40s) well before it expires
const RESULT_TTL_SEC = 24 * 60 * 60; // a stored result is replayable for 24h
const PENDING = "\u0000pending"; // sentinel prefix distinguishable from any (base64) encrypted result
const MAX_STORED_BYTES = 1_000_000; // don't park an absurd response in Redis

// Compare-and-X Lua so a request only ever touches ITS OWN claim value: a stale/expired request can never
// extend, overwrite, or delete a key that now belongs to a LATER owner (every op guards on the exact value).
const EXTEND_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
const SET_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]) else return 0 end";
const DEL_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Idempotency-Key support for mutating requests. When a client sends `Idempotency-Key: <k>` on a POST, the first
 * request claims a key (Redis SET NX), runs, and stores its result; a retry with the same fingerprint replays
 * that exact status + body instead of running again, and a second request that arrives while the first is still
 * in flight gets 409. The claim is an OWNED LEASE (value `PENDING:<token>`) and a heartbeat extends its TTL while
 * the handler runs, so a long operation (a 120s+ deploy) never releases its key mid-flight and get re-run by a
 * retry. Every later Redis write is a compare-and-X on that token, so a stale request can never clobber a later
 * owner's key. Only a 2xx result is cached; results are ENCRYPTED at rest.
 *
 * SCOPE OF THE GUARANTEE (deliberately narrow): dedupe applies only when the client SENDS the header, on a POST,
 * with Redis healthy, on a single hub. It is NOT a universal exactly-once: a request with NO header is not
 * deduped; a Redis flush / outage longer than the claim TTL mid-op, or a hub crash mid-op, can let a same-key
 * retry run again; and the agent-side docker effect is never exactly-once across a hub crash. For the deploy
 * path the per-app queue bounds the blast radius (one RUNNING at a time, FIFO), but that is NOT a durable
 * at-most-once — a durable `Deployment.idempotencyKey` unique index would be the follow-up for that.
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

    // A per-request token: the claim value is PENDING:<token> so we can prove ownership on every later write.
    const claimValue = `${PENDING}:${randomUUID()}`;
    const claimNx = () => this.redis.client.set(key, claimValue, "EX", CLAIM_TTL_SEC, "NX");

    let claimed: string | null;
    try {
      claimed = await claimNx();
    } catch {
      return next.handle(); // fail-open: Redis unreachable at claim time → behave as if idempotency were off
    }
    if (claimed === "OK") return this.runWithLease(key, claimValue, next, res);

    // The key already exists: it's either an in-flight claim or a stored result.
    let stored: string | null;
    try {
      stored = await this.redis.get(key);
    } catch {
      // NX already told us the key EXISTS; we just can't read its state. Running the handler here could
      // double-execute, so refuse — the client retries once Redis is readable and gets a replay or a real 409.
      throw new ConflictException("a request with this Idempotency-Key is in progress (status temporarily unavailable)");
    }
    if (stored === null) {
      // Expired between the NX and the GET. Re-claim ONCE rather than running UNGUARDED (the old code ran the
      // handler here with no claim, defeating dedupe). If someone else took it in the gap → in progress.
      return this.reclaimOrConflict(key, claimValue, next, res, claimNx);
    }
    if (stored.startsWith(PENDING)) throw new ConflictException("a request with this Idempotency-Key is already in progress");
    try {
      const parsed = JSON.parse(this.crypto.decrypt(stored)) as { status: number; body: unknown };
      res.status(parsed.status);
      return of(parsed.body);
    } catch {
      // Undecryptable/corrupt (e.g. the encryption key rotated). The stored result is unusable — drop it and
      // re-run UNDER A LEASE so the re-run is itself deduplicated (the old code re-ran it unguarded).
      try {
        await this.redis.del(key);
      } catch {
        return next.handle();
      }
      return this.reclaimOrConflict(key, claimValue, next, res, claimNx);
    }
  }

  /** Re-claim the key with SET NX; run under a lease if we win it, else 409 (someone else owns it now). */
  private async reclaimOrConflict(
    key: string,
    claimValue: string,
    next: CallHandler,
    res: { statusCode?: number },
    claimNx: () => Promise<string | null>,
  ): Promise<Observable<unknown>> {
    let reclaimed: string | null;
    try {
      reclaimed = await claimNx();
    } catch {
      return next.handle();
    }
    if (reclaimed !== "OK") throw new ConflictException("a request with this Idempotency-Key is already in progress");
    return this.runWithLease(key, claimValue, next, res);
  }

  /**
   * Run the handler while holding an OWNED lease on `key`. The heartbeat (created on SUBSCRIBE via `defer`, so
   * its lifetime matches the subscription and it can't leak if never subscribed) extends the claim's TTL only
   * while we still own it; if the lease is lost (EXTEND returns 0) the heartbeat stops. Result-store and release
   * are compare-and-X on our token, so a stale request can never overwrite or delete a later owner's claim.
   */
  private runWithLease(
    key: string,
    claimValue: string,
    next: CallHandler,
    res: { statusCode?: number },
  ): Observable<unknown> {
    return defer(() => {
      const hb = setInterval(() => {
        try {
          void this.redis.client
            .eval(EXTEND_IF_OWNER, 1, key, claimValue, String(CLAIM_TTL_SEC))
            .then((r) => {
              if (r === 0 || r === "0") clearInterval(hb); // lease lost/expired — stop beating (result won't store)
            })
            .catch(() => undefined);
        } catch {
          /* a synchronous throw from eval must never crash the heartbeat timer */
        }
      }, HEARTBEAT_MS);
      if (typeof (hb as { unref?: () => void }).unref === "function") (hb as { unref: () => void }).unref();
      const owned = (script: string, ...args: (string | number)[]): void => {
        try {
          void this.redis.client.eval(script, 1, key, claimValue, ...args).catch(() => undefined);
        } catch {
          /* ignore a synchronous eval throw — releasing/storing is best-effort */
        }
      };
      return next.handle().pipe(
        finalize(() => clearInterval(hb)), // stop the heartbeat on complete, error, or unsubscribe
        tap({
          next: (body) => {
            const status = Number(res.statusCode) || 200;
            if (status < 200 || status >= 300) {
              // An error / non-success is never cached — the operation didn't complete, so a retry must re-run.
              owned(DEL_IF_OWNER);
              return;
            }
            try {
              const plain = JSON.stringify({ status, body });
              if (plain.length <= MAX_STORED_BYTES) {
                owned(SET_IF_OWNER, this.crypto.encrypt(plain), String(RESULT_TTL_SEC)); // encrypted at rest
              } else {
                owned(DEL_IF_OWNER); // too big to replay — let a retry re-run
              }
            } catch {
              owned(DEL_IF_OWNER); // unserializable / encrypt failure → release
            }
          },
          error: () => {
            // A failed request must not pin the key — release it (if still ours) so the client can retry.
            owned(DEL_IF_OWNER);
          },
        }),
      );
    });
  }
}

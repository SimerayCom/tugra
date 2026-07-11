import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Observable } from "rxjs";
import { AgentWsServer } from "./agent-ws.server";

/** One SSE event of a live container-log stream. */
export interface LogStreamEvent {
  chunk?: string;
  exitCode?: number;
}

// A `--follow` stream never ends on its own, so bound it two ways: a per-server concurrency cap
// (one runaway client can't spawn unlimited `docker logs -f` on an agent) and a hard max duration.
const MAX_STREAMS_PER_SERVER = 5;
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Bridges an SSE subscriber to a signed agent log-follow session. Each subscribe mints one agent
 * stream (streamId), relays chunks, and on unsubscribe/complete/error tears the agent process down
 * (log_stop) — so a closed browser tab can't leak a follow process on the managed server.
 */
@Injectable()
export class LogStreamService {
  private readonly perServer = new Map<string, number>(); // serverId → active stream count

  constructor(private readonly agentWs: AgentWsServer) {}

  stream(serverId: string, target: string, opts: { tail: number; follow: boolean }): Observable<LogStreamEvent> {
    return new Observable<LogStreamEvent>((subscriber) => {
      const active = this.perServer.get(serverId) ?? 0;
      if (active >= MAX_STREAMS_PER_SERVER) {
        subscriber.error(new ServiceUnavailableException("too many concurrent log streams for this server"));
        return;
      }
      this.perServer.set(serverId, active + 1); // reserve a slot before the async start (race-safe)

      let streamId: string | undefined;
      let torndown = false;
      const teardown = () => {
        if (torndown) return;
        torndown = true;
        clearTimeout(durationTimer);
        const n = (this.perServer.get(serverId) ?? 1) - 1;
        if (n <= 0) this.perServer.delete(serverId);
        else this.perServer.set(serverId, n);
        if (streamId) this.agentWs.stopLogStream(serverId, streamId);
      };

      // A follow stream never completes on its own → cap total duration.
      const durationTimer = setTimeout(() => subscriber.complete(), MAX_DURATION_MS);
      durationTimer.unref?.();

      this.agentWs
        .startLogStream(serverId, { target, tail: opts.tail, follow: opts.follow }, {
          onChunk: (chunk) => subscriber.next({ chunk }),
          onExit: (exitCode) => {
            subscriber.next({ exitCode });
            subscriber.complete();
          },
        })
        .then((id) => {
          streamId = id;
          if (torndown) this.agentWs.stopLogStream(serverId, id); // client already left mid-start
        })
        .catch((err) => subscriber.error(err));

      // Runs on unsubscribe (SSE client disconnect), complete, and error.
      return teardown;
    });
  }
}

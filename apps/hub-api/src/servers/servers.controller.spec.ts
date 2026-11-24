import { Subject } from "rxjs";
import { ServersController } from "./servers.controller";
import type { ServersService } from "./servers.service";
import type { ServerTeamTransferService } from "./server-team-transfer.service";
import type { MetricsService } from "../metrics/metrics.service";
import type { MetricsLiveService } from "../metrics/metrics-live.service";
import type { ContainerMetricsService } from "../metrics/container-metrics.service";

describe("ServersController.streamMetrics", () => {
  function build() {
    const samples = new Subject<unknown>();
    const moved = new Subject<string>();
    const servers = { getForUser: jest.fn().mockResolvedValue({ id: "srv1" }), teamChanged$: () => moved.asObservable() };
    const live = { subscribe: jest.fn(() => samples.asObservable()) };
    const ctrl = new ServersController(
      servers as unknown as ServersService,
      {} as ServerTeamTransferService,
      {} as MetricsService,
      live as unknown as MetricsLiveService,
      {} as ContainerMetricsService,
    );
    return { ctrl, samples, moved, servers };
  }

  it("authorizes once, forwards samples, and completes when its own server changes team", async () => {
    const { ctrl, samples, moved, servers } = build();
    const got: string[] = [];
    let done = false;
    ctrl.streamMetrics({ userId: "u1" } as never, "srv1").subscribe({ next: (e) => got.push(String(e.data)), complete: () => (done = true) });
    await new Promise((r) => setImmediate(r));
    expect(servers.getForUser).toHaveBeenCalledWith("u1", "srv1");
    samples.next({ cpu: 1 });
    expect(got).toEqual([JSON.stringify({ cpu: 1 })]);

    moved.next("other-server");
    expect(done).toBe(false);
    moved.next("srv1");
    expect(done).toBe(true);
    samples.next({ cpu: 2 });
    expect(got).toHaveLength(1);
  });
});

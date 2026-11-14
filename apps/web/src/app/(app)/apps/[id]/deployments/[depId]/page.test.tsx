import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../../../i18n/provider";
import { ConfirmProvider } from "../../../../../../components/confirm";
import { ApiError, api } from "../../../../../../lib/api";
import type { Application, DeploymentDetail } from "../../../../../../lib/types";
import DeploymentDetailPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "app1", depId: "d2" }), useRouter: () => ({ push: nav.push }) }));
vi.mock("../../../../../../components/toast", () => ({ useToast: () => vi.fn() }));

afterEach(cleanup);
let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <DeploymentDetailPage />
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const app = { id: "app1", name: "shop", canWrite: true, gitUrl: "https://github.com/acme/shop.git", source: "GIT" } as unknown as Application;
const dep = (over: Partial<DeploymentDetail> = {}): DeploymentDetail => ({
  id: "d2",
  appId: "app1",
  status: "SUCCESS",
  kind: "DEPLOY",
  logs: "Cloning…\nTUGRA_COMMIT=abc1234def\nTUGRA_ROLLOUT: healthy\nUp\n",
  exitCode: 0,
  imageTag: "tugra_app1:d2",
  registryImage: null,
  imageDigest: null,
  rollbackable: true,
  durationMs: 8000,
  trigger: "webhook",
  commitSha: "abc1234def5678",
  commitMessage: "fix checkout",
  configChanges: [{ field: "memoryMb", kind: "changed", before: "256", after: "512" }],
  createdAt: "2026-11-14T10:00:00.000Z",
  startedAt: "2026-11-14T10:00:02.000Z",
  noCache: false,
  rollout: "healthy",
  hasLogs: true,
  diffBase: { id: "d1", createdAt: "2026-11-13T09:00:00.000Z" },
  isCurrent: true,
  cancellable: false,
  finishedAt: "2026-11-14T10:00:10.000Z",
  actor: { kind: "webhook", name: null },
  note: null,
  ...over,
});

describe("DeploymentDetailPage", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(api, "getApp").mockResolvedValue(app);
    vi.spyOn(api, "getDeployment").mockResolvedValue(dep());
    vi.spyOn(api, "cancelDeployment").mockResolvedValue({} as never);
    vi.spyOn(api, "rollbackApp").mockResolvedValue({ id: "d9", status: "RUNNING" } as never);
    nav.push.mockClear();
    vi.spyOn(api, "analyzeDeployment").mockResolvedValue({ analysis: "the build ran out of memory" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("lazy-loads ONE deployment and shows timeline, actor, commit link, config diff, rollout chip and the full log", async () => {
    wrap();
    expect(await screen.findByText("fix checkout")).toBeTruthy();
    expect(api.getDeployment).toHaveBeenCalledWith("app1", "d2");
    // timeline: three steps with the derived queue wait + run time
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText(/waited 2s in the queue/)).toBeTruthy();
    expect(screen.getByText(/ran for 8s/)).toBeTruthy();
    // actor + trigger
    expect(screen.getByText("Git webhook")).toBeTruthy();
    // commit links to the repo's commit page (https only, via gitWebUrls)
    const link = screen.getByTitle("Open commit") as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/acme/shop/commit/abc1234def5678");
    // config diff against the stated base
    expect(screen.getByText(/Compared with the deployment of/)).toBeTruthy();
    expect(screen.getByText("memoryMb")).toBeTruthy();
    // hub-parsed rollout chip + current-version badge
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Current version")).toBeTruthy();
    // full log in the terminal pane (raw by default), markers hidden only when Cleaned is chosen
    expect(screen.getByText(/TUGRA_COMMIT=abc1234def/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cleaned" }));
    expect(screen.queryByText(/TUGRA_COMMIT=/)).toBeNull();
    // the current version offers no rollback; a SUCCESS offers no AI analysis
    expect(screen.queryByRole("button", { name: "Roll back to this version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Analyze with AI" })).toBeNull();
  });

  it("an older rollbackable deploy offers Roll back (confirm → api.rollbackApp); a FAILED one offers AI analysis and shows the result", async () => {
    vi.spyOn(api, "getDeployment").mockResolvedValue(dep({ isCurrent: false, status: "FAILED", exitCode: 1, rollbackable: false }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Analyze with AI" }));
    expect(await screen.findByText("the build ran out of memory")).toBeTruthy();
    cleanup();
    vi.spyOn(api, "getDeployment").mockResolvedValue(dep({ isCurrent: false }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Roll back to this version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.rollbackApp).toHaveBeenCalledWith("app1", "d2"));
    // the rollback is a NEW deployment → navigate to it
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apps/app1/deployments/d9"));
  });

  it("a RUNNING deploy whose live stream has nothing to follow (hub restarted / recovering) says so instead of claiming to follow", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, body: null } as unknown as Response);
    vi.spyOn(api, "getDeployment").mockResolvedValue(dep({ status: "RUNNING", exitCode: null, durationMs: null, finishedAt: null, logs: null, hasLogs: false, rollbackable: false, isCurrent: false, cancellable: true, rollout: null, note: "recovering" }));
    wrap();
    expect(await screen.findAllByText(/No live log is available for this run/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Live — following the build/)).toBeNull());
    expect(screen.getByText(/hub lost its connection to the agent/)).toBeTruthy();
  });

  it("a failed background poll keeps the loaded view (no ErrorState flash while a deploy is running)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, body: null } as unknown as Response);
    const running = dep({ status: "RUNNING", exitCode: null, durationMs: null, finishedAt: null, logs: null, hasLogs: false, rollbackable: false, isCurrent: false, cancellable: true, rollout: null });
    vi.spyOn(api, "getDeployment").mockResolvedValueOnce(running).mockRejectedValue(new ApiError(502, "hub restarting"));
    wrap();
    expect(await screen.findByRole("button", { name: "Cancel deploy" })).toBeTruthy();
    await qc.refetchQueries({ queryKey: ["deployment", "app1", "d2"] }).catch(() => undefined);
    await waitFor(() => expect(api.getDeployment).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Cancel deploy" })).toBeTruthy(); // still the detail view
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("an interrupted deploy shows the honest note and never offers a rollback to it", async () => {
    vi.spyOn(api, "getDeployment").mockResolvedValue(dep({ status: "FAILED", exitCode: -1, rollbackable: false, isCurrent: false, note: "interrupted", rollout: null, logs: "Deployment interrupted: the hub restarted…" }));
    wrap();
    expect(await screen.findByText(/hub restarted while this deploy was in progress/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Roll back to this version" })).toBeNull();
  });

  it("a RUNNING deploy that is cancellable offers Cancel (→ api.cancelDeployment) and shows the live-follow state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, body: null } as unknown as Response); // no live stream in tests
    vi.spyOn(api, "getDeployment").mockResolvedValue(dep({ status: "RUNNING", exitCode: null, durationMs: null, finishedAt: null, logs: null, hasLogs: false, rollbackable: false, isCurrent: false, cancellable: true, rollout: null }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel deploy" }));
    await waitFor(() => expect(api.cancelDeployment).toHaveBeenCalledWith("app1", "d2"));
    // the SSE fetch was refused in this test → the pane never claims to be following
    await waitFor(() => expect(screen.getAllByText(/No live log is available for this run/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Live — following the build/)).toBeNull();
    expect(screen.getByText("in progress")).toBeTruthy(); // the Finished step is active
  });

  it("404 / 403 from the hub render the not-found / forbidden states (ApiError status, never message sniffing); other errors show the generic error", async () => {
    vi.spyOn(api, "getDeployment").mockRejectedValue(new ApiError(404, "deployment not found"));
    wrap();
    expect(await screen.findByText(/does not exist or belongs to another app/)).toBeTruthy();
    expect(api.getDeployment).toHaveBeenCalledTimes(1); // a 404 is not retried
    cleanup();
    vi.spyOn(api, "getDeployment").mockRejectedValue(new ApiError(403, "Forbidden"));
    wrap();
    expect(await screen.findByText(/need write access/)).toBeTruthy();
    cleanup();
    const plain = vi.spyOn(api, "getDeployment").mockRejectedValue(new Error("deployment 404 not found at all")); // a message is never a status
    plain.mockClear();
    wrap();
    // a non-HTTP failure is retried (twice, with backoff) before the generic error with a retry button appears
    expect(await screen.findByRole("button", { name: "Try again" }, { timeout: 12_000 })).toBeTruthy();
    expect(plain).toHaveBeenCalledTimes(3);
  }, 20_000);
});

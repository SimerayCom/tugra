import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import type { Application, Deployment, DeploymentDetail } from "../../../../lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("../../../../components/toast", () => ({ useToast: () => vi.fn() }));

import { DeploymentsTab } from "./app-detail-tabs";
import { DeploymentDetailView } from "./deployment-detail";

afterEach(cleanup);

const dep = (id: string, status: Deployment["status"]): Deployment =>
  ({ id, status, kind: "DEPLOY", logs: null, exitCode: null, imageTag: null, registryImage: null, imageDigest: null, rollbackable: false, createdAt: "2026-11-15T10:00:00Z" }) as Deployment;

describe("DeploymentsTab status spinner", () => {
  it("spins on RUNNING and QUEUED rows only", () => {
    const app = { id: "a1", canWrite: false } as unknown as Application;
    render(
      <I18nProvider>
        <DeploymentsTab app={app} deployments={[dep("d1", "RUNNING"), dep("d2", "QUEUED"), dep("d3", "SUCCESS"), dep("d4", "FAILED")]} cancelPending={false} deployPending={false} onDeploy={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>,
    );
    const rows = screen.getAllByRole("link");
    const spun = rows.map((r) => r.querySelector('[data-testid="activity-spinner"]') !== null);
    expect(spun).toEqual([true, true, false, false]);
  });
});

const detail = (over: Partial<DeploymentDetail>): DeploymentDetail =>
  ({
    ...dep("d1", "SUCCESS"),
    appId: "a1",
    diffBase: null,
    isCurrent: false,
    cancellable: false,
    finishedAt: null,
    actor: { kind: "system", name: null },
    note: null,
    ...over,
  }) as DeploymentDetail;

const view = (d: DeploymentDetail, live: { lines: string; done: boolean } | null = null) =>
  render(
    <I18nProvider>
      <DeploymentDetailView
        app={{ canWrite: false, gitUrl: null, move: null } as unknown as Parameters<typeof DeploymentDetailView>[0]["app"]}
        d={d}
        live={live}
        pending={{ cancel: false, rollback: false, analyze: false }}
        onCancel={vi.fn()}
        onRollback={vi.fn()}
        onAnalyze={vi.fn()}
      />
    </I18nProvider>,
  );

describe("DeploymentDetailView", () => {
  it("shows the spinner next to a RUNNING status and not on a finished one", () => {
    view(detail({ status: "RUNNING", logs: null }), { lines: "step 1\n", done: false });
    expect(screen.getByTestId("activity-spinner")).toBeTruthy();
    cleanup();
    view(detail({ status: "SUCCESS", logs: "ok" }));
    expect(screen.queryByTestId("activity-spinner")).toBeNull();
  });

  it("tints ERROR and WARN build-log lines and leaves ordinary lines alone", () => {
    view(detail({ status: "FAILED", logs: "Step 1/3 : FROM node\nWARN deprecated flag\nERROR: build failed\nno errors found here" }));
    const err = screen.getByText(/ERROR: build failed/);
    const warn = screen.getByText(/WARN deprecated flag/);
    expect(err.getAttribute("data-level")).toBe("error");
    expect(warn.getAttribute("data-level")).toBe("warn");
    expect(screen.getByText(/Step 1\/3/).getAttribute("data-level")).toBeNull();
    expect(screen.getByText(/no errors found here/).getAttribute("data-level")).toBeNull();
  });
});

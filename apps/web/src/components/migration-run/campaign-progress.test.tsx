import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { WaveRow } from "./campaign-progress";
import type { CampaignRunRow } from "../../lib/migration-run";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

afterEach(cleanup);

const row = (over: Partial<CampaignRunRow> = {}): CampaignRunRow => ({
  id: "run-aaaa1111", teamId: "t-a", status: "COMPLETED", currentStep: null, mode: "copy", topology: "two-box", dryRun: false, inPlace: true,
  sourceHost: null, targetNames: ["box-1"], targetCount: 1, estimatedSec: null, measuredSec: null,
  items: { moved: 2, skipped: 130, acked: 0, failed: 0, notCutOver: 0 }, failure: null, problemItems: [], createdAt: "2026-11-25T10:00:00.000Z",
  ...over,
});

const wrap = (r: CampaignRunRow) =>
  render(
    <I18nProvider>
      <ul>
        <WaveRow row={r} view={undefined} count={1} wave={false} />
      </ul>
    </I18nProvider>,
  );

describe("WaveRow apps switched", () => {
  // Interim until the importer scopes its skipped list to the run (finding 10): the whole session's other tasks come in as skipped.
  it("a same-machine run counts only what its own server moved, not the skipped rest of the session", () => {
    wrap(row());
    expect(screen.getByText("2 of 2 apps switched")).toBeTruthy();
    expect(screen.queryByText(/of 132/)).toBeNull();
  });
});

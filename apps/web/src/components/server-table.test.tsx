import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { ServerTable, SERVER_PAGE_SIZE } from "./server-table";
import type { ServerView, ServerStatus } from "../lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

// 25-100 rows of icons and bars are slow to render and query in jsdom; leave headroom on a busy CI box.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanup);

const mk = (over: Partial<ServerView> & { id: string; name: string }): ServerView =>
  ({
    status: "ONLINE",
    teamId: "t1",
    clusterId: null,
    clusterName: null,
    hostname: `${over.name}.example.com`,
    publicIp: null,
    publicIpv6: null,
    tags: [],
    canWrite: true,
    lastSeenAt: null,
    ...over,
  }) as unknown as ServerView;

const teams = [{ id: "t1", name: "Alpha" }, { id: "t2", name: "Beta" }];

const renderTable = (servers: ServerView[], props: { status?: ServerStatus | null; onStatusChange?: (s: ServerStatus | null) => void; initialPageSize?: number } = {}) =>
  render(
    <I18nProvider>
      <ServerTable servers={servers} teams={teams} {...props} />
    </I18nProvider>,
  );

/** Server names in on-screen row order (name link is the first link of each data row). Plain DOM queries: role queries
 *  re-compute accessibility for every element and made 55-row pages crawl in jsdom. */
const order = () =>
  [...document.querySelectorAll("tbody tr.row-link")].map((r) => r.querySelector("a")?.textContent ?? "");

const fleet = [
  mk({ id: "1", name: "charlie", status: "OFFLINE", teamId: "t2", lastSeenAt: "2026-01-01T00:00:00Z" }),
  mk({ id: "2", name: "alpha", status: "ONLINE", teamId: "t1", lastSeenAt: "2026-03-01T00:00:00Z" }),
  mk({ id: "3", name: "bravo", status: "PENDING", teamId: "t1", lastSeenAt: null, canWrite: false }),
];

describe("ServerTable sorting", () => {
  it("toggles aria-sort and reorders: text asc first, then desc; resets other columns", () => {
    renderTable(fleet);
    const nameTh = screen.getByRole("columnheader", { name: /^Server/ });
    expect(nameTh).toHaveAttribute("scope", "col");
    expect(nameTh).toHaveAttribute("aria-sort", "none");
    expect(order()).toEqual(["charlie", "alpha", "bravo"]);

    fireEvent.click(within(nameTh).getByRole("button", { name: "Server" }));
    expect(nameTh).toHaveAttribute("aria-sort", "ascending");
    expect(order()).toEqual(["alpha", "bravo", "charlie"]);

    fireEvent.click(within(nameTh).getByRole("button", { name: "Server" }));
    expect(nameTh).toHaveAttribute("aria-sort", "descending");
    expect(order()).toEqual(["charlie", "bravo", "alpha"]);

    const teamTh = screen.getByRole("columnheader", { name: "Team" });
    fireEvent.click(within(teamTh).getByRole("button"));
    expect(teamTh).toHaveAttribute("aria-sort", "ascending");
    expect(nameTh).toHaveAttribute("aria-sort", "none");
    // Alpha team (alpha, bravo — stable, original order) before Beta (charlie)
    expect(order()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("numeric columns sort descending on first click and sink empty values", () => {
    renderTable(fleet);
    const th = screen.getByRole("columnheader", { name: "Last seen" });
    fireEvent.click(within(th).getByRole("button"));
    expect(th).toHaveAttribute("aria-sort", "descending");
    expect(order()).toEqual(["alpha", "charlie", "bravo"]); // newest first, never-seen last
    fireEvent.click(within(th).getByRole("button"));
    expect(th).toHaveAttribute("aria-sort", "ascending");
    expect(order()).toEqual(["charlie", "alpha", "bravo"]); // never-seen still last
  });

  it("sorts by status from the status control", () => {
    renderTable(fleet);
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(order()).toEqual(["alpha", "bravo", "charlie"]); // ONLINE, PENDING, OFFLINE
  });

  it("sorting applies to the status-filtered set", () => {
    renderTable([...fleet, mk({ id: "4", name: "zulu", status: "OFFLINE" })], { status: "OFFLINE" });
    fireEvent.click(screen.getByRole("button", { name: "Server" }));
    fireEvent.click(screen.getByRole("button", { name: "Server" }));
    expect(order()).toEqual(["zulu", "charlie"]);
  });
});

describe("ServerTable text filter", () => {
  it("narrows rows by name/host case-insensitively and shows the no-results state with a clear action", () => {
    const onStatusChange = vi.fn();
    renderTable(fleet, { onStatusChange });
    const box = screen.getByRole("searchbox", { name: "Search servers…" });
    fireEvent.change(box, { target: { value: "BRA" } });
    expect(order()).toEqual(["bravo"]);

    fireEvent.change(box, { target: { value: "nothing-matches" } });
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.queryByText("No servers yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(box).toHaveValue("");
    expect(onStatusChange).toHaveBeenCalledWith(null);
    expect(order()).toHaveLength(3);
  });

  it("keeps the add-server CTA only when there are zero servers", () => {
    renderTable([]);
    expect(screen.getByText("No servers yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add a server/ })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("ServerTable select-all + accessible names", () => {
  it("every row checkbox is named after its server; header select-all toggles indeterminate/all (writable only)", () => {
    renderTable(fleet);
    for (const n of ["charlie", "alpha", "bravo"]) expect(screen.getByRole("checkbox", { name: `Select ${n}` })).toBeInTheDocument();

    const all = screen.getByRole("checkbox", { name: "Select all servers on this page" }) as HTMLInputElement;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select alpha" }));
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);

    fireEvent.click(all);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    expect(screen.getByRole("checkbox", { name: "Select charlie" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select bravo" })).not.toBeChecked(); // read-only row never selected
    expect(screen.getByText("2 selected")).toBeInTheDocument(); // bulk bar counts writable only

    fireEvent.click(all);
    expect(all.checked).toBe(false);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("bulk bar still reports skipped read-only servers for a manual selection", () => {
    renderTable(fleet);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select alpha" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});

describe("ServerTable pagination", () => {
  // The default page is bigger (100); these tests page a small set through an explicit size to keep jsdom quick.
  const PAGE = 25;
  const big = Array.from({ length: PAGE * 2 + 5 }, (_, i) => mk({ id: `s${i}`, name: `srv-${String(i).padStart(3, "0")}` }));

  it("pages the set, hides the pager for a single page, and the pager buttons are real buttons", () => {
    renderTable(big, { initialPageSize: PAGE });
    expect(order()).toHaveLength(PAGE);
    expect(order()[0]).toBe("srv-000");
    const nav = screen.getByRole("navigation", { name: "Server list pages" });
    expect(within(nav).getByText("Page 1 of 3")).toHaveAttribute("aria-current", "page");
    const prev = within(nav).getByRole("button", { name: "Previous page" });
    const next = within(nav).getByRole("button", { name: "Next page" });
    expect(prev).toHaveAttribute("aria-disabled", "true");

    next.focus();
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(order()[0]).toBe(`srv-${String(PAGE).padStart(3, "0")}`);
    expect(within(nav).getByText("Page 2 of 3")).toBeInTheDocument();
    expect(within(nav).getByRole("status")).toHaveTextContent(`${PAGE + 1}–${PAGE * 2} of ${big.length}`);

    fireEvent.click(next);
    expect(order()).toHaveLength(5);
    // Boundary: aria-disabled (not disabled) so focus is never dropped to <body>.
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).not.toBeDisabled();
    expect(nav.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(next);
    fireEvent.click(next); // no-op at the boundary
    expect(within(nav).getByText("Page 3 of 3")).toBeInTheDocument();
    fireEvent.click(prev);
    expect(within(nav).getByText("Page 2 of 3")).toBeInTheDocument();
  });

  it("no pager for a small fleet; a text filter returns to page 1 and re-pages the matches", () => {
    const { unmount } = renderTable(fleet);
    expect(screen.queryByRole("navigation", { name: "Server list pages" })).toBeNull();
    unmount();

    renderTable(big, { initialPageSize: PAGE });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "srv-05" } });
    expect(order()).toEqual(["srv-050", "srv-051", "srv-052", "srv-053", "srv-054"]);
    expect(screen.queryByRole("navigation", { name: "Server list pages" })).toBeNull();
  });

  it("selection persists across pages; select-all is scoped to the visible page", () => {
    renderTable(big, { initialPageSize: PAGE });
    fireEvent.click(screen.getByLabelText("Select all servers on this page"));
    expect(screen.getByText(`${PAGE} selected`)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Next page"));
    const all = screen.getByLabelText("Select all servers on this page") as HTMLInputElement;
    expect(all.checked).toBe(false); // page 2 untouched
    fireEvent.click(all);
    expect(screen.getByText(`${PAGE * 2} selected`)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Previous page"));
    expect((screen.getByLabelText("Select all servers on this page") as HTMLInputElement).checked).toBe(true);
  });
});

describe("ServerTable a11y details", () => {
  it("Server th reports aria-sort only for the name sort; status button carries its own state", () => {
    renderTable(fleet);
    const nameTh = screen.getByRole("columnheader", { name: /^Server/ });
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(nameTh).toHaveAttribute("aria-sort", "none");
    const statusBtn = within(nameTh).getByRole("button", { name: /Status/ });
    expect(statusBtn).toHaveAttribute("aria-pressed", "true");
    expect(statusBtn).toHaveTextContent("(sorted ascending)");
    fireEvent.click(statusBtn);
    expect(statusBtn).toHaveTextContent("(sorted descending)");
    fireEvent.click(within(nameTh).getByRole("button", { name: "Server" }));
    expect(nameTh).toHaveAttribute("aria-sort", "ascending");
    expect(statusBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("always announces the match count in a polite status region", () => {
    renderTable(fleet);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("3 of 3 servers");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bra" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 of 3 servers");
  });

  it("Clear filters hands focus to the search box", () => {
    renderTable(fleet);
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "nothing-matches" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(document.activeElement).toBe(box);
  });
});

describe("ServerTable list overhaul", () => {
  const trendRow = (id: string, cpu: number, mem: number | null) => ({ serverId: id, points: [{ ts: 1, cpu: 5, mem: 5 }, { ts: 2, cpu, mem }] });
  const rowOf = (name: string) => screen.getByRole("link", { name }).closest("tr") as HTMLElement;

  it("shows real CPU/RAM bars from the newest trend sample, and a dash without data", () => {
    const servers = [mk({ id: "1", name: "alpha" }), mk({ id: "2", name: "bravo" })];
    render(
      <I18nProvider>
        <ServerTable servers={servers} teams={teams} trends={new Map([["1", trendRow("1", 42, 63)]])} />
      </I18nProvider>,
    );
    const bars = within(rowOf("alpha")).getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["42", "63"]);
    expect(within(rowOf("alpha")).getByText("42%")).toBeInTheDocument();
    expect(within(rowOf("bravo")).queryByRole("progressbar")).toBeNull();
    expect(within(rowOf("bravo")).getByLabelText("No recent data")).toBeInTheDocument();
  });

  it("access column shows granted capabilities on and the rest off, in text as well as icon", () => {
    renderTable([mk({ id: "1", name: "alpha", capabilities: ["deploy", "terminal", "files"] })]);
    const row = rowOf("alpha");
    const on = (cap: string) => row.querySelector(`[data-cap="${cap}"]`)?.getAttribute("data-on");
    expect([on("terminal"), on("files"), on("files_write"), on("swarm")]).toEqual(["true", "true", "false", "false"]);
    expect(within(row).getAllByText("Terminal on")[0]).toBeInTheDocument();
    expect(within(row).getAllByText("Swarm off")[0]).toBeInTheDocument();
  });

  it("liveness dot: online with a quiet agent reads as not responding, and the team shows with its name", () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    renderTable([mk({ id: "1", name: "alpha", lastSeenAt: old }), mk({ id: "2", name: "bravo", status: "PENDING" }), mk({ id: "3", name: "delta", status: "OFFLINE" })]);
    expect(within(rowOf("alpha")).getByRole("img", { name: "Not responding" })).toBeInTheDocument();
    expect(within(rowOf("bravo")).getByRole("img", { name: "Waiting to connect" })).toBeInTheDocument();
    expect(within(rowOf("delta")).getByRole("img", { name: "Offline" })).toBeInTheDocument();
    expect(within(rowOf("alpha")).getByText("Alpha")).toBeInTheDocument();
  });

  it("last seen is never negative: a timestamp ahead of the browser clock reads just now", () => {
    renderTable([mk({ id: "1", name: "alpha", lastSeenAt: new Date(Date.now() + 30_000).toISOString() })]);
    expect(within(rowOf("alpha")).getByText("just now")).toBeInTheDocument();
  });

  it("filters by team and groups rows under a team header", () => {
    renderTable(fleet);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by team" }), { target: { value: "t2" } });
    expect(order()).toEqual(["charlie"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by team" }), { target: { value: "__all__" } });
    fireEvent.click(screen.getByRole("button", { name: "Group by team" }));
    const groups = screen.getAllByTestId("team-group-row");
    expect(groups.map((g) => g.textContent)).toEqual(["Alpha2", "Beta1"]);
    expect(order()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("page size is selectable", () => {
    const big = Array.from({ length: 30 }, (_, i) => mk({ id: `p${i}`, name: `srv-${String(i).padStart(3, "0")}` }));
    renderTable(big);
    expect(order()).toHaveLength(30);
    expect(SERVER_PAGE_SIZE).toBe(100);
    fireEvent.change(screen.getByRole("combobox", { name: "Per page" }), { target: { value: "25" } });
    expect(order()).toHaveLength(25);
  });

  it("quick actions respect permissions and capabilities", () => {
    const onUpdateAgent = vi.fn();
    const servers = [
      mk({ id: "1", name: "alpha", capabilities: ["deploy", "terminal"], agentVersion: "0.1.0-beta.26" }),
      mk({ id: "2", name: "bravo", capabilities: ["deploy"] }), // terminal not granted
      mk({ id: "3", name: "charlie", canWrite: false, capabilities: ["deploy", "terminal"] }), // read-only
    ];
    render(
      <I18nProvider>
        <ServerTable servers={servers} teams={teams} agentTarget="0.1.0-beta.27" onUpdateAgent={onUpdateAgent} />
      </I18nProvider>,
    );
    const alpha = rowOf("alpha");
    expect(within(alpha).getByRole("link", { name: "Open terminal" })).toHaveAttribute("href", "/servers/1?tab=shell");
    expect(within(alpha).getByRole("link", { name: "Restart (opens Maintenance)" })).toHaveAttribute("href", "/servers/1?tab=maintenance");
    expect(alpha.querySelector('[data-agent-state="outdated"]')).not.toBeNull();
    fireEvent.click(within(alpha).getByRole("button", { name: "Update agent" }));
    expect(onUpdateAgent).toHaveBeenCalledWith(servers[0]);

    const bravo = rowOf("bravo");
    expect(within(bravo).queryByRole("link", { name: "Open terminal" })).toBeNull();
    expect(within(bravo).getByRole("img", { name: "Terminal is off for this server" })).toBeInTheDocument();

    const charlie = rowOf("charlie");
    expect(within(charlie).queryByRole("button", { name: "Update agent" })).toBeNull();
    expect(within(charlie).queryByRole("link", { name: "Open terminal" })).toBeNull();
    expect(within(charlie).queryByRole("link", { name: /Restart/ })).toBeNull();
  });
});

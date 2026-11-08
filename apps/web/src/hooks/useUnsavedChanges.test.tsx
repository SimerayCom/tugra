import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "../components/confirm";
import { useUnsavedChanges, useLeaveGuard, hasUnsavedChanges } from "./useUnsavedChanges";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Card({ dirty }: { dirty: boolean }) {
  useUnsavedChanges(dirty);
  return <span>card</span>;
}

function Nav({ onGo }: { onGo: () => void }) {
  const guard = useLeaveGuard();
  return <button onClick={() => guard(onGo)}>switch</button>;
}

const wrap = (ui: React.ReactNode) =>
  render(
    <I18nProvider>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </I18nProvider>,
  );

const beforeUnload = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e;
};

describe("useUnsavedChanges: beforeunload", () => {
  it("adds the native prompt while dirty and removes it when clean", () => {
    const { rerender } = wrap(<Card dirty={false} />);
    expect(beforeUnload().defaultPrevented).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);

    rerender(
      <I18nProvider><ConfirmProvider><Card dirty /></ConfirmProvider></I18nProvider>,
    );
    expect(hasUnsavedChanges()).toBe(true);
    expect(beforeUnload().defaultPrevented).toBe(true);

    rerender(
      <I18nProvider><ConfirmProvider><Card dirty={false} /></ConfirmProvider></I18nProvider>,
    );
    expect(hasUnsavedChanges()).toBe(false);
    expect(beforeUnload().defaultPrevented).toBe(false);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = wrap(<Card dirty />);
    expect(beforeUnload().defaultPrevented).toBe(true);
    unmount();
    expect(beforeUnload().defaultPrevented).toBe(false);
  });

  it("aggregates: any dirty card guards, and it stays guarded until the last one is clean", () => {
    wrap(<><Card dirty /><Card dirty /></>);
    const a = render(<Card dirty />);
    a.unmount();
    expect(hasUnsavedChanges()).toBe(true);
    cleanup();
    expect(hasUnsavedChanges()).toBe(false);
  });
});

describe("useUnsavedChanges: in-app navigation", () => {
  const link = () => screen.getByText("go");

  it("asks via the confirm dialog when dirty, and navigates only after confirming", async () => {
    const clicked = vi.fn();
    wrap(
      <>
        <Card dirty />
        <a href="/elsewhere" onClick={(e) => { e.preventDefault(); clicked(); }}>go</a>
      </>,
    );
    fireEvent.click(link());
    expect(clicked).not.toHaveBeenCalled(); // intercepted
    expect(await screen.findByText("You have unsaved changes — leave without saving?")).toBeTruthy();

    fireEvent.click(screen.getByText("Leave without saving"));
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1)); // the click is replayed once
  });

  it("stays put when the user cancels", async () => {
    const clicked = vi.fn();
    wrap(
      <>
        <Card dirty />
        <a href="/elsewhere" onClick={(e) => { e.preventDefault(); clicked(); }}>go</a>
      </>,
    );
    fireEvent.click(link());
    fireEvent.click(await screen.findByText("Stay on page"));
    await waitFor(() => expect(screen.queryByText("Stay on page")).toBeNull());
    expect(clicked).not.toHaveBeenCalled();
  });

  it("never prompts when clean", () => {
    const clicked = vi.fn();
    wrap(
      <>
        <Card dirty={false} />
        <a href="/elsewhere" onClick={(e) => { e.preventDefault(); clicked(); }}>go</a>
      </>,
    );
    fireEvent.click(link());
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("You have unsaved changes — leave without saving?")).toBeNull();
  });

  it("ignores same-origin /api links (downloads/endpoints)", () => {
    const seen = vi.fn();
    wrap(
      <>
        <Card dirty />
        <a href="/api/apps/1/backup.tar" onClick={(e) => { e.preventDefault(); seen("api"); }}>api</a>
      </>,
    );
    fireEvent.click(screen.getByText("api"));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("You have unsaved changes — leave without saving?")).toBeNull();
  });

  it("ignores external links, new-tab links and modified clicks", () => {
    const seen = vi.fn();
    wrap(
      <>
        <Card dirty />
        <a href="https://example.org/x" onClick={(e) => { e.preventDefault(); seen("ext"); }}>ext</a>
        <a href="/blank" target="_blank" onClick={(e) => { e.preventDefault(); seen("blank"); }}>blank</a>
        <a href="/mod" onClick={(e) => { e.preventDefault(); seen("mod"); }}>mod</a>
      </>,
    );
    fireEvent.click(screen.getByText("ext"));
    fireEvent.click(screen.getByText("blank"));
    fireEvent.click(screen.getByText("mod"), { metaKey: true });
    expect(seen.mock.calls.map((c) => c[0])).toEqual(["ext", "blank", "mod"]);
  });
});

describe("useLeaveGuard (tab switches)", () => {
  it("runs immediately when clean", () => {
    const go = vi.fn();
    wrap(<><Card dirty={false} /><Nav onGo={go} /></>);
    fireEvent.click(screen.getByText("switch"));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("confirms first when dirty: cancel blocks, confirm proceeds", async () => {
    const go = vi.fn();
    wrap(<><Card dirty /><Nav onGo={go} /></>);
    fireEvent.click(screen.getByText("switch"));
    expect(go).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("Stay on page"));
    await waitFor(() => expect(screen.queryByText("Stay on page")).toBeNull());
    expect(go).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("switch"));
    fireEvent.click(await screen.findByText("Leave without saving"));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
  });

  it("falls back to window.confirm without a ConfirmProvider", async () => {
    const go = vi.fn();
    const spy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<I18nProvider><Card dirty /><Nav onGo={go} /></I18nProvider>);
    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(go).not.toHaveBeenCalled();
  });
});

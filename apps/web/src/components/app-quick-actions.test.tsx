import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AppQuickActions } from "./app-quick-actions";

afterEach(cleanup);

function setup(over: Partial<React.ComponentProps<typeof AppQuickActions>> = {}) {
  const props = {
    canWrite: true,
    running: true,
    locked: false,
    restartPending: false,
    rollbackPending: false,
    canRollback: true,
    onRestart: vi.fn(),
    onRollback: vi.fn(),
    onLogs: vi.fn(),
    ...over,
  };
  render(<I18nProvider><AppQuickActions {...props} /></I18nProvider>);
  return props;
}

describe("AppQuickActions", () => {
  it("offers restart, roll back and logs in a labelled navigation", () => {
    const p = setup();
    expect(screen.getByRole("navigation", { name: "Quick actions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(p.onRestart).toHaveBeenCalledOnce();
    expect(p.onRollback).toHaveBeenCalledOnce();
    expect(p.onLogs).toHaveBeenCalledOnce();
  });

  it("disables rollback with the reason when there is no earlier version", () => {
    setup({ canRollback: false });
    const b = screen.getByRole("button", { name: "Roll back" });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("title", "No earlier version to roll back to");
  });

  it("disables restart for a stopped app and everything write-side during an app move", () => {
    setup({ running: false });
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    cleanup();
    setup({ locked: true, lockTitle: "Moving" });
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Roll back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Logs" })).not.toBeDisabled();
  });

  it("shows only Logs to a read-only member", () => {
    setup({ canWrite: false });
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Logs" })).toBeInTheDocument();
  });
});

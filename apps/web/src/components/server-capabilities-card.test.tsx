import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api } from "../lib/api";
import type { ServerView } from "../lib/types";
import { CAPABILITIES, CapabilitiesCard, toggleCapability } from "./server-capabilities-card";

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

const server = (capabilities: string[]) => ({ id: "s1", capabilities }) as unknown as ServerView;
function mount(capabilities: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const save = vi.spyOn(api, "setServerCapabilities").mockResolvedValue(undefined as never);
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <CapabilitiesCard id="s1" server={server(capabilities)} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return save;
}
const cb = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

describe("toggleCapability", () => {
  it("turning files off also turns files_write off", () => {
    expect([...toggleCapability(new Set(["files", "files_write", "deploy"]), "files")].sort()).toEqual(["deploy"]);
  });
  it("files_write can only be turned on while files is on", () => {
    expect([...toggleCapability(new Set(["deploy"]), "files_write")]).toEqual(["deploy"]);
    expect([...toggleCapability(new Set(["files"]), "files_write")].sort()).toEqual(["files", "files_write"]);
  });
  it("is a pure toggle for every other capability", () => {
    expect([...toggleCapability(new Set(["deploy"]), "backup")].sort()).toEqual(["backup", "deploy"]);
    expect([...toggleCapability(new Set(["deploy", "backup"]), "backup")]).toEqual(["deploy"]);
  });
});

describe("CapabilitiesCard", () => {
  it("lists files and files_write (previously API-only) with their descriptions", () => {
    mount([]);
    expect(CAPABILITIES).toContain("files");
    expect(CAPABILITIES).toContain("files_write");
    expect(cb(/Files \(browse and download\)/)).toBeTruthy();
    expect(cb(/File changes \(upload, edit, delete\)/)).toBeTruthy();
    expect(screen.getByText(/CHOWN, DAC_OVERRIDE and FOWNER, on one volume at a time/)).toBeTruthy();
  });

  it("files_write is disabled until files is checked, and unchecking files unchecks it", () => {
    mount([]);
    const files = cb(/Files \(browse and download\)/);
    const write = cb(/File changes/);
    expect(write.disabled).toBe(true);
    fireEvent.click(files);
    expect(write.disabled).toBe(false);
    fireEvent.click(write);
    expect(write.checked).toBe(true);
    fireEvent.click(files);
    expect(files.checked).toBe(false);
    expect(write.checked).toBe(false);
    expect(write.disabled).toBe(true);
  });

  it("an API-granted files capability shows checked and is preserved on save", async () => {
    const save = mount(["deploy", "files"]);
    expect(cb(/Files \(browse and download\)/).checked).toBe(true);
    expect(cb(/File changes/).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("s1", ["deploy", "files"]));
  });

  it("saves files + files_write together", async () => {
    const save = mount(["deploy"]);
    fireEvent.click(cb(/Files \(browse and download\)/));
    fireEvent.click(cb(/File changes/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("s1", ["deploy", "files", "files_write"]));
  });
});

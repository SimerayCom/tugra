import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { InstallTransportNote } from "./install-transport-note";
import { installTransport } from "../lib/server-install";

const PIN = "sha256:" + "ab".repeat(32);
const IP_CMD = `curl -fsSLk --pinnedpubkey 'sha256//AAAA=' https://203.0.113.7/install/agent.sh | sh -s -- --hub wss://203.0.113.7/agent --hub-pin ${PIN} --token t`;
const PLAIN_CMD = "curl -fsSL http://203.0.113.7:3000/install/agent.sh | sh -s -- --hub ws://203.0.113.7:3000/agent --hub-insecure --token t";
const TLS_CMD = "curl -fsSL https://hub.example.com/install/agent.sh | sh -s -- --hub wss://hub.example.com/agent --token t";

const wrap = (command: string | null) =>
  render(
    <I18nProvider>
      <InstallTransportNote command={command} />
    </I18nProvider>,
  );

describe("installTransport", () => {
  it("reads the transport off the command the hub generated", () => {
    expect(installTransport(IP_CMD)).toBe("pinned");
    expect(installTransport(PLAIN_CMD)).toBe("plain");
    expect(installTransport("... --hub ws://hub-api:3000/agent --token t")).toBe("plain"); // any ws:// is plaintext
    expect(installTransport(TLS_CMD)).toBe("tls");
    expect(installTransport(null)).toBeNull();
  });
});

describe("InstallTransportNote", () => {
  afterEach(cleanup);

  it("warns about a plain ws:// command (an alert)", () => {
    wrap(PLAIN_CMD);
    expect(screen.getByRole("alert").textContent).toMatch(/plain ws:\/\//);
    expect(screen.getByRole("alert").textContent).toMatch(/readable on the network/);
  });

  it("explains a pinned IP command (encrypted, no domain needed)", () => {
    wrap(IP_CMD);
    expect(screen.getByRole("note").textContent).toMatch(/Encrypted/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing for a normal wss:// domain command or no command", () => {
    const a = wrap(TLS_CMD);
    expect(a.container.textContent).toBe("");
    cleanup();
    const b = wrap(null);
    expect(b.container.textContent).toBe("");
  });
});

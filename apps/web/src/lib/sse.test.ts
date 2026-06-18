import { describe, it, expect } from "vitest";
import { parseSseFrames, consumeDeployLogStream, type DeployLogEvent } from "./sse";

describe("parseSseFrames", () => {
  it("parses multiple complete frames and returns the remainder", () => {
    const { events, rest } = parseSseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: half');
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe("data: half");
  });

  it("buffers a partial frame across reads", () => {
    const first = parseSseFrames('data: {"type":"chunk",');
    expect(first.events).toEqual([]);
    expect(first.rest).toBe('data: {"type":"chunk",');
    const second = parseSseFrames(first.rest + '"data":"hi"}\n\n');
    expect(second.events).toEqual(['{"type":"chunk","data":"hi"}']);
    expect(second.rest).toBe("");
  });

  it("preserves newlines inside a JSON-encoded chunk payload", () => {
    const payload = JSON.stringify({ type: "chunk", data: "line1\nline2\n" });
    const { events } = parseSseFrames(`data: ${payload}\n\n`);
    expect(JSON.parse(events[0])).toEqual({ type: "chunk", data: "line1\nline2\n" });
  });
});

function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) {
        controller.enqueue(enc.encode(parts[i++]));
      } else {
        controller.close();
      }
    },
  });
}

describe("consumeDeployLogStream", () => {
  it("emits chunk then done events as they arrive across reads", async () => {
    const chunk = (d: string) => `data: ${JSON.stringify({ type: "chunk", data: d })}\n\n`;
    const done = `data: ${JSON.stringify({ type: "done", status: "SUCCESS", exitCode: 0, deploymentId: "d1" })}\n\n`;
    const body = streamFrom([chunk("build "), chunk("ok\n"), done]);
    const events: DeployLogEvent[] = [];
    await consumeDeployLogStream(body, (e) => events.push(e));
    expect(events).toEqual([
      { type: "chunk", data: "build " },
      { type: "chunk", data: "ok\n" },
      { type: "done", status: "SUCCESS", exitCode: 0, deploymentId: "d1" },
    ]);
  });

  it("ignores malformed frames", async () => {
    const body = streamFrom(["data: not-json\n\n", `data: ${JSON.stringify({ type: "chunk", data: "x" })}\n\n`]);
    const events: DeployLogEvent[] = [];
    await consumeDeployLogStream(body, (e) => events.push(e));
    expect(events).toEqual([{ type: "chunk", data: "x" }]);
  });
});

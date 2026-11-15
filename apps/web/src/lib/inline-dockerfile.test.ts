import { describe, it, expect } from "vitest";
import { INLINE_DOCKERFILE_MAX, inlineDockerfileBytes, inlineDockerfileProblem } from "./inline-dockerfile";

describe("inlineDockerfileProblem (same rules as the hub DTO)", () => {
  it("accepts FROM, ARG-then-FROM, directives/comments/BOM and any case", () => {
    expect(inlineDockerfileProblem("FROM alpine\nRUN echo hi\n")).toBeNull();
    expect(inlineDockerfileProblem("# syntax=docker/dockerfile:1\nARG V=1\nFROM alpine:${V}\n")).toBeNull();
    expect(inlineDockerfileProblem("﻿from alpine\n")).toBeNull();
    expect(inlineDockerfileProblem("ARG A=1 \\\n  B=2\nFROM x\n")).toBeNull();
  });
  it("rejects NUL, a missing/late FROM, comments only, and oversize BYTES", () => {
    expect(inlineDockerfileProblem("FROM a\0b")).toBe("nul");
    expect(inlineDockerfileProblem("RUN echo hi\nFROM x")).toBe("no_from");
    expect(inlineDockerfileProblem("# nothing\n")).toBe("no_from");
    expect(inlineDockerfileProblem("")).toBe("no_from");
    expect(inlineDockerfileProblem("FROM x\n" + "#".repeat(INLINE_DOCKERFILE_MAX))).toBe("too_large");
    expect(inlineDockerfileBytes("é")).toBe(2);
    expect(inlineDockerfileProblem("FROM x\n" + "é".repeat(25000))).toBe("too_large");
  });
});

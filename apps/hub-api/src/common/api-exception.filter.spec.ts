import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { ApiExceptionFilter } from "./api-exception.filter";

function makeFilter() {
  const reply = jest.fn();
  const host = new ApiExceptionFilter({ httpAdapter: { reply } } as unknown as HttpAdapterHost);
  return { host, reply };
}

function httpHost(res: unknown, req: unknown = { method: "GET", url: "/api/v1/x" }): ArgumentsHost {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
}

const freshRes = () => ({ headersSent: false, writableEnded: false, end: jest.fn() });

describe("ApiExceptionFilter", () => {
  it("normalizes an HttpException with a string message (status + reason phrase preserved)", () => {
    const { host, reply } = makeFilter();
    const res = freshRes();
    host.catch(new NotFoundException("no app"), httpHost(res));
    expect(reply).toHaveBeenCalledWith(res, { statusCode: 404, error: "Not Found", message: "no app" }, 404);
  });

  it("keeps a message ARRAY verbatim (field-validation errors from ZodValidationPipe)", () => {
    const { host, reply } = makeFilter();
    const res = freshRes();
    host.catch(new BadRequestException(["name: required", "port: too big"]), httpHost(res));
    const body = reply.mock.calls[0][1];
    expect(body.message).toEqual(["name: required", "port: too big"]);
    expect(body).toMatchObject({ statusCode: 400, error: "Bad Request" });
  });

  it("preserves a custom status code (423 Locked) and fills a missing error field", () => {
    const { host, reply } = makeFilter();
    const res = freshRes();
    host.catch(new HttpException("account locked", 423), httpHost(res));
    expect(reply).toHaveBeenCalledWith(res, { statusCode: 423, error: "Locked", message: "account locked" }, 423);
  });

  it("preserves extra keys on an HttpException body (strict superset) and never remaps the status", () => {
    const { host, reply } = makeFilter();
    const res = freshRes();
    host.catch(new ConflictException({ message: "dup", error: "Conflict", code: "DUPLICATE" }), httpHost(res));
    expect(reply.mock.calls[0][1]).toEqual({ statusCode: 409, error: "Conflict", message: "dup", code: "DUPLICATE" });
    expect(reply.mock.calls[0][2]).toBe(409);
  });

  it("maps a plain Error to a constant, leak-free 500 and logs the real error server-side", () => {
    const spy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { host, reply } = makeFilter();
    const res = freshRes();
    host.catch(new Error("DB connection string postgres://user:secret@host failed"), httpHost(res));
    expect(reply).toHaveBeenCalledWith(res, { statusCode: 500, error: "Internal Server Error", message: "Internal server error" }, 500);
    // the raw (secret-bearing) message must NOT be in the response body…
    expect(JSON.stringify(reply.mock.calls[0][1])).not.toContain("secret");
    // …but it IS logged server-side.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("preserves an exposable 4xx http-errors status (body-parser malformed JSON → 400, not 500)", () => {
    const { host, reply } = makeFilter();
    const res = freshRes();
    host.catch({ status: 400, expose: true, message: "Unexpected token in JSON" }, httpHost(res));
    expect(reply).toHaveBeenCalledWith(res, { statusCode: 400, error: "Bad Request", message: "Unexpected token in JSON" }, 400);
  });

  it("preserves a 413 payload-too-large http-error", () => {
    const { host, reply } = makeFilter();
    const res = freshRes();
    host.catch({ statusCode: 413, expose: true, message: "request entity too large" }, httpHost(res));
    expect(reply.mock.calls[0][2]).toBe(413);
    expect(reply.mock.calls[0][1].error).toBe("Payload Too Large");
  });

  it("does NOT trust a non-exposable or 5xx http-error — falls back to a safe 500", () => {
    const spy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { host, reply } = makeFilter();
    host.catch({ status: 400, expose: false, message: "internal detail" }, httpHost(freshRes()));
    expect(reply.mock.calls[0][2]).toBe(500);
    expect(reply.mock.calls[0][1].message).toBe("Internal server error");
    spy.mockRestore();
  });

  it("writes NO body when headers are already sent (SSE mid-stream) — just ends the response", () => {
    const { host, reply } = makeFilter();
    const res = { headersSent: true, writableEnded: false, end: jest.fn() };
    host.catch(new Error("boom"), httpHost(res));
    expect(res.end).toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("rethrows for a non-http (ws/rpc) context", () => {
    const { host } = makeFilter();
    const wsHost = { getType: () => "ws" } as unknown as ArgumentsHost;
    const err = new Error("ws");
    expect(() => host.catch(err, wsHost)).toThrow(err);
  });
});

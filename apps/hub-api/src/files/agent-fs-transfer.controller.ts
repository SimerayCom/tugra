import { Controller, Get, Header, HttpCode, Param, Put, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { IncomingMessage } from "node:http";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { AllowUnverified } from "../common/allow-unverified.decorator";
import { FsTransferService } from "./fs-transfer.service";

/**
 * The two URLs an AGENT calls to move a file body for the file manager: GET pulls a staged upload, PUT pushes a
 * download. Deliberately UNGUARDED by a user/token (the agent holds neither) — the only credential is the
 * HMAC in the query, which binds transfer id + direction + server + size + hash + a short expiry, and every
 * transfer is single-use. Every failure is a uniform 404, the URL is never logged, and responses are no-store.
 * @CsrfExempt/@AllowUnverified because there is no cookie/user. Excluded from the OpenAPI document.
 */
@ApiExcludeController()
@Controller("agent-fs/t")
@CsrfExempt()
@AllowUnverified()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AgentFsTransferController {
  constructor(private readonly transfers: FsTransferService) {}

  @Get(":id")
  @Header("Cache-Control", "no-store")
  pull(@Param("id") id: string, @Query("exp") exp: string, @Query("sig") sig: string): StreamableFile {
    return this.transfers.serveToAgent(id, exp, sig);
  }

  @Put(":id")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async push(@Param("id") id: string, @Query("exp") exp: string, @Query("sig") sig: string, @Req() req: IncomingMessage): Promise<void> {
    await this.transfers.receiveFromAgent(id, exp, sig, req);
  }
}

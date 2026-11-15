import { Controller, Get, Header, HttpCode, Param, Put, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { IncomingMessage } from "node:http";
import { CsrfExempt } from "../common/csrf-exempt.decorator";
import { AllowUnverified } from "../common/allow-unverified.decorator";
import { VolumeRelayService } from "./volume-relay.service";

/**
 * The two URLs the AGENTS call to move one part of an app move's volume data: PUT = the source agent pushes the part,
 * GET = the target agent pulls it. Deliberately UNGUARDED by a user/token (agents hold neither) — the only credential
 * is the HMAC in the query, which binds relay id + role + server + move/volume/part + exact size + sha256 + a short
 * expiry, and every claim is single-use per role. Every failure is a uniform 404 (a failed hash is 422 to the source),
 * the URL is never logged, and responses are no-store. @CsrfExempt/@AllowUnverified because there is no cookie/user.
 * Excluded from the OpenAPI document.
 */
@ApiExcludeController()
@Controller("agent-vx/t")
@CsrfExempt()
@AllowUnverified()
@Throttle({ default: { limit: 240, ttl: 60_000 } })
export class VolumeRelayController {
  constructor(private readonly relay: VolumeRelayService) {}

  @Get(":id")
  @Header("Cache-Control", "no-store")
  pull(@Param("id") id: string, @Query("exp") exp: string, @Query("sig") sig: string): StreamableFile {
    return this.relay.serveToTarget(id, exp, sig);
  }

  @Put(":id")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async push(@Param("id") id: string, @Query("exp") exp: string, @Query("sig") sig: string, @Req() req: IncomingMessage): Promise<void> {
    await this.relay.receiveFromSource(id, exp, sig, req);
  }
}

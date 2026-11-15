import { UnprocessableEntityException } from "@nestjs/common";

export type DestinationKeyErrorCode = "destination_key_missing" | "destination_key_unavailable" | "backup_key_missing";

/**
 * A backup destination's key (or the secrets key that protects it) cannot be used, so the operation FAILS CLOSED.
 * It is a 422 so the reason reaches the caller (a plain Error would be flattened to a generic 500 by the API
 * exception filter); the message never contains key material. Pure helpers (resolver, script builders) throw it
 * directly, so every service boundary above them maps it without translation.
 */
export class DestinationKeyError extends UnprocessableEntityException {
  constructor(code: DestinationKeyErrorCode, message: string) {
    super({ statusCode: 422, code, message });
  }
}

import { Injectable } from "@nestjs/common";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";

const ISSUER = "Tugra";
// Accept the adjacent 30s steps (±1) to tolerate clock skew between the hub and the app.
const totp = authenticator.clone({ window: 1 });

@Injectable()
export class TotpService {
  generateSecret(): string {
    return totp.generateSecret();
  }

  keyUri(accountName: string, secret: string): string {
    return totp.keyuri(accountName, ISSUER, secret);
  }

  async qrDataUrl(otpauthUri: string): Promise<string> {
    return QRCode.toDataURL(otpauthUri);
  }

  verify(token: string, secret: string): boolean {
    try {
      return totp.verify({ token, secret });
    } catch {
      return false;
    }
  }
}

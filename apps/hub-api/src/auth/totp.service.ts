import { Injectable } from "@nestjs/common";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";

const ISSUER = "Tugra";

@Injectable()
export class TotpService {
  generateSecret(): string {
    return authenticator.generateSecret();
  }

  keyUri(accountName: string, secret: string): string {
    return authenticator.keyuri(accountName, ISSUER, secret);
  }

  async qrDataUrl(otpauthUri: string): Promise<string> {
    return QRCode.toDataURL(otpauthUri);
  }

  verify(token: string, secret: string): boolean {
    try {
      return authenticator.verify({ token, secret });
    } catch {
      return false;
    }
  }
}

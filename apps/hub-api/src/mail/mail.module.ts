import { Global, Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { MailService } from "./mail.service";

// Global so any feature module (auth, teams) can inject MailService without re-importing. CryptoModule:
// the DB-stored SMTP password / Resend key are decrypted inside MailService only.
@Global()
@Module({
  imports: [CryptoModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}

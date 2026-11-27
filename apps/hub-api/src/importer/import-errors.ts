import { BadRequestException, ConflictException } from "@nestjs/common";

// The two answers the import wizard can recover from by itself: it reads the source again (plan changed) or goes back to the connect
// form (session ended). The wording stays the same as before; the stable `code` is what the screen branches on.

/** The import session ran out or was revoked: the owner connects again. */
export const sessionEnded = (): BadRequestException => new BadRequestException({ statusCode: 400, message: "import session expired or revoked — reconnect", code: "session_ended" });

/** The source changed since the plan was shown: the owner reads it again and reviews again. */
export const planChanged = (): ConflictException => new ConflictException({ statusCode: 409, message: "the plan changed since it was previewed — re-run the plan and review again", code: "plan_changed" });

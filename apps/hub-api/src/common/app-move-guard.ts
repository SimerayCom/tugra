import { ConflictException } from "@nestjs/common";
import { APP_MOVE_TERMINAL_PHASES } from "@tugra/shared";

/** AppMove phases in which the move is over (the live-move guards and the one-active-move-per-app index ignore them). */
export const APP_MOVE_TERMINAL = [...APP_MOVE_TERMINAL_PHASES] as ("COMPLETED" | "ROLLED_BACK" | "FAILED")[];

/** The narrow slice of PrismaService / a transaction client the guard needs (keeps callers' specs light). */
export interface AppMoveReader {
  appMove: { findFirst(args: { where: { appId: string; phase: { notIn: ("COMPLETED" | "ROLLED_BACK" | "FAILED")[] } }; select?: { id: true; phase: true } }): Promise<{ id: string; phase: string } | null> };
}

/** 409 `app_move_in_progress`: the app is being moved to another server, so config edits, lifecycle actions, rollback
 *  and volume restore are paused until the move ends (a queued deploy waits and runs afterwards). */
export class AppMoveInProgressException extends ConflictException {
  constructor() {
    super({ statusCode: 409, message: "the app is being moved to another server — this action is paused until the move finishes", code: "app_move_in_progress" });
  }
}

/** The live (non-terminal) move of an app, or null. */
export async function findActiveMove(db: AppMoveReader, appId: string): Promise<{ id: string; phase: string } | null> {
  return db.appMove.findFirst({ where: { appId, phase: { notIn: APP_MOVE_TERMINAL } }, select: { id: true, phase: true } });
}

/** Throw AppMoveInProgressException when the app has a live move. */
export async function assertNoActiveMove(db: AppMoveReader, appId: string): Promise<void> {
  if (await findActiveMove(db, appId)) throw new AppMoveInProgressException();
}

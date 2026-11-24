-- A rescale remembers whether the server was already powered off, so it is not powered on after the move.
ALTER TABLE "ServerRescale" ADD COLUMN "wasOff" BOOLEAN NOT NULL DEFAULT false;

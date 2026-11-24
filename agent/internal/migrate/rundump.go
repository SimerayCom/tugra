package migrate

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"
)

// volumeIngestDump marks a `kind:"volume"` row the hub offers for the STREAMED DATABASE DUMP lane (dest.type "db-dump").
// An older migrator ignores a volumeIngest it does not know, so it never touches such a row.
const volumeIngestDump = "stream-dump"

// isDumpTarget reports a row that moves a database as a streamed dump rather than as a tar of a volume.
func isDumpTarget(tg Target) bool {
	return tg.Kind == "volume" && tg.Dest != nil && tg.Dest.Type == "db-dump"
}

// dumpApplyWait is how long the migrator keeps polling the hub's streaming restore on the target: a fixed floor plus a
// generous per-GiB allowance (a restore rebuilds indexes and is much slower than a copy). The hub has its own, longer budget;
// a timeout here only ends this run's wait, the next run polls the same apply.
func dumpApplyWait(rawBytes int64) time.Duration {
	gib := rawBytes/(1<<30) + 1
	d := 30*time.Minute + time.Duration(gib)*6*time.Minute
	if d > 24*time.Hour {
		d = 24 * time.Hour
	}
	return d
}

// dumpFacts is what resolving one dump row yields.
type dumpFacts struct {
	src    *source
	plan   Plan
	state  string // "" = streamable; else the item state to report
	reason string
}

// inspectDump resolves the database a dump row names (it must be RUNNING: a dump reads through the server), validates its
// credentials and builds the pinned dump plan. It never stops anything: the writers are stopped by the run's FREEZE, the
// database itself stays up.
func (v *volRunner) inspectDump(ctx context.Context, tg Target) dumpFacts {
	var f dumpFacts
	if tg.VolumeIngest == "excluded" {
		f.state, f.reason = "volume-not-migrated", sanitizeReason(tg.Reason)
		return f
	}
	if tg.Dest == nil || tg.DatabaseItemRef == "" || !isDumpEngine(tg.Engine) {
		f.state, f.reason = "failed", "bad-target"
		return f
	}
	parsed := v.parsed[tg.Engine]
	if parsed == nil {
		f.state, f.reason = "skipped", "no-recipe"
		return f
	}
	dbTg := Target{ItemRef: tg.DatabaseItemRef, Kind: "database", Engine: tg.Engine}
	override := v.overrides[tg.ItemRef]
	if override == "" {
		override = v.overrides[tg.DatabaseItemRef]
	}
	src, derr := Resolve(ctx, dbTg, override, v.dockerPath, v.dockerEnv)
	if derr != nil {
		switch {
		case errors.Is(derr, ErrNotRunning):
			f.state, f.reason = "failed", "source-not-running"
		case errors.Is(derr, ErrNotFound):
			f.state, f.reason = "volume-source-missing", "unresolved"
		default:
			f.state, f.reason = discoverOutcome(derr)
		}
		return f
	}
	if prev, dup := v.usedIDs[src.ID+"|dump"]; dup && prev != tg.ItemRef {
		f.state, f.reason = "failed", "duplicate-source"
		return f
	}
	v.usedIDs[src.ID+"|dump"] = tg.ItemRef
	rc, sk := resolveCreds(tg.Engine, src.inspect)
	if sk != nil {
		f.state, f.reason = "skipped", sk.reason
		return f
	}
	v.sc.add(rc.pw)
	v.sc.add(rc.user)
	v.sc.add(rc.db)
	plan, berr := BuildPlan(parsed, Creds{Ctr: src.ID, User: rc.user, DB: rc.db, PW: rc.pw, HasPW: rc.pw != ""}, v.dockerPath, os.LookupEnv)
	if berr != nil {
		f.state, f.reason = "failed", "invalid-name"
		return f
	}
	f.src, f.plan = src, plan
	return f
}

// dumpEstimate is the best size this run knows for a dump row: the counted dump, else the catalog size (an upper-ish bound).
func (v *volRunner) dumpEstimate(tg Target) int64 {
	m, ok := v.sizes[tg.DatabaseItemRef]
	if !ok || m.State != "measured" {
		return 0
	}
	if m.DumpRawBytes != nil {
		return *m.DumpRawBytes
	}
	return m.DbBytes
}

// dryRunDump is the read-only plan of one dump row: it resolves the database and asks the hub whether the target can take
// the transfer. Nothing is stopped or sent.
func (v *volRunner) dryRunDump(ctx context.Context, tg Target) itemResult {
	res := itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine}
	f := v.inspectDump(ctx, tg)
	if f.state != "" {
		res.State, res.Reason = f.state, f.reason
		return res
	}
	est := v.dumpEstimate(tg)
	res.RawBytes = est
	v.logSpoolRoom()
	res.State, res.Reason = "planned", "would-stream-dump"
	if est > 0 {
		d, err := v.hub.VxDiskCheck(ctx, tg.ItemRef, v.runID, &est)
		switch {
		case err != nil:
			res.Disk = "unknown"
			v.logf("disk-check %s: %v", tg.ItemRef, err)
		case d.Unknown:
			res.Disk = "unknown"
		case !d.OK:
			res.Disk = "short"
			res.State, res.Reason = "volume-disk-insufficient", "target-disk"
		default:
			res.Disk = "ok"
		}
	}
	return res
}

// runDump streams ONE database dump end to end: claim the transfer, dump through the relay, re-prove the source is the same
// container, finish, then wait for the target's streaming restore. A run that dies before the last commit leaves staged parts
// the next run's `begin` discards (a dump cannot resume from the middle); after COPIED only the restore remains.
func (v *volRunner) runDump(ctx context.Context, tg Target) (res itemResult) {
	res = itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine}
	leased, copied := false, false
	defer func() {
		if rec := recover(); rec != nil {
			res.State, res.Reason = "failed", "internal"
		}
		if leased && !copied { // any exit before COPIED releases the lease (see runOne): a failed dump's rerun must not wait it out
			actx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_ = v.hub.VxAbort(actx, tg.ItemRef, v.runID)
			cancel()
		}
	}()

	f := v.inspectDump(ctx, tg)
	if f.state != "" {
		res.State, res.Reason = f.state, f.reason
		return res
	}
	defer cleanupDumpLeftovers(tg.Engine, f.src.ID, v.dockerPath, v.dockerEnv)
	partRaw, perr := v.partRawBytes()
	if perr != nil {
		res.State, res.Reason = "failed", "part-size"
		return res
	}
	est := v.dumpEstimate(tg)
	facts := volumeFacts{inv: Inventory{RawBytes: est}, applyBudget: dumpApplyWait(est)}

	if containsStr(v.c.resetVolume, tg.ItemRef) {
		if rerr := v.hub.VxReset(ctx, tg.ItemRef, v.runID); rerr != nil {
			v.setHubFailure(&res, rerr)
			return res
		}
		v.logf("reset %s: the staged parts were discarded", tg.ItemRef)
	}

	fp := VxFingerprint{ContainerID: f.src.ID, StartedAt: nonEmpty(f.src.StartedAt, "unknown"), FinishedAt: nonEmpty(f.src.FinishedAt, "unknown"), ExitCode: 0, MountType: "volume", ImageID: nonEmpty(f.src.Digest, "unknown")}
	begin := VxBeginReq{RunID: v.runID, PartRawBytes: partRaw, Fingerprint: fp}
	if est > 0 {
		begin.RawTotal = &est
	}
	br, berr := v.hub.VxBegin(ctx, tg.ItemRef, begin)
	if berr != nil {
		v.setHubFailure(&res, berr)
		return res
	}
	leased = true
	if br.AlreadyDone || br.State == "DONE" {
		res.State, res.Reason = "volume-applied", "already-applied"
		return res
	}
	if br.State == "APPLYING" || br.State == "COPIED" {
		copied = true // every part is on the target: only the restore remains (a failed one is re-applied by this very begin)
		return v.awaitApply(ctx, tg, facts, &res)
	}
	if br.PartRawBytes != partRaw {
		res.State, res.Reason = "failed", "part-size"
		return res
	}
	if br.ResumeFromPart != 0 {
		// The hub never offers a resume point for a dump; a hub that does is not speaking this contract.
		res.State, res.Reason = "failed", "bad-response"
		return res
	}

	started := time.Now()
	v.logSpoolRoom()
	sr, serr := StreamDump(ctx, v.hub, f.plan, tg.ItemRef, StreamOpts{
		PartRawBytes: partRaw, RunID: v.runID, TotalRaw: est, MaxParts: v.policy.MaxParts,
		Spool: DumpSpoolOpts{Dir: v.c.dumpSpoolDir, CapBytes: int64(v.c.dumpSpoolMiB) * mib, Logf: v.logf},
		Progress: func(p Progress) {
			v.logf("%s", dumpProgressLine(p.Part, p.RawDone, p.RawTotal, p.Committed, time.Since(started)))
		},
	})
	res.SpoolPeakBytes = sr.SpoolPeakBytes
	if serr != nil {
		v.setDumpFailure(ctx, &res, serr)
		return res
	}
	res.Parts, res.RawBytes = sr.Parts, sr.RawBytes

	// The source must still be the SAME container run after the last byte (a restarted database changed under the dump).
	after, aerr := Resolve(ctx, Target{ItemRef: tg.DatabaseItemRef, Kind: "database", Engine: tg.Engine}, v.overrides[tg.ItemRef], v.dockerPath, v.dockerEnv)
	if aerr != nil || after.ID != f.src.ID || after.StartedAt != f.src.StartedAt {
		res.State, res.Reason = "volume-diverged", "source-restarted"
		return res
	}
	ferr := v.hub.VxFinish(ctx, tg.ItemRef, VxFinishReq{
		RunID: v.runID, Parts: sr.Parts, RawBytes: sr.RawBytes, Entries: 0,
		FingerprintAfter: VxAfterFing{ContainerID: after.ID, StartedAt: nonEmpty(after.StartedAt, "unknown"), FinishedAt: nonEmpty(after.FinishedAt, "unknown"), Running: true},
	})
	if ferr != nil {
		v.setHubFailure(&res, ferr)
		return res
	}
	copied = true
	facts.inv.RawBytes = sr.RawBytes
	facts.applyBudget = dumpApplyWait(sr.RawBytes)
	return v.awaitApply(ctx, tg, facts, &res)
}

// setDumpFailure maps a streaming failure of a dump.
func (v *volRunner) setDumpFailure(ctx context.Context, res *itemResult, err error) {
	switch {
	case ctx.Err() != nil:
		res.State, res.Reason = "volume-aborted", "interrupted"
	case errors.Is(err, ErrDumpStream):
		res.State, res.Reason = "failed", "dump-failed"
		if why := strings.TrimSpace(strings.TrimPrefix(err.Error(), ErrDumpStream.Error())); why != "" {
			res.Reason += ": " + hubText(why)
		}
	case kindOf(err) != KindOther:
		v.setHubFailure(res, err)
	default:
		res.State, res.Reason = "failed", "part-failed"
	}
}

func nonEmpty(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// logSpoolRoom says how much room the source's dump spool has (see spoolRoomLine). Best effort: a probe that fails is a line, never an error.
func (v *volRunner) logSpoolRoom() {
	dir := v.c.dumpSpoolDir
	if dir == "" {
		dir = os.TempDir()
	}
	free, ok := spoolFreeBytes(dir)
	line, _ := spoolRoomLine(dir, free, ok, int64(v.c.dumpSpoolMiB)*mib, defaultDumpSpoolMargin)
	v.logf("%s", line)
}

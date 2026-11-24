package migrate

import (
	"context"
	"time"
)

// The streamed dump lane for a PLAIN run (outside a guided migration): a database whose dump goes over the hub's artifact size cap is
// not a failure, it is moved by the streamed lane (no size cap, parts through the relay, restored on the target as a stream). A guided
// run decides lanes itself before it starts the migrator; this is the same lane for a person running `tugra-agent migrate` on its own.

// streamedVolumeRow finds the streamed-dump row of one database in a targets list.
func streamedVolumeRow(all []Target, dbItemRef string) (Target, bool) {
	for _, t := range selectVolumeTargets(all, nil) {
		if isDumpTarget(t) && t.DatabaseItemRef == dbItemRef {
			return t, true
		}
	}
	return Target{}, false
}

// volRunnerFor builds (once) the volume runner the databases arm uses for the streamed dump lane.
func (r *runner) volRunnerFor() *volRunner {
	if r.vr == nil {
		r.vr = &volRunner{hub: r.hub, dockerPath: r.dockerPath, dockerEnv: r.dockerEnv, c: r.c, sc: r.sc, logf: r.logf, runID: newRunID(),
			policy: *r.vxPolicy, overrides: r.overrides, usedIDs: map[string]string{}, expiry: r.expiry, parsed: r.parsed, sizes: map[string]DbSizeItem{}}
	}
	return r.vr
}

// streamedResult turns the volume runner's verdict on a dump row into the database item's: a finished apply is a restored database.
func streamedResult(tg Target, vres itemResult) itemResult {
	vres.ItemRef, vres.Engine = tg.ItemRef, tg.Engine
	if vres.State == "volume-applied" {
		vres.State, vres.Reason = "restored", "streamed"
	}
	return vres
}

// streamOverCap moves a database whose artifact dump was over the cap by the streamed lane. ok is false when the lane is not available
// (the hub offers none, the operator opted out, the hub refused): the caller then reports the plain `dump-too-big`.
func (r *runner) streamOverCap(ctx context.Context, tg Target) (res itemResult, abort int, ok bool) {
	if r.c.noStreamLarge || r.vxPolicy == nil || !isDumpEngine(tg.Engine) {
		return itemResult{}, 0, false
	}
	r.logf("%s: the dump is over the artifact size cap; moving it by the streamed dump lane", tg.ItemRef)
	if _, err := r.hub.VxRequestStream(ctx, tg.ItemRef); err != nil {
		if a := abortKind(err); a != 0 {
			return itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine, State: "failed", Reason: codeName(a)}, a, true
		}
		r.logf("%s: the hub did not take the streamed lane: %v", tg.ItemRef, err)
		return itemResult{}, 0, false
	}
	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	fresh, err := r.hub.Targets(tctx)
	cancel()
	if err != nil {
		if a := abortKind(err); a != 0 {
			return itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine, State: "failed", Reason: codeName(a)}, a, true
		}
		return itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine, State: "failed", Reason: "hub-targets"}, 0, true
	}
	row, found := streamedVolumeRow(fresh.Targets, tg.ItemRef)
	if !found {
		return itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine, State: "failed", Reason: "stream-unavailable"}, 0, true
	}
	r.allTgts = fresh.Targets
	vr := r.volRunnerFor()
	vres := vr.runDump(ctx, row)
	return streamedResult(tg, vres), vr.abortCode, true
}

// resumeStreamed continues a streamed dump this command started in an earlier run. It applies only when no volume arm runs in this
// invocation (otherwise the volume arm owns every dump row) and only to a row the migrator itself asked for.
func (r *runner) resumeStreamed(ctx context.Context, tg Target) (res itemResult, abort int, ok bool) {
	if r.c.noStreamLarge || r.c.arms != "databases" || r.vxPolicy == nil || !isDumpEngine(tg.Engine) {
		return itemResult{}, 0, false
	}
	row, found := streamedVolumeRow(r.allTgts, tg.ItemRef)
	if !found || !row.StreamedByMigrator {
		return itemResult{}, 0, false
	}
	vr := r.volRunnerFor()
	vres := vr.runDump(ctx, row)
	return streamedResult(tg, vres), vr.abortCode, true
}

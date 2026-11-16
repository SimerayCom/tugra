package migrate

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// vxProtocolVersion is the volume-stream wire protocol this migrator speaks (the hub advertises `vxProtocol`).
const vxProtocolVersion = 1

// bytesOf is the number of bytes in a MiB (named so the intent reads at the call site).
const mib = 1024 * 1024

// postgresExcludes are the tar excludes of a physical Postgres data directory: the postmaster lock names the dead
// source's pid and would make the destination refuse to start. (A hub constant on the other side as well.)
var postgresExcludes = []string{"postmaster.pid"}

func excludesFor(tg Target) []string {
	if tg.Dest != nil && tg.Dest.Type == "db-data" {
		return postgresExcludes
	}
	return nil
}

// volRunner holds the per-run state of the volume arm. Volume items are processed AFTER the databases arm and strictly
// one at a time (the relay is a small shared resource and the source is stopped for the whole copy of each one).
type volRunner struct {
	hub        *Hub
	dockerPath string
	dockerEnv  []string
	c          *cli
	sc         *scrubber
	logf       func(string, ...any)
	runID      string
	policy     VxPolicy
	overrides  map[string]string
	usedIDs    map[string]string
	// parsed are the dump recipes that passed the contract check (the streamed dump lane builds its plan from them);
	// sizes are this run's database size measurements by itemRef (the dump lane's estimate).
	parsed map[string]*Parsed
	sizes  map[string]DbSizeItem
	// expiry is the probe's token expiry; the hub's renewed value (Hub.Expiry) wins once a vx call returned one.
	expiry time.Time
	// abortCode is set when the whole run must stop (authentication lost).
	abortCode int
}

func newRunID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "run_" + hex.EncodeToString([]byte(time.Now().Format("150405.000000")))
	}
	return "run_" + hex.EncodeToString(b[:])
}

// selectVolumeTargets returns the volume rows in scope, sorted by itemRef. Only rows the hub marked streamable (or
// explicitly excluded) are considered; anything else is not ours to touch.
func selectVolumeTargets(all []Target, only stringList) []Target {
	allow := map[string]bool{}
	for _, o := range only {
		allow[o] = true
	}
	var out []Target
	for _, tg := range all {
		if tg.Kind != "volume" || (tg.VolumeIngest != "stream-v2" && tg.VolumeIngest != "excluded" && tg.VolumeIngest != volumeIngestDump) {
			continue
		}
		if len(allow) > 0 && !allow[tg.ItemRef] {
			continue
		}
		out = append(out, tg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ItemRef < out[j].ItemRef })
	return out
}

// partRawBytes is the part size this run uses: the hub policy (the hub enforces it), optionally pinned by --part-mib.
func (v *volRunner) partRawBytes() (int, error) {
	pol := v.policy.PartRawBytes
	if pol <= 0 {
		return 0, errors.New("the hub reported no part size")
	}
	if v.c.partMiB != 0 && v.c.partMiB*mib != pol {
		return 0, errors.New("--part-mib does not match the hub policy")
	}
	return pol, nil
}

// volumeFacts is what the read-only inspection of one volume yields.
type volumeFacts struct {
	src    *volSource
	inv    Inventory
	item   InvItem
	state  string // "" = inspectable and streamable; else the item state to report
	reason string
	// stopped is the container THIS run stopped (so it may restart it if the copy does not complete); nil otherwise.
	stopped *volSource
	// applyBudget overrides how long awaitApply polls the hub (the streamed dump's restore is much slower than an extract).
	applyBudget time.Duration
}

// inspect resolves + validates one volume target and reads its inventory. With mayStop (the real run, never the dry run)
// and --stop-source it first stops ONLY that container, re-resolves it and verifies it is quiescent. The returned state is
// non-empty when the item must not be copied (and `item` is then the honest inventory entry).
func (v *volRunner) inspect(ctx context.Context, tg Target, mayStop bool) volumeFacts {
	f := volumeFacts{item: InvItem{ItemRef: tg.ItemRef, MountType: "volume"}}
	if tg.VolumeIngest == "excluded" {
		f.state, f.reason = "volume-not-migrated", sanitizeReason(tg.Reason)
		f.item.Reason = "excluded by the owner"
		return f
	}
	if tg.Dest == nil {
		f.state, f.reason = "failed", "bad-target"
		return f
	}
	src, err := ResolveVolume(ctx, tg, v.overrides[tg.ItemRef], v.dockerPath, v.dockerEnv)
	if err != nil {
		f.state, f.reason = volumeOutcome(err)
		if f.state == "volume-source-missing" {
			f.item.Found = false
			f.item.Reason = f.reason
		}
		return f
	}
	if prev, dup := v.usedIDs[src.ContainerID+"|"+src.Destination]; dup && prev != tg.ItemRef {
		f.state, f.reason = "failed", "duplicate-source"
		return f
	}
	v.usedIDs[src.ContainerID+"|"+src.Destination] = tg.ItemRef
	if src.MountType == "bind" && !v.c.allowBind {
		f.src = src
		f.item.Found, f.item.MountType, f.item.MountDest, f.item.Image = true, src.MountType, src.Destination, reportableImage(src.Image)
		f.state, f.reason = "volume-bind-refused", "bind-mount"
		return f
	}
	if _, merr := src.mountSrc(); merr != nil {
		f.state, f.reason = volumeOutcome(merr)
		return f
	}
	if mayStop && (src.State.Running || src.State.Restarting || src.State.Paused) {
		if !v.c.stopSource {
			f.src = src
			f.item.Found, f.item.MountType, f.item.MountDest, f.item.Image, f.item.Running = true, src.MountType, src.Destination, reportableImage(src.Image), true
			f.state, f.reason = "volume-skipped-running", "stop "+shortName(src.Name)+" first (or rerun with --stop-source)"
			return f
		}
		v.logf("stopping %s (only this container; it is restarted if the copy does not complete)", shortName(src.Name))
		if serr := v.stopContainer(ctx, src); serr != nil {
			f.state, f.reason = "failed", "stop-failed"
			return f
		}
		f.stopped = src
		fresh, rerr := ResolveVolume(ctx, tg, v.overrides[tg.ItemRef], v.dockerPath, v.dockerEnv)
		if rerr != nil || fresh.ContainerID != src.ContainerID {
			f.state, f.reason = "failed", "stop-failed"
			return f
		}
		src = fresh
	}
	f.src = src
	f.item.Found = true
	f.item.MountType = src.MountType
	f.item.MountDest = src.Destination
	f.item.Image = reportableImage(src.Image)
	running := src.State.Running || src.State.Restarting || src.State.Paused
	f.item.Running = running
	if !running {
		code := src.State.ExitCode
		f.item.ExitCode = &code
		f.item.FinishedAt = src.State.FinishedAt
	}
	if mayStop {
		// The proof, not an assumption: not running AND no other container on the same volume/path.
		if qerr := VerifyQuiescent(ctx, v.dockerPath, v.dockerEnv, src); qerr != nil {
			f.state, f.reason = "volume-skipped-running", sanitizeReason(strings.TrimPrefix(qerr.Error(), ErrSourceRunning.Error()+": "))
			return f
		}
	}
	inv, ierr := InventoryVolumeFor(ctx, v.runID, v.dockerPath, v.dockerEnv, v.c.helperImage, src, excludesFor(tg))
	if ierr != nil {
		f.state, f.reason = volumeOutcome(ierr)
		return f
	}
	f.inv = inv
	f.item.RawBytes, f.item.Entries = inv.RawBytes, inv.Entries
	f.item.Specials = InvSpecials{Sockets: inv.Sockets, Fifos: inv.Fifos, Devices: inv.Devices}
	f.item.PgMajor, f.item.PgLayout = inv.PgMajor, inv.PgLayout
	if inv.Devices > 0 {
		f.state, f.reason = "volume-special-files", "device-nodes"
		return f
	}
	if inv.RawBytes > v.policy.MaxBytes && v.policy.MaxBytes > 0 {
		f.state, f.reason = "volume-disk-insufficient", "over-limit"
		return f
	}
	return f
}

// stopContainer stops ONLY the given container by its immutable id (never removes it).
func (v *volRunner) stopContainer(ctx context.Context, s *volSource) error {
	cctx, cancel := context.WithTimeout(ctx, time.Duration(v.c.stopTimeout+120)*time.Second)
	defer cancel()
	_, stderr, err := runDocker(cctx, []string{v.dockerPath, "stop", "-t", strconv.Itoa(v.c.stopTimeout), s.ContainerID}, v.dockerEnv)
	if err != nil {
		v.logf("docker stop failed: %v (%s)", err, firstLine(stderr))
		return err
	}
	return nil
}

// startContainer restarts a container THIS run stopped, with its own context (the run's may already be cancelled).
func (v *volRunner) startContainer(s *volSource) {
	cctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if _, stderr, err := runDocker(cctx, []string{v.dockerPath, "start", s.ContainerID}, v.dockerEnv); err != nil {
		v.logf("could not restart %s: %v (%s) - start it by hand", shortName(s.Name), err, firstLine(stderr))
		return
	}
	v.logf("restarted %s", shortName(s.Name))
}

// volumeOutcome maps a resolution/inspection error to an item state + a value-free reason.
var reportableImageRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$`)

// reportableImage is the image reference as the hub's strict inventory schema accepts it; an unusual reference is left out
// (the hub then cannot prove "same image" and the Postgres gate stays closed) rather than failing the whole inventory.
func reportableImage(img string) string {
	if reportableImageRe.MatchString(img) {
		return img
	}
	return ""
}

func volumeOutcome(err error) (state, reason string) {
	switch {
	case errors.Is(err, ErrNotFound):
		return "volume-source-missing", "unresolved"
	case errors.Is(err, ErrAmbiguous):
		return "failed", "ambiguous"
	case errors.Is(err, ErrForbidden):
		return "failed", "forbidden-container"
	case errors.Is(err, ErrBindRefused):
		return "volume-bind-refused", "bind-mount"
	case errors.Is(err, ErrBadMount):
		return "failed", "bad-mount"
	case errors.Is(err, ErrSourceRunning):
		return "volume-skipped-running", "running"
	case errors.Is(err, ErrSpecialFiles):
		return "volume-special-files", "device-nodes"
	case errors.Is(err, ErrNoHelper):
		return "failed", "no-helper-image"
	default:
		return "failed", "inspect"
	}
}

// dryRun inspects every volume in scope (no stop, no begin, no part), posts the inventory to the hub and asks it for
// the target's disk verdict per found volume. It reports one item per volume.
func (v *volRunner) dryRun(ctx context.Context, all []Target) []itemResult {
	var scope, dumps []Target
	for _, tg := range all {
		if isDumpTarget(tg) {
			dumps = append(dumps, tg)
		} else {
			scope = append(scope, tg)
		}
	}
	results := v.dryRunVolumes(ctx, scope)
	for _, tg := range dumps {
		results = append(results, v.dryRunDump(ctx, tg))
	}
	return results
}

func (v *volRunner) dryRunVolumes(ctx context.Context, scope []Target) []itemResult {
	results := make([]itemResult, 0, len(scope))
	facts := make([]volumeFacts, 0, len(scope))
	var inv []InvItem
	for _, tg := range scope {
		f := v.inspect(ctx, tg, false)
		facts = append(facts, f)
		if tg.VolumeIngest != "excluded" && (f.item.Found || f.state == "volume-source-missing") {
			inv = append(inv, f.item)
		}
	}
	posted := false
	speeds := map[string]float64{}
	if len(inv) > 0 {
		exp, err := v.hub.VxInventory(ctx, v.runID, inv)
		if err == nil {
			posted = true
			if !exp.IsZero() {
				v.expiry = exp
			}
		} else {
			v.logf("inventory: %v", err)
		}
	}
	for i, tg := range scope {
		f := facts[i]
		res := itemResult{ItemRef: tg.ItemRef, Engine: engineOfVolume(tg), State: f.state, Reason: f.reason}
		fillFacts(&res, f)
		if res.State == "" {
			res.State, res.Reason = "planned", "would-migrate"
			switch {
			case f.src != nil && (f.item.Running) && v.c.stopSource:
				res.Reason = "would-stop-source"
			case f.src != nil && f.item.Running:
				res.State, res.Reason = "volume-skipped-running", "stop "+shortName(f.src.Name)+" first (or rerun with --stop-source)"
			}
		}
		if f.item.Found && posted && f.state != "volume-special-files" && f.state != "volume-bind-refused" {
			raw := f.inv.RawBytes
			d, err := v.hub.VxDiskCheck(ctx, tg.ItemRef, v.runID, &raw)
			switch {
			case err != nil:
				res.Disk = "unknown"
				v.logf("disk-check %s: %v", tg.ItemRef, err)
			case d.Unknown:
				res.Disk = "unknown"
			case !d.OK:
				res.Disk = "short"
				if res.State == "planned" {
					res.State, res.Reason = "volume-disk-insufficient", "target-disk"
				}
			default:
				res.Disk = "ok"
			}
		}
		if res.State == "planned" && v.c.speedtestMiB > 0 && f.src != nil {
			v.speedtest(ctx, tg, f, &res)
			if res.SpeedMBps > 0 {
				speeds[tg.ItemRef] = res.SpeedMBps
			}
		}
		results = append(results, res)
	}
	v.postMeasuredSpeeds(ctx, inv, speeds)
	return results
}

// postMeasuredSpeeds sends the inventory again with the rate each speed test measured, so the hub's window estimate can use the real link of
// this source host instead of an assumed rate. Only the items that were measured are sent; the hub replaces an item as a whole, so the
// re-post carries every other field again. A failure is logged and never fatal: the estimate then simply keeps its assumed rate.
func (v *volRunner) postMeasuredSpeeds(ctx context.Context, inv []InvItem, speeds map[string]float64) {
	if len(speeds) == 0 {
		return
	}
	var again []InvItem
	for _, it := range inv {
		if s, ok := speeds[it.ItemRef]; ok {
			it.SpeedMBps = s
			again = append(again, it)
		}
	}
	if len(again) == 0 {
		return
	}
	if exp, err := v.hub.VxInventory(ctx, v.runID, again); err != nil {
		v.logf("inventory (measured speed): %v", err)
	} else if !exp.IsZero() {
		v.expiry = exp
	}
}

func fillFacts(res *itemResult, f volumeFacts) {
	if !f.item.Found {
		return
	}
	res.RawBytes, res.Entries = f.item.RawBytes, f.item.Entries
	running := f.item.Running
	res.Running = &running
	res.ExitCode = f.item.ExitCode
	res.Image, res.PgMajor, res.PgLayout = f.item.Image, f.item.PgMajor, f.item.PgLayout
}

func engineOfVolume(tg Target) string {
	if tg.Dest != nil && tg.Dest.Type == "db-data" {
		return "POSTGRES"
	}
	if isDumpTarget(tg) && tg.Engine != "" {
		return tg.Engine
	}
	return "VOLUME"
}

func shortName(n string) string {
	n = strings.TrimPrefix(n, "/")
	if len(n) > 64 {
		return n[:64]
	}
	return n
}

// run streams every volume in scope, one at a time. It returns the per-volume results and a non-zero exit code when the
// whole run must stop (authentication lost).
func (v *volRunner) run(ctx context.Context, scope []Target) ([]itemResult, int) {
	results := make([]itemResult, 0, len(scope))
	v.hub.SetOutageWait(v.c.hubOutageWait)
	reapStaleHelpers(ctx, v.dockerPath, v.dockerEnv)
	for i, tg := range scope {
		if ctx.Err() != nil {
			for _, rest := range scope[i:] {
				results = append(results, itemResult{ItemRef: rest.ItemRef, Engine: engineOfVolume(rest), State: "volume-aborted", Reason: "interrupted"})
			}
			return results, 0
		}
		if exp := v.latestExpiry(); !exp.IsZero() && time.Until(exp) < 2*time.Minute {
			for _, rest := range scope[i:] {
				results = append(results, itemResult{ItemRef: rest.ItemRef, Engine: engineOfVolume(rest), State: "volume-aborted", Reason: "token-expiring"})
			}
			return results, 0
		}
		v.logf("[vol %d/%d] %s", i+1, len(scope), tg.ItemRef)
		var res itemResult
		if isDumpTarget(tg) {
			res = v.runDump(ctx, tg)
		} else {
			res = v.runOne(ctx, tg)
		}
		results = append(results, res)
		if v.abortCode != 0 {
			for _, rest := range scope[i+1:] {
				results = append(results, itemResult{ItemRef: rest.ItemRef, Engine: engineOfVolume(rest), State: "volume-aborted", Reason: "run-aborted"})
			}
			return results, v.abortCode
		}
	}
	return results, 0
}

// latestExpiry is the freshest token expiry known: the hub's renewed value, else the probe's.
func (v *volRunner) latestExpiry() time.Time {
	if e := v.hub.Expiry(); !e.IsZero() {
		return e
	}
	return v.expiry
}

// runOne copies ONE volume end to end. A container this run stopped is restarted on every exit path that did not reach
// COPIED (failure, SIGINT, panic); after COPIED the source stays stopped (the target now owns the cutover).
func (v *volRunner) runOne(ctx context.Context, tg Target) (res itemResult) {
	res = itemResult{ItemRef: tg.ItemRef, Engine: engineOfVolume(tg)}
	var stopped *volSource
	copied := false
	leased := false
	defer func() {
		if rec := recover(); rec != nil {
			res.State, res.Reason = "failed", "internal"
		}
		if leased && !copied && ctx.Err() != nil {
			actx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_ = v.hub.VxAbort(actx, tg.ItemRef, v.runID) // release the lease, keep the staged parts
			cancel()
		}
		if stopped != nil && !copied && v.c.restartOnFailure {
			v.startContainer(stopped)
		}
	}()

	f := v.inspect(ctx, tg, true)
	stopped = f.stopped
	fillFacts(&res, f)
	if f.state != "" {
		res.State, res.Reason = f.state, f.reason
		return res
	}
	src := f.src
	partRaw, perr := v.partRawBytes()
	if perr != nil {
		res.State, res.Reason = "failed", "part-size"
		return res
	}

	// The hub needs the inventory (image/major/layout) for its gates and the dry-run view; it also validates the ref.
	if exp, ierr := v.hub.VxInventory(ctx, v.runID, []InvItem{f.item}); ierr != nil {
		v.setHubFailure(&res, ierr)
		return res
	} else if !exp.IsZero() {
		v.expiry = exp
	}

	if containsStr(v.c.resetVolume, tg.ItemRef) {
		if rerr := v.hub.VxReset(ctx, tg.ItemRef, v.runID); rerr != nil {
			v.setHubFailure(&res, rerr)
			return res
		}
		v.logf("reset %s: the staged parts were discarded", tg.ItemRef)
	}

	fp := src.fingerprint(f.inv.PgMajor)
	total := f.inv.RawBytes
	br, berr := v.hub.VxBegin(ctx, tg.ItemRef, VxBeginReq{RunID: v.runID, PartRawBytes: partRaw, RawTotal: &total, Fingerprint: toVxFingerprint(fp)})
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
		copied = true // the copy finished in an earlier run: only the apply remains
		return v.awaitApply(ctx, tg, f, &res)
	}
	if br.PartRawBytes != partRaw {
		res.State, res.Reason = "failed", "part-size"
		return res
	}

	started := time.Now()
	sr, serr := StreamVolume(ctx, v.hub, v.dockerPath, v.dockerEnv, tg, src, StreamOpts{
		PartRawBytes: partRaw, Helper: v.c.helperImage, RunID: v.runID, Excludes: excludesFor(tg),
		ResumeFromPart: br.ResumeFromPart, Manifest: br.Manifest, TotalRaw: total, MaxParts: v.policy.MaxParts,
		Progress: func(p Progress) {
			secs := time.Since(started).Seconds()
			rate := 0.0
			if secs > 0 {
				rate = float64(p.Committed) / secs / 1e6
			}
			v.logf("  part %d  %.2f GiB / %.2f GiB  (%.1f MB/s compressed)", p.Part, float64(p.RawDone)/(1<<30), float64(p.RawTotal)/(1<<30), rate)
		},
	})
	if serr != nil {
		v.setStreamFailure(ctx, &res, serr)
		return res
	}
	res.Parts, res.RawBytes = sr.Parts, sr.RawBytes

	// Re-prove quiescence AFTER the last byte; the hub compares this with the begin-time fingerprint.
	after, aerr := ResolveVolume(ctx, tg, v.overrides[tg.ItemRef], v.dockerPath, v.dockerEnv)
	if aerr != nil || after.ContainerID != src.ContainerID || after.State.Running || after.State.Restarting || after.State.Paused {
		res.State, res.Reason = "volume-diverged", "source-restarted"
		return res
	}
	if qerr := VerifyQuiescent(ctx, v.dockerPath, v.dockerEnv, after); qerr != nil {
		res.State, res.Reason = "volume-diverged", "source-restarted"
		return res
	}
	ferr := v.hub.VxFinish(ctx, tg.ItemRef, VxFinishReq{
		RunID: v.runID, Parts: sr.Parts, RawBytes: sr.RawBytes, Entries: f.inv.Entries,
		FingerprintAfter: VxAfterFing{ContainerID: after.ContainerID, StartedAt: after.State.StartedAt, FinishedAt: after.State.FinishedAt, Running: false},
	})
	if ferr != nil {
		v.setHubFailure(&res, ferr)
		return res
	}
	copied = true // from here the source stays stopped
	if stopped != nil {
		v.logf("%s stays stopped: start it on the target, then repoint DNS", shortName(stopped.Name))
	}
	return v.awaitApply(ctx, tg, f, &res)
}

func containsStr(l stringList, v string) bool {
	for _, x := range l {
		if x == v {
			return true
		}
	}
	return false
}

func toVxFingerprint(f Fingerprint) VxFingerprint {
	return VxFingerprint{ContainerID: f.ContainerID, StartedAt: f.StartedAt, FinishedAt: f.FinishedAt, ExitCode: f.ExitCode, MountType: f.MountType, MountName: f.MountName, ImageID: f.ImageID, PgMajor: f.PgMajor}
}

// awaitApply polls the hub every 5 s until the apply (and, for a database, its start) reached a terminal state.
func (v *volRunner) awaitApply(ctx context.Context, tg Target, f volumeFacts, res *itemResult) itemResult {
	budget := applyWait(f.inv.RawBytes)
	if f.applyBudget > 0 {
		budget = f.applyBudget
	}
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			res.State, res.Reason = "volume-copied", "interrupted-before-apply-confirmed"
			return *res
		}
		st, err := v.hub.VxStatus(ctx, tg.ItemRef)
		if err != nil {
			if kindOf(err) == KindAuth {
				v.abortCode = exitAuth
				res.State, res.Reason = "volume-copied", "auth"
				return *res
			}
			if ctx.Err() == nil {
				v.logf("status: %v", err)
			}
		} else {
			switch st.State {
			case "DONE":
				res.State, res.Reason = "volume-applied", ""
				return *res
			case "FAILED":
				res.State, res.Reason = "volume-copied", "apply-failed: "+hubText(st.Error)
				return *res
			case "ABORTED":
				res.State, res.Reason = "volume-aborted", "owner-aborted"
				return *res
			}
		}
		if waitRetry(ctx, 5*time.Second) != nil {
			res.State, res.Reason = "volume-copied", "interrupted-before-apply-confirmed"
			return *res
		}
	}
	res.State, res.Reason = "volume-copied", "apply-timeout"
	return *res
}

// applyWait is how long the migrator keeps polling the apply: the hub's own apply budget plus the database start.
func applyWait(rawBytes int64) time.Duration {
	gib := rawBytes/(1<<30) + 1
	d := 10*time.Minute + time.Duration(gib)*4*time.Minute + 35*time.Minute
	if d > 24*time.Hour {
		d = 24 * time.Hour
	}
	return d
}

// hubText makes a hub message safe for the one JSON result line (bounded, no control characters).
func hubText(s string) string {
	s = stripControl(s)
	if len(s) > 160 {
		s = s[:160]
	}
	if s == "" {
		return "see the hub"
	}
	return s
}

// setHubFailure maps a hub error on a volume call to an honest item state; auth loss stops the run.
func (v *volRunner) setHubFailure(res *itemResult, err error) {
	switch kindOf(err) {
	case KindAuth:
		v.abortCode = exitAuth
		res.State, res.Reason = "failed", "auth"
	case KindVxFingerprintChanged:
		res.State, res.Reason = "volume-diverged", "fingerprint-changed: rerun with --reset-volume "+res.ItemRef
	case KindVxDiverged:
		res.State, res.Reason = "volume-diverged", "diverged: rerun with --reset-volume "+res.ItemRef
	case KindVxAborted:
		res.State, res.Reason = "volume-aborted", "owner-aborted"
	case KindVxDiskInsufficient:
		res.State, res.Reason = "volume-disk-insufficient", "target-disk: "+hubText(errMsg(err))
	case KindTooLarge:
		res.State, res.Reason = "volume-disk-insufficient", "over-limit"
	case KindVxOtherRun:
		res.State, res.Reason = "failed", "another-run-active"
	case KindDestDirty:
		res.State, res.Reason = "failed", "dest-dirty"
	case KindVxUsesHubStaged:
		res.State, res.Reason = "failed", "uses-hub-staged-upload"
	case KindVxUsesStream, KindVxDbVolumeMode:
		res.State, res.Reason = "failed", "route-closed"
	case KindNotFound:
		res.State, res.Reason = "failed", "no-such-target"
	case KindRedirect, KindServer, KindRateLimited:
		res.State, res.Reason = "failed", "hub-unreachable"
	case KindDecode:
		res.State, res.Reason = "failed", "bad-response"
	case KindUnknownConflict, KindBadRequest:
		res.State, res.Reason = "failed", "refused: "+hubText(errMsg(err)) // the hub's own gate text (e.g. the PostgreSQL gates)
	default:
		res.State, res.Reason = "failed", "hub-error"
	}
}

// setStreamFailure maps a streaming failure.
func (v *volRunner) setStreamFailure(ctx context.Context, res *itemResult, err error) {
	switch {
	case ctx.Err() != nil:
		res.State, res.Reason = "volume-aborted", "interrupted"
	case errors.Is(err, ErrDiverged):
		res.State, res.Reason = "volume-diverged", "source-changed: rerun with --reset-volume "+res.ItemRef
	case errors.Is(err, ErrTarFailed):
		res.State, res.Reason = "failed", "tar-failed"
	case kindOf(err) != KindOther:
		v.setHubFailure(res, err)
	default:
		res.State, res.Reason = "failed", "part-failed: "+hubText(err.Error())
	}
}

func errMsg(err error) string {
	var he *HubError
	if errors.As(err, &he) {
		return he.Msg
	}
	return err.Error()
}

// speedtest streams the first --speedtest-mib MiB of the REAL volume through the relay to the target's throwaway staging
// (discarded afterwards) and reports the measured end-to-end rate, so the downtime window is measured BEFORE anything is
// stopped. Read-only for the source (a running source is fine: the bytes are thrown away). Failures are reported, never fatal.
func (v *volRunner) speedtest(ctx context.Context, tg Target, f volumeFacts, res *itemResult) {
	partRaw, err := v.partRawBytes()
	if err != nil {
		res.Reason = "speedtest-part-size"
		return
	}
	want := int64(v.c.speedtestMiB) * mib
	if want > f.inv.RawBytes && f.inv.RawBytes > 0 {
		want = f.inv.RawBytes
	}
	src, serr := f.src.mountSrc()
	if serr != nil {
		res.Reason = "speedtest-failed"
		return
	}
	name := "tugra-vx-speed-" + shortRun(v.runID) + "-" + shortID(f.src.ContainerID)
	argv := buildTarArgv(v.dockerPath, v.c.helperImage, src, name, excludesFor(tg))
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stdout, wait, serr2 := startTarFn(sctx, argv, v.dockerEnv)
	if serr2 != nil {
		res.Reason = "speedtest-failed"
		return
	}
	defer func() {
		cancel()
		_ = stdout.Close()
		_ = wait() // tar is cut short on purpose: its exit status means nothing here
		removeHelper(v.dockerPath, v.dockerEnv, name)
		ectx, ecancel := context.WithTimeout(context.Background(), 30*time.Second)
		_ = v.hub.VxSpeedtestEnd(ectx, tg.ItemRef, v.runID)
		ecancel()
	}()

	buf := make([]byte, partRaw)
	mw := newMemberWriter()
	var member bytes.Buffer
	var raw int64
	started := time.Now()
	for idx := 0; raw < want; idx++ {
		n := int64(partRaw)
		if want-raw < n {
			n = want - raw
		}
		got, _, rerr := readSlice(stdout, buf[:n])
		if got == 0 {
			break // the archive was shorter than the test size
		}
		if rerr != nil && rerr != io.EOF {
			res.Reason = "speedtest-failed"
			return
		}
		msum, cerr := mw.compress(buf[:got], &member)
		if cerr != nil {
			res.Reason = "speedtest-failed"
			return
		}
		ok := false
		for attempt := 0; attempt < 2 && !ok; attempt++ {
			reg, rgerr := v.hub.VxSpeedtestPart(ctx, tg.ItemRef, idx, v.runID, member.Len(), hex.EncodeToString(msum[:]))
			if rgerr != nil {
				v.logf("speedtest: %v", rgerr)
				res.Reason = "speedtest-failed"
				return
			}
			if perr := v.hub.VxPutPart(ctx, reg.SrcPath, member.Bytes()); perr != nil {
				continue
			}
			c, cerr2 := v.hub.VxSpeedtestCommit(ctx, tg.ItemRef, idx, v.runID)
			ok = cerr2 == nil && c.Done
		}
		if !ok {
			res.Reason = "speedtest-failed"
			return
		}
		raw += int64(got)
		if got < int(n) {
			break
		}
	}
	secs := time.Since(started).Seconds()
	if raw == 0 || secs <= 0 {
		res.Reason = "speedtest-failed"
		return
	}
	rate := float64(raw) / secs / 1e6
	res.SpeedMBps = float64(int64(rate*10)) / 10
	res.Reason = "speedtest"
	if f.inv.RawBytes > 0 && rate > 0 {
		res.EstimateSeconds = int64(float64(f.inv.RawBytes)/(rate*1e6)) + 15*60 // + the extraction allowance
	}
	v.logf("speedtest %s: %.1f MB/s raw over %d MiB; estimated window %d min (estimate, not a promise)", tg.ItemRef, rate, raw/mib, res.EstimateSeconds/60)
}

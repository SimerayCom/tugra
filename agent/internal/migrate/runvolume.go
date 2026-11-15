package migrate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
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
	// expiry is the latest token expiry the hub reported (every vx response renews it); margins compare against it.
	expiry time.Time
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
		if tg.Kind != "volume" || (tg.VolumeIngest != "stream-v2" && tg.VolumeIngest != "excluded") {
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
}

// inspect resolves + validates one volume target and reads its inventory WITHOUT stopping or writing anything. The
// returned state is non-empty when the item must not be copied (and `item` is then the honest inventory entry).
func (v *volRunner) inspect(ctx context.Context, tg Target) volumeFacts {
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
	f.src = src
	f.item.Found = true
	f.item.MountType = src.MountType
	f.item.MountDest = src.Destination
	f.item.Image = src.Image
	running := src.State.Running || src.State.Restarting || src.State.Paused
	f.item.Running = running
	if !running {
		code := src.State.ExitCode
		f.item.ExitCode = &code
		f.item.FinishedAt = src.State.FinishedAt
	}
	if src.MountType == "bind" && !v.c.allowBind {
		f.state, f.reason = "volume-bind-refused", "bind-mount"
		return f
	}
	if _, merr := src.mountSrc(); merr != nil {
		f.state, f.reason = volumeOutcome(merr)
		return f
	}
	inv, ierr := InventoryVolume(ctx, v.dockerPath, v.dockerEnv, v.c.helperImage, src, excludesFor(tg))
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

// volumeOutcome maps a resolution/inspection error to an item state + a value-free reason.
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
func (v *volRunner) dryRun(ctx context.Context, scope []Target) []itemResult {
	results := make([]itemResult, 0, len(scope))
	facts := make([]volumeFacts, 0, len(scope))
	var inv []InvItem
	for _, tg := range scope {
		f := v.inspect(ctx, tg)
		facts = append(facts, f)
		if tg.VolumeIngest != "excluded" && (f.item.Found || f.state == "volume-source-missing") {
			inv = append(inv, f.item)
		}
	}
	posted := false
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
		results = append(results, res)
	}
	return results
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
	return "VOLUME"
}

func shortName(n string) string {
	n = strings.TrimPrefix(n, "/")
	if len(n) > 64 {
		return n[:64]
	}
	return n
}

// run streams every volume in scope, one at a time. (The streamed copy itself lands in the next slice; until then a
// volume is reported as skipped with an honest reason rather than touched.)
func (v *volRunner) run(ctx context.Context, scope []Target) []itemResult {
	results := make([]itemResult, 0, len(scope))
	for _, tg := range scope {
		results = append(results, itemResult{ItemRef: tg.ItemRef, Engine: engineOfVolume(tg), State: "volume-aborted", Reason: "copy-not-available"})
	}
	return results
}

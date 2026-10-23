package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Exit-code contract.
const (
	exitOK           = 0   // every in-scope target restored / already-restored
	exitPartial      = 1   // completed, but ≥1 item failed/skipped/unsupported/unconfirmed
	exitUsage        = 2   // bad flag / malformed token / unsafe --hub — no network call made
	exitAuth         = 3   // 401/403, or token expiring < 5m at start
	exitUnreachable  = 4   // hub unreachable / redirect / retries exhausted
	exitSkew         = 5   // recipes.v != 1, unknown engine/format, opId mismatch, bad status
	exitPrecondition = 6   // docker/daemon missing, spool unusable
	exitInterrupted  = 130 // SIGINT/SIGTERM/SIGHUP
)

var tokenReExact = regexp.MustCompile(`^tugra_mig_[A-Za-z0-9_-]{43}$`)

// safeBaseRe mirrors SAFE_BASE_RE in apps/hub-api/src/importer/migration-command.ts.
var safeBaseRe = regexp.MustCompile(`^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$`)

type counts struct {
	Restored        int `json:"restored"`
	AlreadyRestored int `json:"alreadyRestored"`
	Failed          int `json:"failed"`
	Skipped         int `json:"skipped"`
	Unsupported     int `json:"unsupported"`
	Unconfirmed     int `json:"unconfirmed"`
}

type itemResult struct {
	ItemRef  string `json:"itemRef"`
	Engine   string `json:"engine"`
	State    string `json:"state"`
	Reason   string `json:"reason,omitempty"`
	RawBytes int64  `json:"rawBytes,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
	Sha256   string `json:"sha256,omitempty"`
	HubExit  *int   `json:"hubExit,omitempty"`
}

type output struct {
	Tool        string       `json:"tool"`
	Version     string       `json:"version"`
	Schema      int          `json:"schema"`
	OK          bool         `json:"ok"`
	Exit        int          `json:"exit"`
	Code        string       `json:"code"`
	OpID        string       `json:"opId,omitempty"`
	RecipesV    int          `json:"recipesV,omitempty"`
	Hub         string       `json:"hub,omitempty"`
	DryRun      bool         `json:"dryRun,omitempty"`
	NoTargets   bool         `json:"noTargets,omitempty"`
	Interrupted bool         `json:"interrupted,omitempty"`
	Handshake   bool         `json:"handshake,omitempty"`
	SupportedV  int          `json:"supportedV,omitempty"`
	Engines     []string     `json:"engines,omitempty"`
	Counts      counts       `json:"counts"`
	Items       []itemResult `json:"items"`
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

type cli struct {
	hub            string
	token          string
	tokenFile      string
	only           stringList
	mapp           stringList
	resync         bool
	dryRun         bool
	handshake      bool
	allowInsecure  bool
	spoolDir       string
	maxGzBytes     int64
	dumpTimeout    time.Duration
	restoreTimeout time.Duration
}

// RunCLI is the `tugra-agent migrate` entrypoint. It installs its own signal handling (no agent
// WebSocket), performs ALL cleanup + emits exactly one JSON line to stdout BEFORE returning the
// code (os.Exit in main.go skips defers). stderr carries the scrubbed human log.
func RunCLI(args []string, version string, stdout, stderr io.Writer) (code int) {
	sc := &scrubber{}
	logf := func(format string, a ...any) {
		fmt.Fprintln(stderr, sc.scrub(strings.TrimRight(fmt.Sprintf(format, a...), "\n")))
	}

	out := output{Tool: "tugra-migrate", Version: version, Schema: 1, Items: []itemResult{}}
	var emitOnce sync.Once
	emit := func(final *output) {
		emitOnce.Do(func() {
			final.Exit = code
			final.OK = code == exitOK
			final.Code = codeName(code)
			b, _ := json.Marshal(final)
			fmt.Fprintln(stdout, string(b))
		})
	}
	defer func() { emit(&out) }()

	c, perr := parseFlags(args, stderr)
	if perr != nil {
		code = exitUsage
		return
	}

	// --- Step 0: local validation (no network) ---
	tok, terr := resolveToken(c)
	if terr != nil {
		logf("token: %v", terr)
		code = exitUsage
		return
	}
	sc.add(tok)
	if !tokenReExact.MatchString(tok) {
		logf("token: malformed migration token")
		code = exitUsage
		return
	}
	if c.token != "" && os.Getenv("TUGRA_MIGRATION_TOKEN") == "" && c.tokenFile == "" {
		logf("warning: --token puts the token on the host process list (ps); prefer TUGRA_MIGRATION_TOKEN or --token-file")
	}
	if err := validateHub(c.hub, c.allowInsecure); err != nil {
		logf("hub: %v", err)
		code = exitUsage
		return
	}
	c.hub = strings.TrimRight(c.hub, "/")
	out.Hub = c.hub

	dockerEnv := dockerBaseEnv(os.LookupEnv)
	dockerPath, derr := lookDocker(dockerEnv)
	if derr != nil {
		logf("docker: %v", derr)
		code = exitPrecondition
		return
	}

	mapOverrides, merr := parseMap(c.mapp)
	if merr != nil {
		logf("--map: %v", merr)
		code = exitUsage
		return
	}

	hub, herr := NewHub(c.hub, tok, version)
	if herr != nil {
		logf("hub: %v", herr)
		code = exitUsage
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()

	// --- Step 1: probe ---
	pctx, pcancel := context.WithTimeout(ctx, 30*time.Second)
	probe, err := hub.Probe(pctx)
	pcancel()
	if err != nil {
		code = classifyAbort(ctx, err, logf, "probe")
		return
	}
	if !probe.OK {
		logf("probe: hub did not confirm the token")
		code = exitAuth
		return
	}
	out.OpID = probe.OpID
	if !probe.expiresAt.IsZero() && time.Until(probe.expiresAt) < 5*time.Minute {
		logf("token expires in under 5 minutes — reissue it")
		code = exitAuth
		return
	}

	// --- Step 2: recipes + handshake ---
	rctx, rcancel := context.WithTimeout(ctx, 30*time.Second)
	env, err := hub.Recipes(rctx)
	rcancel()
	if err != nil {
		code = classifyAbort(ctx, err, logf, "recipes")
		return
	}
	if env.V != SupportedRecipesV {
		logf("recipe contract version skew: hub v=%d, this migrator supports v=%d — re-download the migrator from your hub", env.V, SupportedRecipesV)
		out.RecipesV = env.V
		code = exitSkew
		return
	}
	out.RecipesV = env.V
	parsed := map[string]*Parsed{}
	rejected := map[string]bool{}
	for engine, r := range env.Recipes {
		p, perr := ParseRecipe(engine, r)
		if perr != nil {
			logf("recipe for %s rejected: %v", engine, perr)
			rejected[engine] = true
			continue
		}
		parsed[engine] = p
	}

	if c.handshake {
		out.Handshake = true
		out.SupportedV = SupportedRecipesV
		out.Engines = streamableEngines()
		code = exitOK
		return
	}

	// --- Step 3: targets ---
	tctx, tcancel := context.WithTimeout(ctx, 30*time.Second)
	targets, err := hub.Targets(tctx)
	tcancel()
	if err != nil {
		code = classifyAbort(ctx, err, logf, "targets")
		return
	}
	if targets.OpID != "" && probe.OpID != "" && targets.OpID != probe.OpID {
		logf("targets opId does not match the token opId")
		code = exitSkew
		return
	}
	if targets.MaxArtifactBytes <= 0 {
		logf("hub reported a non-positive maxArtifactBytes")
		code = exitSkew
		return
	}
	maxGz := targets.MaxArtifactBytes
	if c.maxGzBytes > 0 && c.maxGzBytes < maxGz {
		maxGz = c.maxGzBytes
	}

	spoolDir, spoolCreated, serr := prepareSpool(c.spoolDir)
	if serr != nil {
		logf("spool: %v", serr)
		code = exitPrecondition
		return
	}
	if spoolCreated {
		defer os.RemoveAll(spoolDir) // we made this temp root; leave no 0600 residue behind
	}
	sweepStaleSpools(spoolDir, "tugra-migrate-")          // our own per-item dirs from a crashed run
	sweepStaleSpools(os.TempDir(), "tugra-migrate-spool-") // default spool roots from crashed runs

	// in-scope database items, filtered by --only, sorted for determinism
	inScope := selectTargets(targets.Targets, c.only)

	if len(inScope) == 0 {
		out.NoTargets = true
		code = exitOK
		return
	}

	if c.dryRun {
		out.DryRun = true
		bad := false
		for _, tg := range inScope {
			st := planState(tg, parsed, rejected)
			out.Items = append(out.Items, itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine, State: st.state, Reason: st.reason})
			switch st.state {
			case "unsupported":
				out.Counts.Unsupported++
				bad = true
			case "skipped":
				out.Counts.Skipped++
				bad = true
				// "planned" is NOT counted as restored: a dry run restores nothing.
			}
		}
		if bad {
			code = exitPartial // some items cannot migrate — signal it, don't report a clean plan
		} else {
			code = exitOK
		}
		return
	}

	// --- Step 4: sequential per-item loop ---
	run := &runner{hub: hub, dockerPath: dockerPath, dockerEnv: dockerEnv, spoolDir: spoolDir,
		maxGz: maxGz, c: c, sc: sc, logf: logf, parsed: parsed, rejected: rejected, overrides: mapOverrides,
		usedIDs: map[string]string{}}

	for i, tg := range inScope {
		if ctx.Err() != nil {
			out.Interrupted = true
			for _, rest := range inScope[i:] {
				out.Items = append(out.Items, itemResult{ItemRef: rest.ItemRef, Engine: rest.Engine, State: "skipped", Reason: "interrupted"})
				out.Counts.Skipped++
			}
			code = exitInterrupted
			return
		}
		if !probe.expiresAt.IsZero() && time.Until(probe.expiresAt) < 2*time.Minute {
			for _, rest := range inScope[i:] {
				out.Items = append(out.Items, itemResult{ItemRef: rest.ItemRef, Engine: rest.Engine, State: "skipped", Reason: "token-expiring"})
				out.Counts.Skipped++
			}
			break
		}
		logf("[%d/%d] %s %s", i+1, len(inScope), tg.ItemRef, tg.Engine)
		res, abort := run.item(ctx, tg)
		if abort != 0 && res.State == "" {
			res.State, res.Reason = "failed", codeName(abort)
		}
		out.Items = append(out.Items, res)
		tallyState(&out.Counts, res.State)
		if abort != 0 {
			logf("aborting the run after %s", codeName(abort))
			code = abort
			return
		}
	}

	if ctx.Err() != nil {
		out.Interrupted = true
		code = exitInterrupted
		return
	}
	code = partialOrOK(out.Counts)
	return
}

// runner holds the per-run context for the item loop.
type runner struct {
	hub        *Hub
	dockerPath string
	dockerEnv  []string
	spoolDir   string
	maxGz      int64
	c          *cli
	sc         *scrubber
	logf       func(string, ...any)
	parsed     map[string]*Parsed
	rejected   map[string]bool
	overrides  map[string]string
	usedIDs    map[string]string // container ID -> the itemRef that first resolved it
}

// item runs one target end to end. The second return is a non-zero abort exit code when the whole
// run must stop (auth loss, hub misconfig); 0 means continue to the next item.
func (r *runner) item(ctx context.Context, tg Target) (res itemResult, abort int) {
	res = itemResult{ItemRef: tg.ItemRef, Engine: tg.Engine}
	defer func() {
		if rec := recover(); rec != nil {
			res.State, res.Reason = "failed", "internal"
		}
	}()

	// unsupported / no-recipe short-circuit
	if tg.DataPlane == "unsupported" {
		res.State, res.Reason = "unsupported", sanitizeReason(tg.Reason)
		return res, 0
	}
	if _, ok := engineSpecs[tg.Engine]; !ok {
		res.State, res.Reason = "unsupported", "no-recipe"
		return res, 0
	}
	if r.rejected[tg.Engine] || r.parsed[tg.Engine] == nil {
		res.State, res.Reason = "skipped", "no-recipe"
		return res, 0
	}

	// --- Step 5: status-first ---
	sctx, scancel := context.WithTimeout(ctx, 30*time.Second)
	st, err := r.hub.Status(sctx, tg.ItemRef)
	scancel()
	if err != nil {
		if a := abortKind(err); a != 0 {
			return res, a
		}
		if k := kindOf(err); k == KindNotFound {
			res.State, res.Reason = "failed", "no-such-target"
			return res, 0
		}
		res.State, res.Reason = "failed", "hub-status"
		return res, 0
	}
	switch st.State {
	case "restored":
		if !r.c.resync {
			res.State = "already-restored"
			return res, 0
		}
	case "restoring":
		// a restore is already underway; poll it rather than re-dumping
		final := r.poll(ctx, tg, &res)
		if final {
			return res, 0
		}
		if !r.c.resync {
			res.State, res.Reason = "restore-unconfirmed", "restoring"
			return res, 0
		}
	case "none", "staged", "failed":
		// fall through to the dump path
	default:
		res.State, res.Reason = "failed", "bad-status"
		return res, 0
	}

	// --- Step 6: discover + creds + plan ---
	override := r.overrides[tg.ItemRef]
	src, derr := Resolve(ctx, tg, override, r.dockerPath, r.dockerEnv)
	if derr != nil {
		res.State, res.Reason = discoverOutcome(derr)
		return res, 0
	}
	// One source container must map to at most one itemRef in a run: two itemRefs resolving to the
	// same container (a repeated uuid across serverRefs, or two --map keys) would restore one
	// source's data into a second, wrong destination. Fail closed.
	if prev, dup := r.usedIDs[src.ID]; dup && prev != tg.ItemRef {
		res.State, res.Reason = "failed", "duplicate-source"
		return res, 0
	}
	r.usedIDs[src.ID] = tg.ItemRef

	rc, sk := resolveCreds(tg.Engine, src.inspect)
	if sk != nil {
		res.State, res.Reason = "skipped", sk.reason
		return res, 0
	}
	// Register every resolved value with the scrubber BEFORE anything downstream could log it.
	r.sc.add(rc.pw)
	r.sc.add(rc.user)
	r.sc.add(rc.db)
	creds := Creds{Ctr: src.ID, User: rc.user, DB: rc.db, PW: rc.pw, HasPW: rc.pw != ""}
	plan, berr := BuildPlan(r.parsed[tg.Engine], creds, r.dockerPath, os.LookupEnv)
	if berr != nil {
		res.State, res.Reason = "failed", "invalid-name"
		return res, 0
	}

	// Dragonfly leaves an in-container temp file; clean it up in all paths.
	if tg.Engine == "DRAGONFLY" {
		defer cleanupInContainer(src.ID, r.dockerPath, r.dockerEnv)
	}

	// --- dump ---
	dr, dumpErr := dumpOne(ctx, r.dockerPath, plan, r.spoolDir, r.maxGz, r.c.dumpTimeout)
	if dumpErr != nil {
		res.State, res.Reason = "failed", dumpReason(dumpErr)
		return res, 0
	}
	defer os.RemoveAll(dirOf(dr.Path))
	res.RawBytes = dr.RawBytes

	// --- Step 7: upload + verify the hub's independent measurements ---
	f, oerr := os.Open(dr.Path)
	if oerr != nil {
		res.State, res.Reason = "failed", "spool-space"
		return res, 0
	}
	pq := PutQuery{Gzip: true}
	if tg.Engine == "POSTGRES" && plan.PgFormat == "custom" {
		pq.Format = "custom"
	}
	uctx, ucancel := context.WithTimeout(ctx, r.c.dumpTimeout)
	put, uerr := r.hub.Put(uctx, tg.ItemRef, f, dr.GzBytes, pq)
	ucancel()
	_ = f.Close()
	if uerr != nil {
		if a := abortKind(uerr); a != 0 {
			return res, a
		}
		res.State, res.Reason = "failed", uploadReason(uerr)
		return res, 0
	}
	if put.ItemRef != tg.ItemRef || put.Bytes != dr.GzBytes || put.Sha256 != dr.SHA256 || !put.Gzip {
		res.State, res.Reason = "failed", "integrity-mismatch"
		return res, 0
	}
	res.Bytes = put.Bytes
	res.Sha256 = put.Sha256
	_ = os.RemoveAll(dirOf(dr.Path)) // free disk before the (possibly long) restore

	// --- Step 8: restore + poll ---
	roctx, rocancel := context.WithTimeout(ctx, 30*time.Second)
	rr, rerr := r.hub.Restore(roctx, tg.ItemRef, r.c.resync)
	rocancel()
	if rerr != nil {
		if a := abortKind(rerr); a != 0 {
			return res, a
		}
		// Only poll when the hub says a restore is genuinely IN FLIGHT. For any OTHER POST failure we
		// must NOT trust a terminal /status: the hub does not reset the prior data task when a new
		// artifact is staged, so a stale DONE/FAILED row from an earlier restore would otherwise be
		// read as THIS run's success (a silent stale-data false positive under --resync).
		if kindOf(rerr) == KindRestoreInProgress && r.poll(ctx, tg, &res) {
			return res, 0
		}
		res.State, res.Reason = "failed", restoreReason(rerr)
		return res, 0
	}
	if rr.State == "restored" && rr.AlreadyRestored {
		res.State = "already-restored"
		return res, 0
	}
	if r.poll(ctx, tg, &res) {
		return res, 0
	}
	res.State, res.Reason = "restore-unconfirmed", "restore-timeout"
	return res, 0
}

// poll polls /status with jittered backoff until terminal or the restore timeout. It sets res and
// returns true once a terminal state (restored / already-restored / failed) was reached.
func (r *runner) poll(ctx context.Context, tg Target, res *itemResult) bool {
	deadline := time.Now().Add(r.c.restoreTimeout)
	backoff := 3 * time.Second
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return false
		}
		sctx, scancel := context.WithTimeout(ctx, 30*time.Second)
		st, err := r.hub.Status(sctx, tg.ItemRef)
		scancel()
		if err != nil {
			if kindOf(err) == KindAuth {
				return false // token died mid-poll; stop now rather than burning the whole timeout
			}
		} else {
			switch st.State {
			case "restored":
				res.State = "restored"
				return true
			case "failed":
				res.State, res.Reason = "failed", "restore-failed"
				res.HubExit = st.ExitCode
				return true
			}
		}
		if waitRetry(ctx, jitter(backoff)) != nil {
			return false // interrupted
		}
		if backoff < 10*time.Second {
			backoff += 2 * time.Second
		}
	}
	return false
}

// ---- helpers --------------------------------------------------------------------------------

func parseFlags(args []string, stderr io.Writer) (*cli, error) {
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	c := &cli{}
	fs.StringVar(&c.hub, "hub", envOrEmpty("TUGRA_HUB"), "hub base URL, e.g. https://hub.example.com")
	fs.StringVar(&c.token, "token", "", "migration token (prefer TUGRA_MIGRATION_TOKEN or --token-file)")
	fs.StringVar(&c.tokenFile, "token-file", "", "path to a file holding the migration token")
	fs.Var(&c.only, "only", "restrict to this itemRef (repeatable)")
	fs.Var(&c.mapp, "map", "map an itemRef to a container: itemRef=container (repeatable)")
	fs.BoolVar(&c.resync, "resync", false, "re-dump and overwrite an already-restored destination")
	fs.BoolVar(&c.dryRun, "dry-run", false, "print the per-item plan and exit without dumping")
	fs.BoolVar(&c.handshake, "handshake", false, "verify the hub + recipe contract and exit")
	fs.BoolVar(&c.allowInsecure, "allow-insecure-http", false, "permit a non-loopback http:// hub (cleartext token + dumps)")
	fs.StringVar(&c.spoolDir, "spool-dir", "", "directory to spool gzip artifacts (default: a temp dir)")
	fs.Int64Var(&c.maxGzBytes, "max-gz-bytes", 0, "cap the compressed artifact size (default: the hub's cap)")
	fs.DurationVar(&c.dumpTimeout, "dump-timeout", 20*time.Minute, "per-item dump+upload timeout")
	fs.DurationVar(&c.restoreTimeout, "restore-timeout", 12*time.Minute, "per-item restore-wait timeout")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	return c, nil
}

func envOrEmpty(k string) string { v, _ := os.LookupEnv(k); return v }

func resolveToken(c *cli) (string, error) {
	if v := os.Getenv("TUGRA_MIGRATION_TOKEN"); v != "" {
		return strings.TrimSpace(v), nil
	}
	if c.tokenFile != "" {
		b, err := os.ReadFile(c.tokenFile)
		if err != nil {
			return "", fmt.Errorf("could not read --token-file")
		}
		return strings.TrimSpace(string(b)), nil
	}
	if c.token != "" {
		return strings.TrimSpace(c.token), nil
	}
	return "", fmt.Errorf("no migration token (set TUGRA_MIGRATION_TOKEN, --token-file or --token)")
}

func validateHub(hub string, allowInsecure bool) error {
	if hub == "" {
		return fmt.Errorf("missing --hub")
	}
	if !safeBaseRe.MatchString(hub) {
		return fmt.Errorf("unsafe or malformed URL")
	}
	// reject userinfo/query/fragment
	if strings.ContainsAny(hub, "?#") || strings.Contains(hub, "@") {
		return fmt.Errorf("the URL must have no userinfo, query or fragment")
	}
	if strings.HasPrefix(hub, "http://") {
		host := strings.TrimPrefix(hub, "http://")
		if i := strings.IndexAny(host, ":/"); i >= 0 {
			host = host[:i]
		}
		if !allowInsecure && !isLoopbackHost(host) {
			return fmt.Errorf("refusing a non-loopback http:// hub (use https or --allow-insecure-http)")
		}
	}
	return nil
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	// Only a real loopback IP literal passes — NOT a hostname that merely starts with "127."
	// (e.g. "127.evil.example" would resolve to an attacker address while bypassing the cleartext
	// guard). net.ParseIP returns nil for a DNS name, so those fall through to false.
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func lookDocker(env []string) (string, error) {
	// resolve against the allowlisted PATH, not the ambient one
	path := "/usr/local/bin:/usr/bin:/bin"
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, "PATH="); ok {
			path = v
		}
	}
	old, had := os.LookupEnv("PATH")
	_ = os.Setenv("PATH", path)
	p, err := exec.LookPath("docker")
	if had {
		_ = os.Setenv("PATH", old)
	} else {
		_ = os.Unsetenv("PATH")
	}
	if err != nil {
		return "", fmt.Errorf("docker not found on PATH")
	}
	return p, nil
}

func parseMap(entries []string) (map[string]string, error) {
	m := map[string]string{}
	containers := map[string]string{}
	for _, e := range entries {
		k, v, ok := strings.Cut(e, "=")
		if !ok || k == "" || v == "" {
			return nil, fmt.Errorf("each --map must be itemRef=container")
		}
		if strings.Contains(v, "=") {
			return nil, fmt.Errorf("container value must not contain '='")
		}
		if _, dup := m[k]; dup {
			return nil, fmt.Errorf("duplicate --map key")
		}
		if prev, dup := containers[v]; dup && prev != k {
			return nil, fmt.Errorf("two --map keys point at one container")
		}
		m[k] = v
		containers[v] = k
	}
	return m, nil
}

// prepareSpool returns the spool dir and whether WE created it (so the caller can remove it at the
// end of the run). A caller-supplied --spool-dir is left in place.
func prepareSpool(dir string) (string, bool, error) {
	if dir == "" {
		d, err := os.MkdirTemp("", "tugra-migrate-spool-*")
		if err != nil {
			return "", false, err
		}
		return d, true, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", false, err
	}
	return dir, false, nil
}

func selectTargets(all []Target, only stringList) []Target {
	allow := map[string]bool{}
	for _, o := range only {
		allow[o] = true
	}
	var out []Target
	for _, tg := range all {
		if tg.Kind != "database" {
			continue
		}
		if len(allow) > 0 && !allow[tg.ItemRef] {
			continue
		}
		out = append(out, tg)
	}
	// insertion sort by itemRef
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ItemRef < out[j-1].ItemRef; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

type planned struct{ state, reason string }

func planState(tg Target, parsed map[string]*Parsed, rejected map[string]bool) planned {
	if tg.DataPlane == "unsupported" {
		return planned{"unsupported", sanitizeReason(tg.Reason)}
	}
	if _, ok := engineSpecs[tg.Engine]; !ok {
		return planned{"unsupported", "no-recipe"}
	}
	if rejected[tg.Engine] || parsed[tg.Engine] == nil {
		return planned{"skipped", "no-recipe"}
	}
	return planned{"planned", "would-migrate"} // dry-run marker; NOT a restore
}

func tallyState(c *counts, state string) {
	switch state {
	case "restored":
		c.Restored++
	case "already-restored":
		c.AlreadyRestored++
	case "failed":
		c.Failed++
	case "skipped":
		c.Skipped++
	case "unsupported":
		c.Unsupported++
	case "restore-unconfirmed":
		c.Unconfirmed++
	}
}

func partialOrOK(c counts) int {
	if c.Failed > 0 || c.Skipped > 0 || c.Unsupported > 0 || c.Unconfirmed > 0 {
		return exitPartial
	}
	return exitOK
}

func codeName(code int) string {
	switch code {
	case exitOK:
		return "ok"
	case exitPartial:
		return "partial"
	case exitUsage:
		return "usage"
	case exitAuth:
		return "auth"
	case exitUnreachable:
		return "unreachable"
	case exitSkew:
		return "skew"
	case exitPrecondition:
		return "precondition"
	case exitInterrupted:
		return "interrupted"
	default:
		return "error"
	}
}

// dockerBaseEnv builds the allowlisted env for docker ps/inspect/cleanup (no TUGRA_SRC_*).
func dockerBaseEnv(lookup func(string) (string, bool)) []string {
	env := map[string]string{}
	for _, name := range childEnvAllowlist {
		if v, ok := lookup(name); ok && v != "" && !strings.ContainsRune(v, 0) {
			env[name] = v
		}
	}
	if _, ok := env["PATH"]; !ok {
		env["PATH"] = defaultPath
	}
	return flattenEnv(env)
}

func kindOf(err error) ErrKind {
	var he *HubError
	if errors.As(err, &he) {
		return he.Kind
	}
	return KindOther
}

// classifyAbort maps a control-plane error to an abort exit code.
func classifyAbort(ctx context.Context, err error, logf func(string, ...any), stage string) int {
	if ctx.Err() != nil {
		return exitInterrupted // a signal, not a hub problem
	}
	switch kindOf(err) {
	case KindAuth:
		logf("%s: authentication failed (reissue the token)", stage)
		return exitAuth
	case KindDecode:
		logf("%s: the hub response did not match the expected contract (version skew? re-download the migrator)", stage)
		return exitSkew
	case KindRedirect, KindRateLimited, KindServer:
		logf("%s: hub unreachable: %v", stage, err)
		return exitUnreachable
	default:
		logf("%s: %v", stage, err)
		return exitUnreachable
	}
}

// abortKind returns a non-zero abort code for errors that must stop the whole run.
func abortKind(err error) int {
	switch kindOf(err) {
	case KindAuth:
		return exitAuth
	case KindHubMisconfig:
		return exitUnreachable
	default:
		return 0
	}
}

func discoverOutcome(err error) (state, reason string) {
	switch {
	case errors.Is(err, ErrNotFound):
		return "skipped", "unresolved"
	case errors.Is(err, ErrNotRunning):
		return "skipped", "not-running"
	case errors.Is(err, ErrAmbiguous):
		return "failed", "ambiguous"
	case errors.Is(err, ErrForbidden):
		return "failed", "forbidden-container"
	case errors.Is(err, ErrEngineMismatch):
		return "failed", "engine-mismatch"
	default:
		return "failed", "discover"
	}
}

func dumpReason(err error) string {
	switch {
	case errors.Is(err, errDumpTimeout):
		return "dump-timeout"
	case errors.Is(err, errDumpTooBig):
		return "dump-too-big"
	case errors.Is(err, errEmptyDump):
		return "empty-dump"
	case errors.Is(err, errBadFormat):
		return "bad-format"
	case errors.Is(err, errDumpCanceled):
		return "interrupted"
	default:
		return "dump-exit"
	}
}

func uploadReason(err error) string {
	switch kindOf(err) {
	case KindTooLarge:
		return "too-large"
	case KindNoSpace:
		return "no-space"
	case KindBadMedia, KindLengthRequired, KindBadRequest:
		return "upload-rejected"
	default:
		return "upload-failed"
	}
}

func restoreReason(err error) string {
	switch kindOf(err) {
	case KindDestDirty:
		return "dest-dirty"
	case KindDestGone:
		return "dest-gone"
	case KindDifferentRestored:
		return "restored-differs"
	case KindNotStaged:
		return "not-staged"
	default:
		return "restore-failed"
	}
}

var reasonRe = regexp.MustCompile(`^[a-zA-Z0-9 _.:/-]{0,64}$`)

func sanitizeReason(s string) string {
	if s == "" {
		return "unsupported"
	}
	if reasonRe.MatchString(s) {
		return s
	}
	return "unsupported"
}

func dirOf(p string) string {
	if i := strings.LastIndexByte(p, '/'); i > 0 {
		return p[:i]
	}
	return "."
}

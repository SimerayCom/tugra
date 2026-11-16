package migrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Volume-arm outcomes. run.go maps each to an item state; none of them ever stops, removes or writes anything.
var (
	ErrSourceRunning = errors.New("the source container is running")
	ErrBindRefused   = errors.New("a bind mount is refused unless --allow-bind is given")
	ErrBadMount      = errors.New("the source mount cannot be streamed")
	ErrSpecialFiles  = errors.New("the source volume holds device nodes")
	ErrNoHelper      = errors.New("no helper image: the volume arm needs --helper-image or TUGRA_SELF_IMAGE")
)

var volNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var serverRefRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// ParseVolumeRef splits `volume:<serverRef|_>:<sourceRef>:<volName>` (the hub builds it from the app/database itemRef
// plus the declared volume name). Every part is charset-checked: the result is only ever used as a docker-name-safe
// token, and serverRef is carried for messages only.
func ParseVolumeRef(itemRef string) (serverRef, sourceRef, volName string, err error) {
	if len(itemRef) == 0 || len(itemRef) > 256 {
		return "", "", "", fmt.Errorf("bad itemRef length")
	}
	parts := strings.SplitN(itemRef, ":", 4)
	if len(parts) != 4 || parts[0] != "volume" {
		return "", "", "", fmt.Errorf("itemRef is not a volume ref")
	}
	serverRef, sourceRef, volName = parts[1], parts[2], parts[3]
	if !serverRefRe.MatchString(serverRef) {
		return "", "", "", fmt.Errorf("server reference has an unsafe charset")
	}
	if !sourceRefRe.MatchString(sourceRef) {
		return "", "", "", fmt.Errorf("source reference has an unsafe charset")
	}
	if !volNameRe.MatchString(volName) {
		return "", "", "", fmt.Errorf("volume name has an unsafe charset")
	}
	return serverRef, sourceRef, volName, nil
}

// srcState is the container state the quiescence proof is built from.
type srcState struct {
	Running, Restarting, Paused bool
	ExitCode                    int
	StartedAt, FinishedAt       string
}

// volSource is one validated source volume: the container (immutable 64-hex id), the single mount that backs the
// target volume, and the container's state at inspection time.
type volSource struct {
	ContainerID, Name, Image, ImageID string
	MountType                         string // "volume" | "bind"
	VolumeName, HostPath, Destination string
	State                             srcState
}

// pgParentMount is where a PostgreSQL 18+ image mounts its volume (PGDATA lives one level down, `<major>/docker`).
const pgParentMount = "/var/lib/postgresql"

// ResolveVolume maps one volume Target to the container + mount that holds its data. It uses `docker ps -a`, so a
// STOPPED container resolves (the arm needs it stopped), picks the single Mounts[] entry whose Destination equals the
// target's mount path (db-data also accepts the PostgreSQL 18 parent mount, so the layout gate can refuse it with its
// own reason), refuses Tugra/Coolify control-plane containers and never requires the container to be running.
func ResolveVolume(ctx context.Context, tg Target, override, dockerPath string, env []string) (*volSource, error) {
	if tg.Kind != "volume" || tg.Dest == nil {
		return nil, ErrNotFound
	}
	_, sourceRef, _, err := ParseVolumeRef(tg.ItemRef)
	if err != nil {
		return nil, err
	}
	rows, err := dockerPS(ctx, dockerPath, env)
	if err != nil {
		return nil, err
	}
	id, err := resolveContainerID(sourceRef, override, rows, tg.Dest.Type == "app-volume")
	if err != nil {
		return nil, err
	}
	info, err := dockerInspect(ctx, dockerPath, id, env)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(info.ID, id) {
		return nil, ErrNotFound // the daemon answered for a different container than asked
	}
	name := strings.TrimPrefix(info.Name, "/")
	if isForbiddenName(name) || isForbiddenName(sourceRef) {
		return nil, ErrForbidden
	}
	want := path.Clean(tg.Dest.MountPath)
	alt := ""
	if tg.Dest.Type == "db-data" {
		alt = pgParentMount
	}
	var match *dockerMount
	for i := range info.Mounts {
		m := &info.Mounts[i]
		if path.Clean(m.Destination) == want {
			match = m
			break
		}
		if alt != "" && path.Clean(m.Destination) == alt && match == nil {
			match = m
		}
	}
	if match == nil {
		return nil, ErrNotFound
	}
	vs := &volSource{
		ContainerID: info.ID,
		Name:        name,
		Image:       info.Config.Image,
		ImageID:     info.Image,
		Destination: path.Clean(match.Destination),
		State: srcState{
			Running: info.State.Running, Restarting: info.State.Restarting, Paused: info.State.Paused,
			ExitCode: info.State.ExitCode, StartedAt: info.State.StartedAt, FinishedAt: info.State.FinishedAt,
		},
	}
	switch match.Type {
	case "volume":
		if !dockerVolNameRe.MatchString(match.Name) {
			return nil, ErrBadMount
		}
		vs.MountType, vs.VolumeName = "volume", match.Name
	case "bind":
		vs.MountType, vs.HostPath = "bind", match.Source
	default:
		return nil, ErrBadMount // tmpfs, npipe, cluster: nothing durable to copy
	}
	return vs, nil
}

var dockerVolNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// mountSrc is the validated `-v` source of the helper container (a volume name or a bind host path).
func (s *volSource) mountSrc() (string, error) {
	if s.MountType == "volume" {
		if !dockerVolNameRe.MatchString(s.VolumeName) {
			return "", ErrBadMount
		}
		return s.VolumeName, nil
	}
	if err := CheckBindPath(s.HostPath); err != nil {
		return "", err
	}
	return s.HostPath, nil
}

var bindPathRe = regexp.MustCompile(`^/[A-Za-z0-9._@+/-]+$`)

// bindDenyExact / bindDenyPrefix: host paths that are never streamed (system and secret locations).
var bindDenyExact = map[string]bool{"/": true, "/etc": true, "/proc": true, "/sys": true, "/dev": true, "/run": true, "/root": true, "/boot": true, "/var": true, "/usr": true, "/home": true}
var bindDenyPrefix = []string{"/etc/", "/proc/", "/sys/", "/dev/", "/run/", "/var/run/", "/root/", "/boot/", "/var/lib/docker", "/data/coolify/ssh", "/data/coolify/proxy"}

// CheckBindPath is the denylist for an opt-in (--allow-bind) bind mount. The path must come from the matched
// container's OWN Mounts (never from the hub), have a plain charset (it ends up in a `-v` flag), and not be a system,
// docker, Coolify-secret or socket location. Symlinks are resolved when the path is visible to the migrator (it runs in
// a container that sees only docker.sock, so for most host paths the daemon resolves them at mount time; the lexical
// check still applies to the path as given and to the resolved one when it can be resolved).
func CheckBindPath(hostPath string) error {
	if !bindPathRe.MatchString(hostPath) || strings.Contains(hostPath, "//") {
		return fmt.Errorf("%w: unsafe path", ErrBindRefused)
	}
	cands := []string{path.Clean(hostPath)}
	if ev, err := filepath.EvalSymlinks(hostPath); err == nil {
		cands = append(cands, path.Clean(ev))
	}
	for _, c := range cands {
		if strings.Contains(c, "..") {
			return fmt.Errorf("%w: traversal", ErrBindRefused)
		}
		if bindDenyExact[c] || strings.HasSuffix(c, ".sock") || strings.HasSuffix(c, "docker.sock") {
			return fmt.Errorf("%w: protected path", ErrBindRefused)
		}
		for _, p := range bindDenyPrefix {
			if c == strings.TrimSuffix(p, "/") || strings.HasPrefix(c, p) {
				return fmt.Errorf("%w: protected path", ErrBindRefused)
			}
		}
	}
	return nil
}

// VerifyQuiescent proves the source is not writing: the container is not running, restarting or paused, and no OTHER
// running container mounts the same volume / path. The caller re-checks after the last byte. The hub cannot verify
// this (it is the source host's own report) and labels it "reported by the migrator".
func VerifyQuiescent(ctx context.Context, dockerPath string, env []string, s *volSource) error {
	if s.State.Running || s.State.Restarting || s.State.Paused {
		return fmt.Errorf("%w: stop %s first", ErrSourceRunning, s.Name)
	}
	filter := s.VolumeName
	if s.MountType == "bind" {
		filter = s.HostPath
	}
	cctx, cancel := context.WithTimeout(ctx, dockerCallTimeout)
	defer cancel()
	out, stderr, err := runDocker(cctx, []string{dockerPath, "ps", "-q", "--no-trunc", "--filter", "volume=" + filter}, env)
	if err != nil {
		return fmt.Errorf("docker ps failed: %v (%s)", err, firstLine(stderr))
	}
	for _, line := range strings.Split(string(out), "\n") {
		id := strings.TrimSpace(line)
		if id == "" {
			continue
		}
		if !hex64Re.MatchString(id) {
			return fmt.Errorf("could not read the containers using the volume")
		}
		if !strings.EqualFold(id, s.ContainerID) {
			return fmt.Errorf("%w: another running container uses this volume", ErrSourceRunning)
		}
	}
	return nil
}

// Fingerprint identifies the exact source state a copy was taken from; the hub refuses to apply when it changes.
type Fingerprint struct {
	ContainerID, StartedAt, FinishedAt string
	ExitCode                           int
	MountType, MountName, ImageID      string
	PgMajor                            string
}

func (s *volSource) fingerprint(pgMajor string) Fingerprint {
	name := s.VolumeName
	return Fingerprint{ContainerID: s.ContainerID, StartedAt: s.State.StartedAt, FinishedAt: s.State.FinishedAt, ExitCode: s.State.ExitCode, MountType: s.MountType, MountName: name, ImageID: s.ImageID, PgMajor: pgMajor}
}

// Inventory is the read-only inspection of one source volume (size, entries, special files, Postgres facts).
type Inventory struct {
	Found                                          bool
	RawBytes, Entries                              int64
	Sockets, Fifos, Devices                        int
	PgMajor, PgLayout, MountDest, Image, MountType string
}

// invScript is a CONSTANT script (no interpolation): it only reads. `du -sb` is the apparent size; the tar stream is a
// little larger (512-byte headers and padding), the hub treats the number as advisory.
const invScript = `B=$(du -sb /data 2>/dev/null | cut -f1)
E=$(find /data -mindepth 1 ! -type s %s | wc -l | tr -d ' ')
S=$(find /data -type s | wc -l | tr -d ' ')
F=$(find /data -type p | wc -l | tr -d ' ')
D=$(find /data \( -type b -o -type c \) | wc -l | tr -d ' ')
V=$(cat /data/PG_VERSION 2>/dev/null | tr -d ' \r\n')
N=$(ls -d /data/[0-9]*/docker/PG_VERSION 2>/dev/null | head -n 1 | cut -d/ -f3)
echo "TUGRA_INV bytes=${B:-x} entries=${E:-x} sockets=${S:-x} fifos=${F:-x} devices=${D:-x} pgv=${V:--} nested=${N:--}"`

var invLineRe = regexp.MustCompile(`^TUGRA_INV bytes=(\d+) entries=(\d+) sockets=(\d+) fifos=(\d+) devices=(\d+) pgv=(\d{1,2}|-) nested=(\d{1,2}|-)$`)

// helperHardening are the flags every helper container (inventory and tar) runs with: no network, read-only root, no
// capabilities except DAC_READ_SEARCH (read/search bypass only: root with --cap-drop ALL cannot read 0600 files owned
// by uid 999/70 nor traverse 0700 directories), no privilege escalation, a pid cap, and NEVER a pull.
func helperHardening(name string) []string {
	argv := []string{"--rm", "-i", "--pull=never", "--name", name, "--label", "tugra.vx=1"}
	if helperOwner != "" {
		argv = append(argv, "--label", "tugra.vx.owner="+helperOwner)
	}
	return append(argv,
		"--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
		"--security-opt", "no-new-privileges", "--pids-limit", "64", "--user", "0",
	)
}

var ownerRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

// helperOwner names the migrator that starts a helper: its hostname, which is the migrator container's short id in the
// shipped mode (docker run without --hostname). The stale-helper reaper spares helpers whose owner is still running, so
// two migrators on one host never remove each other's helpers mid-stream.
var helperOwner = func() string {
	h, err := os.Hostname()
	if err != nil || !ownerRe.MatchString(h) {
		return ""
	}
	return h
}()

// inventoryHelperName is the docker name of the inventory helper of one container. Two migrators on one host (two runs, or
// two teams of one fleet) can inventory the same container at the same time, and docker refuses a second container of the
// same name, so the name carries the run id exactly like the tar helper's (`tugra-vx-<run>-<container>`). An empty run id
// keeps the legacy run-less name.
func inventoryHelperName(runID, containerID string) string {
	if runID == "" {
		return "tugra-vx-inv-" + shortID(containerID)
	}
	return "tugra-vx-inv-" + shortRun(runID) + "-" + shortID(containerID)
}

// InventoryVolume measures the source volume with the helper image (the migrator's own image: never a pull on the
// customer's host). Output is parsed strictly and any deviation is an error (fail closed). excludes are the tar
// excludes (`postmaster.pid`), so the entry count equals what the archive will hold. It names its helper without a run id;
// a migrator that has one calls {@link InventoryVolumeFor}.
func InventoryVolume(ctx context.Context, dockerPath string, env []string, helper string, s *volSource, excludes []string) (Inventory, error) {
	return InventoryVolumeFor(ctx, "", dockerPath, env, helper, s, excludes)
}

// InventoryVolumeFor is InventoryVolume with the migrator's run id in the helper's name (see inventoryHelperName).
func InventoryVolumeFor(ctx context.Context, runID, dockerPath string, env []string, helper string, s *volSource, excludes []string) (Inventory, error) {
	if helper == "" {
		return Inventory{}, ErrNoHelper
	}
	src, err := s.mountSrc()
	if err != nil {
		return Inventory{}, err
	}
	excl := ""
	for _, e := range excludes {
		if !safeExcludeRe.MatchString(e) {
			return Inventory{}, fmt.Errorf("unsafe exclude")
		}
		excl += "! -path /data/" + e + " "
	}
	script := fmt.Sprintf(invScript, strings.TrimSpace(excl))
	argv := append([]string{dockerPath, "run"}, helperHardening(inventoryHelperName(runID, s.ContainerID))...)
	argv = append(argv, "-v", src+":/data:ro", "--entrypoint", "sh", helper, "-c", script)
	cctx, cancel := context.WithTimeout(ctx, inventoryTimeout)
	defer cancel()
	out, stderr, err := runDocker(cctx, argv, env)
	if err != nil {
		return Inventory{}, fmt.Errorf("inventory helper failed: %v (%s)", err, firstLine(stderr))
	}
	inv, err := parseInventory(string(out))
	if err != nil {
		return Inventory{}, err
	}
	inv.Found, inv.Image, inv.MountDest, inv.MountType = true, s.Image, s.Destination, s.MountType
	return inv, nil
}

// inventoryTimeout bounds the helper's du/find over the whole volume (minutes on tens of GiB).
const inventoryTimeout = 45 * time.Minute

var safeExcludeRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func shortID(id string) string {
	if len(id) >= 8 {
		return id[:8]
	}
	return id
}

func parseInventory(out string) (Inventory, error) {
	var hit string
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimRight(l, "\r")
		if strings.HasPrefix(l, "TUGRA_INV") {
			if hit != "" {
				return Inventory{}, fmt.Errorf("inventory output is ambiguous")
			}
			hit = l
		}
	}
	m := invLineRe.FindStringSubmatch(hit)
	if m == nil {
		return Inventory{}, fmt.Errorf("inventory output is malformed")
	}
	n := func(i int) int64 { v, _ := strconv.ParseInt(m[i], 10, 64); return v }
	inv := Inventory{RawBytes: n(1), Entries: n(2), Sockets: int(n(3)), Fifos: int(n(4)), Devices: int(n(5)), PgLayout: "none"}
	switch {
	case m[6] != "-":
		inv.PgMajor, inv.PgLayout = m[6], "root"
	case m[7] != "-":
		inv.PgMajor, inv.PgLayout = m[7], "nested"
	}
	return inv, nil
}

package client

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"

	"github.com/SimerayCom/tugra/agent/internal/ctrfs"
	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

type ctrRec struct {
	calls []string
	api   ctrAPI
	opts  ctrfs.WriteOpts
	mode  fs.FileMode
	pars  bool
	rec   bool
	args  []string
}

func newCtrRec() *ctrRec {
	r := &ctrRec{}
	st := protocol.FsStat{Name: "x", Type: "file", Size: 3, Etag: "3-1"}
	r.api = ctrAPI{
		Stat: func(ctx context.Context, name, p string) (protocol.FsStat, error) {
			r.calls = append(r.calls, "stat "+p)
			return st, nil
		},
		List: func(ctx context.Context, name, dir string) ([]protocol.FsEntry, bool, error) {
			r.calls = append(r.calls, "list "+dir)
			return []protocol.FsEntry{{Name: "a", Type: "file"}}, true, nil
		},
		ReadTo: func(ctx context.Context, name, p string, size int64, w io.Writer) error {
			r.calls = append(r.calls, "read "+p)
			_, err := w.Write([]byte("abc"))
			return err
		},
		Write: func(ctx context.Context, name, p string, o ctrfs.WriteOpts, src io.Reader) (ctrfs.WriteResult, error) {
			b, _ := io.ReadAll(src)
			r.calls = append(r.calls, "write "+p+" "+string(b))
			r.opts = o
			return ctrfs.WriteResult{Bytes: int64(len(b)), Sha256: "s", Etag: "e", Created: !o.Overwrite}, nil
		},
		Mkdir: func(ctx context.Context, name, p string, mode fs.FileMode, parents bool) error {
			r.calls = append(r.calls, "mkdir "+p)
			r.mode, r.pars = mode, parents
			return nil
		},
		Exec: func(ctx context.Context, name, op, a, b, mode string, recursive bool) error {
			r.calls = append(r.calls, "exec "+op+" "+a)
			r.args, r.rec = []string{op, a, b, mode}, recursive
			return nil
		},
	}
	return r
}

func ctrMsg(op string, mut func(*protocol.ServerMsg)) protocol.ServerMsg {
	m := protocol.ServerMsg{ReqID: "r1", Op: op, Scope: "container", Subject: "tugra_c1", Path: "/app/f", Size: 3, Sha256: tSha, Xfer: tXfer}
	if mut != nil {
		mut(&m)
	}
	return m
}

func gateForCtr(t *testing.T) *fs2Gate {
	t.Helper()
	h := newFs2Harness(t, allFiles, "")
	return h.g
}

func TestContainerGateDispatch(t *testing.T) {
	g := gateForCtr(t)
	g.get = func(ctx context.Context, origin, path string, size int64) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader("abc")), nil
	}
	var putBody strings.Builder
	g.putFrom = func(ctx context.Context, origin, path string, size int64, produce func(context.Context, io.Writer) error) error {
		if origin != "http://hub-api:3000" || path != tXfer {
			t.Errorf("origin/path %q %q", origin, path)
		}
		return produce(ctx, &putBody)
	}

	r := newCtrRec()
	if res := runContainer(context.Background(), ctrMsg("list", func(m *protocol.ServerMsg) { m.Path = "/app" }), g, r.api); !res.OK || len(res.Entries) != 1 || !res.Truncated {
		t.Fatalf("list %+v", res)
	}
	if res := runContainer(context.Background(), ctrMsg("stat", nil), g, r.api); !res.OK || res.Stat == nil || res.Stat.Etag != "3-1" {
		t.Fatalf("stat %+v", res)
	}
	res := runContainer(context.Background(), ctrMsg("read", nil), g, r.api)
	if !res.OK || res.Bytes != 3 || putBody.String() != "abc" || res.Sha256 != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("read %+v body %q", res, putBody.String())
	}
	res = runContainer(context.Background(), ctrMsg("write", func(m *protocol.ServerMsg) { m.Flags, m.Mode, m.IfMatch = "o", "0600", "3-1" }), g, r.api)
	if !res.OK || res.Bytes != 3 || res.Etag != "e" || res.Created {
		t.Fatalf("write %+v", res)
	}
	if !r.opts.Overwrite || !r.opts.HasMode || r.opts.Mode != 0o600 || r.opts.Size != 3 || r.opts.Sha256 != tSha || r.opts.IfMatch != "3-1" {
		t.Fatalf("write opts %+v", r.opts)
	}
	res = runContainer(context.Background(), ctrMsg("mkdir", func(m *protocol.ServerMsg) { m.Flags = "p" }), g, r.api)
	if !res.OK || res.Stat == nil || !res.Created || r.mode != 0o755 || !r.pars {
		t.Fatalf("mkdir %+v mode=%o parents=%v", res, r.mode, r.pars)
	}
	res = runContainer(context.Background(), ctrMsg("rename", func(m *protocol.ServerMsg) { m.Path2 = "/app/g" }), g, r.api)
	if !res.OK || res.Stat == nil || strings.Join(r.args, "|") != "rename|/app/f|/app/g|" {
		t.Fatalf("rename %+v %v", res, r.args)
	}
	res = runContainer(context.Background(), ctrMsg("chmod", func(m *protocol.ServerMsg) { m.Mode = "0640" }), g, r.api)
	if !res.OK || strings.Join(r.args, "|") != "chmod|/app/f||0640" {
		t.Fatalf("chmod %+v %v", res, r.args)
	}
	res = runContainer(context.Background(), ctrMsg("delete", func(m *protocol.ServerMsg) { m.Flags = "r" }), g, r.api)
	if !res.OK || res.Stat != nil || !r.rec {
		t.Fatalf("delete %+v", res)
	}
}

func TestContainerGateRefusesBadSubjectsWithoutTouchingDocker(t *testing.T) {
	g := gateForCtr(t)
	r := newCtrRec()
	for _, bad := range []string{"nginx", "tugra_x__rollout", "tugra_x__prev", "-x", "tugra_a b", ""} {
		res := runContainer(context.Background(), ctrMsg("stat", func(m *protocol.ServerMsg) { m.Subject = bad }), g, r.api)
		if res.OK || res.Code != "bad_request" {
			t.Errorf("%q: %+v", bad, res)
		}
	}
	if len(r.calls) != 0 {
		t.Fatalf("driver reached: %v", r.calls)
	}
	if res := runContainer(context.Background(), ctrMsg("exec", nil), g, r.api); res.Code != "bad_request" {
		t.Fatalf("%+v", res)
	}
	if res := runContainer(context.Background(), ctrMsg("chmod", nil), g, r.api); res.Code != "bad_request" {
		t.Fatalf("chmod without a mode: %+v", res)
	}
	if res := runContainer(context.Background(), ctrMsg("rename", nil), g, r.api); res.Code != "bad_request" {
		t.Fatalf("rename without a destination: %+v", res)
	}
}

func TestContainerGateSurfacesTypedDriverErrors(t *testing.T) {
	g := gateForCtr(t)
	r := newCtrRec()
	r.api.Exec = func(context.Context, string, string, string, string, string, bool) error {
		return &fsd.Error{Code: fsd.CodeNoBinary, Msg: "the container image does not include the tool for this operation"}
	}
	r.api.Stat = func(context.Context, string, string) (protocol.FsStat, error) {
		return protocol.FsStat{}, errors.New("docker exploded at /root/x")
	}
	res := runContainer(context.Background(), ctrMsg("delete", nil), g, r.api)
	if res.OK || res.Code != "no_binary" {
		t.Fatalf("%+v", res)
	}
	res = runContainer(context.Background(), ctrMsg("stat", nil), g, r.api)
	if res.OK || res.Code != "failed" || strings.Contains(res.Error, "/root") {
		t.Fatalf("untyped driver error must not leak: %+v", res)
	}
}

// End to end through the gate: a signed container request needs files + files_write + terminal, runs through the
// container executor with the container scope, and does not need the agent image.
func TestContainerGateEndToEndThroughHandle(t *testing.T) {
	h := newFs2Harness(t, allFiles, "")
	var gotScope string
	h.g.container = func(ctx context.Context, m protocol.ServerMsg, g *fs2Gate) protocol.Fs2Result {
		gotScope = m.Scope
		return runContainer(ctx, m, g, newCtrRec().api)
	}
	h.g.handle(context.Background(), h.msg("container", "stat", nil))
	if r := h.expectReply(); !r.OK || r.Stat == nil || gotScope != "container" {
		t.Fatalf("%+v scope=%q", r, gotScope)
	}
	// a container write needs a sha256 too (the agent verifies the staged body before touching the container)
	h.g.handle(context.Background(), h.msg("container", "write", func(m *protocol.ServerMsg) { m.Sha256 = "" }))
	if r := h.expectReply(); r.OK || r.Code != "bad_request" {
		t.Fatalf("%+v", r)
	}
}

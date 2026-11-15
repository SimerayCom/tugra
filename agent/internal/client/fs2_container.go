package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strconv"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/ctrfs"
	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
	"github.com/SimerayCom/tugra/agent/internal/xfer"
)

// ctrAPI is the container-filesystem driver as the gate sees it (a seam so the gate's dispatch is unit-testable).
type ctrAPI struct {
	Stat   func(ctx context.Context, name, p string) (protocol.FsStat, error)
	List   func(ctx context.Context, name, dir string) ([]protocol.FsEntry, bool, error)
	ReadTo func(ctx context.Context, name, p string, size int64, w io.Writer) error
	Write  func(ctx context.Context, name, p string, o ctrfs.WriteOpts, src io.Reader) (ctrfs.WriteResult, error)
	Mkdir  func(ctx context.Context, name, p string, mode fs.FileMode, parents bool) error
	Exec   func(ctx context.Context, name, op, a, b, mode string, recursive bool) error
}

var realCtr = ctrAPI{Stat: ctrfs.Stat, List: ctrfs.List, ReadTo: ctrfs.ReadTo, Write: ctrfs.Write, Mkdir: ctrfs.Mkdir, Exec: ctrfs.ExecOp}

// containerFs2 runs one container-scope fs2 request through the ctrfs driver. The gate already verified the
// signature, expiry, replay, the full capability set (files + files_write + terminal) and the field shapes; the
// driver re-validates the container name and path itself.
func containerFs2(ctx context.Context, m protocol.ServerMsg, g *fs2Gate) protocol.Fs2Result {
	return runContainer(ctx, m, g, realCtr)
}

func runContainer(ctx context.Context, m protocol.ServerMsg, g *fs2Gate, c ctrAPI) protocol.Fs2Result {
	res := protocol.Fs2Result{ReqID: m.ReqID}
	if err := ctrfs.ValidateName(m.Subject); err != nil {
		return fs2Err(m.ReqID, &fsd.Error{Code: fsd.CodeBadRequest, Msg: err.Error()})
	}
	fail := func(err error) protocol.Fs2Result { return fs2Err(m.ReqID, err) }
	switch m.Op {
	case "list":
		entries, truncated, err := c.List(ctx, m.Subject, m.Path)
		if err != nil {
			return fail(err)
		}
		res.OK, res.Entries, res.Truncated = true, entries, truncated
	case "stat":
		st, err := c.Stat(ctx, m.Subject, m.Path)
		if err != nil {
			return fail(err)
		}
		res.OK, res.Stat = true, &st
	case "read":
		origin, err := xfer.Origin(g.cfg.HubURL)
		if err != nil {
			return fail(err)
		}
		h := sha256.New()
		var sent int64
		err = g.putFrom(ctx, origin, m.Xfer, m.Size, func(pctx context.Context, w io.Writer) error {
			return c.ReadTo(pctx, m.Subject, m.Path, m.Size, &countHashWriter{w: w, h: h, n: &sent})
		})
		if err != nil {
			return fail(err)
		}
		res.OK, res.Bytes, res.Sha256 = true, sent, hex.EncodeToString(h.Sum(nil))
	case "write":
		origin, err := xfer.Origin(g.cfg.HubURL)
		if err != nil {
			return fail(err)
		}
		body, err := g.get(ctx, origin, m.Xfer, m.Size)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fs2: fetch upload body failed: %v\n", err)
			return fail(&fsd.Error{Code: fsd.CodeFailed, Msg: "could not fetch the upload from the hub"})
		}
		defer body.Close()
		o := ctrfs.WriteOpts{Overwrite: strings.Contains(m.Flags, "o"), Size: m.Size, Sha256: m.Sha256, IfMatch: m.IfMatch}
		if m.Mode != "" {
			o.Mode, o.HasMode = parseOctal(m.Mode), true
		}
		wr, err := c.Write(ctx, m.Subject, m.Path, o, body)
		if err != nil {
			return fail(err)
		}
		res.OK, res.Bytes, res.Sha256, res.Etag, res.Created = true, wr.Bytes, wr.Sha256, wr.Etag, wr.Created
	case "mkdir":
		mode := fs.FileMode(0o755)
		if m.Mode != "" {
			mode = parseOctal(m.Mode)
		}
		if err := c.Mkdir(ctx, m.Subject, m.Path, mode, strings.Contains(m.Flags, "p")); err != nil {
			return fail(err)
		}
		st, err := c.Stat(ctx, m.Subject, m.Path)
		if err != nil {
			return fail(err)
		}
		res.OK, res.Stat, res.Created = true, &st, true
	case "rename", "chmod", "delete":
		if m.Op == "chmod" && m.Mode == "" {
			return fail(&fsd.Error{Code: fsd.CodeBadRequest, Msg: "mode is required"})
		}
		if m.Op == "rename" && m.Path2 == "" {
			return fail(&fsd.Error{Code: fsd.CodeBadRequest, Msg: "destination is required"})
		}
		if err := c.Exec(ctx, m.Subject, m.Op, m.Path, m.Path2, m.Mode, strings.Contains(m.Flags, "r")); err != nil {
			return fail(err)
		}
		res.OK = true
		if m.Op != "delete" {
			target := m.Path
			if m.Op == "rename" {
				target = m.Path2
			}
			if st, err := c.Stat(ctx, m.Subject, target); err == nil {
				res.Stat = &st
			}
		}
	default:
		return fail(&fsd.Error{Code: fsd.CodeBadRequest, Msg: "unsupported operation"})
	}
	return res
}

func parseOctal(s string) fs.FileMode {
	v, _ := strconv.ParseUint(s, 8, 32)
	return fs.FileMode(v & 0o777)
}

package environment

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func (s *SSH) filePath(p string) (string, error) {
	p, e := targetPath(s.identity.Platform, p)
	if e != nil {
		return "", e
	}
	if s.identity.Platform == "windows" {
		return "/" + p, nil
	}
	return p, nil
}
func (s *SSH) fileGuard(ctx context.Context, p string) (string, func(), error) {
	p, e := s.filePath(p)
	if e != nil {
		return "", nil, e
	}
	done, e := s.guard(ctx)
	if e != nil {
		return "", nil, e
	}
	return p, done, nil
}
func (s *SSH) Stat(ctx context.Context, p string) (fs.FileInfo, error) {
	p, done, e := s.fileGuard(ctx, p)
	if e != nil {
		return nil, e
	}
	defer done()
	return s.files.Stat(p)
}
func (s *SSH) Lstat(ctx context.Context, p string) (fs.FileInfo, error) {
	p, done, e := s.fileGuard(ctx, p)
	if e != nil {
		return nil, e
	}
	defer done()
	return s.files.Lstat(p)
}
func (s *SSH) ReadDir(ctx context.Context, p string) ([]fs.FileInfo, error) {
	p, done, e := s.fileGuard(ctx, p)
	if e != nil {
		return nil, e
	}
	defer done()
	return s.files.ReadDirContext(ctx, p)
}
func (s *SSH) MkdirAll(ctx context.Context, p string, mode fs.FileMode) error {
	p, done, e := s.fileGuard(ctx, p)
	if e != nil {
		return e
	}
	defer done()
	root := "/"
	tail := strings.TrimPrefix(p, "/")
	if s.identity.Platform == "windows" {
		root = "/" + tail[:2] + "/"
		tail = strings.TrimPrefix(tail[2:], "/")
	}
	for _, part := range strings.Split(tail, "/") {
		if part == "" {
			continue
		}
		root = path.Join(root, part)
		if e = ctx.Err(); e != nil {
			return e
		}
		info, err := s.files.Stat(root)
		if err == nil {
			if !info.IsDir() {
				return errors.New("target path is not a directory")
			}
			continue
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err = s.files.Mkdir(root); err != nil {
			return unknown(err)
		}
		if s.identity.Platform != "windows" {
			if err = s.files.Chmod(root, mode.Perm()); err != nil {
				return unknown(err)
			}
		}
	}
	return nil
}
func (s *SSH) ReadFile(ctx context.Context, p string, limit int64) ([]byte, error) {
	p, done, e := s.fileGuard(ctx, p)
	if e != nil {
		return nil, e
	}
	defer done()
	f, e := s.files.Open(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	return readBounded(ctx, f, limit)
}
func (s *SSH) write(ctx context.Context, p string, r io.Reader, mode fs.FileMode) error {
	p, done, e := s.fileGuard(ctx, p)
	if e != nil {
		return e
	}
	defer done()
	temp := path.Join(path.Dir(p), ".nexum-write-"+rand.Text())
	f, e := s.files.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if e != nil {
		return e
	}
	defer func() { _ = f.Close(); _ = s.files.Remove(temp) }()
	if s.identity.Platform != "windows" {
		if e = f.Chmod(mode.Perm()); e != nil {
			return e
		}
	}
	if _, e = io.Copy(f, contextReader{ctx, r}); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if _, ok := s.files.HasExtension("posix-rename@openssh.com"); ok {
		if e = s.files.PosixRename(temp, p); e != nil {
			return unknown(e)
		}
		return nil
	}
	// SFTP v3 rename cannot reliably replace an existing file. Never delete
	// an existing destination to fake atomic replacement.
	if _, e = s.files.Lstat(p); e == nil {
		return errors.New("server does not support atomic replacement")
	}
	if !errors.Is(e, fs.ErrNotExist) {
		return e
	}
	if e = s.files.Rename(temp, p); e != nil {
		return unknown(e)
	}
	return nil
}
func (s *SSH) WriteFile(ctx context.Context, p string, data []byte, mode fs.FileMode) error {
	return s.write(ctx, p, bytes.NewReader(data), mode)
}
func (s *SSH) Upload(ctx context.Context, from, to string, mode fs.FileMode) error {
	if !filepath.IsAbs(from) {
		return errors.New("absolute local source required")
	}
	f, e := os.Open(from)
	if e != nil {
		return e
	}
	defer f.Close()
	return s.write(ctx, to, f, mode)
}
func (s *SSH) Download(ctx context.Context, from, to string, mode fs.FileMode) error {
	if !filepath.IsAbs(to) {
		return errors.New("absolute local destination required")
	}
	from, done, e := s.fileGuard(ctx, from)
	if e != nil {
		return e
	}
	defer done()
	f, e := s.files.Open(from)
	if e != nil {
		return e
	}
	defer f.Close()
	return writeLocal(ctx, to, f, mode)
}

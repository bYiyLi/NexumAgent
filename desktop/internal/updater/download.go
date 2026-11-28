package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

func verifyFile(path string, a Artifact) error {
	digest, n, e := fileDigest(path)
	if e != nil {
		return e
	}
	if n != a.Size || digest != a.SHA256 {
		return fmt.Errorf("%w: artifact digest or size mismatch", ErrTrust)
	}
	return nil
}

type Progress func(done, total int64)
type progressWriter struct {
	n      int64
	total  int64
	last   time.Time
	report Progress
}

func (w *progressWriter) Write(b []byte) (int, error) {
	w.n += int64(len(b))
	if w.report != nil && (time.Since(w.last) >= 100*time.Millisecond || w.n == w.total) {
		w.last = time.Now()
		w.report(min(w.n, w.total), w.total)
	}
	return len(b), nil
}

// Download full artifacts only. A partial file is never an install candidate;
// retries reuse only an already fully verified package.
func (s *Source) Download(ctx context.Context, c Config, m Manifest, a Artifact, progress Progress) (string, error) {
	if err := c.Prepare(); err != nil {
		return "", err
	}
	path := c.ArtifactPath(a)
	if verifyFile(path, a) == nil {
		if progress != nil {
			progress(a.Size, a.Size)
		}
		return path, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	res, e := s.get(ctx, assetURL(m.Version, a.Name))
	if e != nil {
		return "", e
	}
	defer res.Body.Close()
	if res.ContentLength >= 0 && res.ContentLength != a.Size {
		return "", fmt.Errorf("%w: download length", ErrTrust)
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".download-")
	if e != nil {
		return "", e
	}
	defer os.Remove(f.Name())
	defer f.Close()
	h := sha256.New()
	pw := &progressWriter{total: a.Size, report: progress}
	if progress != nil {
		progress(0, a.Size)
	}
	n, e := io.Copy(io.MultiWriter(f, h, pw), io.LimitReader(res.Body, a.Size+1))
	if e != nil {
		return "", fmt.Errorf("download: %w", e)
	}
	if n != a.Size || hex.EncodeToString(h.Sum(nil)) != a.SHA256 {
		return "", fmt.Errorf("%w: download digest or size mismatch", ErrTrust)
	}
	if e = f.Sync(); e != nil {
		return "", e
	}
	if e = f.Close(); e != nil {
		return "", e
	}
	if e = replaceFile(f.Name(), path); e != nil {
		return "", e
	}
	return path, nil
}

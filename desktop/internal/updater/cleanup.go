package updater

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Cleanup removes only artifacts belonging to a committed transaction. Any
// uncertainty preserves the evidence. The durable signed version floor stays.
func (c Config) CleanupCompleted(s State) error {
	if s.Phase != "complete" {
		return fmt.Errorf("update not complete")
	}
	m, e := c.validate(s)
	if e != nil {
		return e
	}
	cmp, e := CompareVersions(c.Version, m.Version)
	if e != nil || cmp < 0 {
		return fmt.Errorf("update completion not applicable")
	}
	a, e := m.Artifact(runtime.GOOS, runtime.GOARCH)
	if e != nil {
		return e
	}
	binary, e := currentBinary()
	if e != nil {
		return e
	}
	if cmp == 0 {
		hash, _, e := fileDigest(binary)
		if e != nil || hash != a.BinarySHA256 {
			return fmt.Errorf("current executable not verified")
		}
	}
	job := c.jobDir(s)
	if st, e := os.Lstat(job); e == nil {
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe completed update directory")
		}
		// Preserve the helper's actual install evidence in the client log directory.
		log := filepath.Join(job, "install.log")
		if _, e := os.Lstat(log); e == nil {
			dest := filepath.Join(c.Root, "logs", "update-"+s.Transaction+".log")
			if _, e = os.Lstat(dest); errors.Is(e, os.ErrNotExist) {
				if e = copyFile(log, dest, 0600); e != nil {
					return e
				}
			} else if e != nil {
				return e
			} else {
				first, _, e := fileDigest(log)
				if e != nil {
					return e
				}
				second, _, e := fileDigest(dest)
				if e != nil || first != second {
					return fmt.Errorf("update log copy differs")
				}
			}
		}
		// A prior application may remain on the install volume after the
		// cross-volume move to the private job folder fails.
		if runtime.GOOS == "darwin" {
			bundle := filepath.Dir(filepath.Dir(filepath.Dir(s.SourceBinary)))
			name, _, exe, _ := appIdentity(c.Profile)
			stage := filepath.Join(filepath.Dir(bundle), ".nexum-update-"+s.Transaction)
			if st, e := os.Lstat(stage); e == nil {
				if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
					return fmt.Errorf("unsafe install backup directory")
				}
				old := filepath.Join(stage, name+".app", "Contents", "MacOS", exe)
				h, _, e := fileDigest(old)
				if e != nil || h != s.SourceSHA256 {
					return fmt.Errorf("old application backup not verified")
				}
				if e = os.RemoveAll(stage); e != nil {
					return e
				}
			} else if !errors.Is(e, os.ErrNotExist) {
				return e
			}
		}
		// On Windows the helper can still be finishing its own relaunch. If its
		// executable is locked, keep the remainder and retry cleanup next startup.
		if e = os.RemoveAll(job); e != nil {
			return e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	path := c.ArtifactPath(a)
	if e = verifyFile(path, a); e == nil {
		return os.Remove(path)
	}
	if _, e = os.Lstat(path); !errors.Is(e, os.ErrNotExist) {
		return fmt.Errorf("unverified cached artifact retained")
	}
	return nil
}

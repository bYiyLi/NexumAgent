//go:build darwin

package updater

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func replaceFile(from, to string) error {
	if e := os.Rename(from, to); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(to))
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}
func lockFile(f *os.File) error { return unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB) }
func unlockFile(f *os.File)     { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN) }
func waitParent(pid int, ready func() error) error {
	if pid <= 1 || pid == os.Getpid() {
		return errors.New("invalid update parent")
	}
	if e := syscall.Kill(pid, 0); e != nil {
		return e
	}
	if e := ready(); e != nil {
		return e
	}
	until := time.Now().Add(45 * time.Second)
	for time.Now().Before(until) {
		e := syscall.Kill(pid, 0)
		if errors.Is(e, syscall.ESRCH) {
			return nil
		}
		if e != nil {
			return e
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("old Desktop did not exit")
}

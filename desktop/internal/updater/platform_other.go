//go:build !darwin && !windows

package updater

import (
	"errors"
	"os"
)

func replaceFile(from, to string) error { return os.Rename(from, to) }
func lockFile(f *os.File) error         { return errors.New("Desktop update platform unsupported") }
func unlockFile(f *os.File)             {}
func waitParent(pid int, ready func() error) error {
	return errors.New("Desktop update platform unsupported")
}

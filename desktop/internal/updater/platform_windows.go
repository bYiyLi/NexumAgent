//go:build windows

package updater

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

func replaceFile(from, to string) error {
	a, e := windows.UTF16PtrFromString(from)
	if e != nil {
		return e
	}
	b, e := windows.UTF16PtrFromString(to)
	if e != nil {
		return e
	}
	return windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func lockFile(f *os.File) error {
	var o windows.Overlapped
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_FAIL_IMMEDIATELY|windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &o)
}
func unlockFile(f *os.File) {
	var o windows.Overlapped
	_ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &o)
}
func waitParent(pid int, ready func() error) error {
	if pid <= 1 || pid == os.Getpid() {
		return fmt.Errorf("invalid update parent")
	}
	h, e := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if e != nil {
		return e
	}
	defer windows.CloseHandle(h)
	if e = ready(); e != nil {
		return e
	}
	result, e := windows.WaitForSingleObject(h, 45000)
	if e != nil {
		return e
	}
	if result != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("old Desktop did not exit")
	}
	return nil
}

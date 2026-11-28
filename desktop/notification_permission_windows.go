//go:build windows

package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"

	ole "github.com/go-ole/go-ole"
)

type toastManagerStatics struct {
	ole.IInspectableVtbl
	CreateToastNotifier       uintptr
	CreateToastNotifierWithID uintptr
}
type toastNotifierMethods struct {
	ole.IInspectableVtbl
	Show       uintptr
	Hide       uintptr
	GetSetting uintptr
}

// IToastNotificationManagerStatics and IToastNotifier are Windows SDK WinRT
// interfaces. Query the same AppUserModelID used by Wails for sending.
func systemNotificationPermission(_ nativeNotifier) (state string, err error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err = ole.RoInitialize(1); err != nil {
		// S_FALSE means initialized already, but still requires a balancing uninitialize.
		if e, ok := err.(*ole.OleError); !ok || e.Code() != 1 {
			return "unknown", err
		}
	}
	defer windows.NewLazySystemDLL("combase.dll").NewProc("RoUninitialize").Call()
	factory, err := ole.RoGetActivationFactory("Windows.UI.Notifications.ToastNotificationManager", ole.NewGUID("50ac103f-d235-4598-bbef-98fe4d1a3ad4"))
	if err != nil {
		return "unknown", err
	}
	if factory == nil {
		return "unknown", fmt.Errorf("notification manager unavailable")
	}
	defer factory.Release()
	id, err := ole.NewHString(currentProfile.Name())
	if err != nil {
		return "unknown", err
	}
	defer ole.DeleteHString(id)
	methods := (*toastManagerStatics)(unsafe.Pointer(factory.RawVTable))
	var notifier *ole.IUnknown
	hr, _, _ := syscall.SyscallN(methods.CreateToastNotifierWithID, uintptr(unsafe.Pointer(factory)), uintptr(id), uintptr(unsafe.Pointer(&notifier)))
	if int32(hr) < 0 {
		return "unknown", ole.NewError(hr)
	}
	if notifier == nil {
		return "unknown", fmt.Errorf("notification notifier unavailable")
	}
	defer notifier.Release()
	inspectable, err := notifier.QueryInterface(ole.NewGUID("75927b93-03f3-41ec-91d3-6e5bac1b38e7"))
	if err != nil {
		return "unknown", err
	}
	defer inspectable.Release()
	var setting int32
	vt := (*toastNotifierMethods)(unsafe.Pointer(inspectable.RawVTable))
	hr, _, _ = syscall.SyscallN(vt.GetSetting, uintptr(unsafe.Pointer(inspectable)), uintptr(unsafe.Pointer(&setting)))
	if int32(hr) < 0 {
		return "unknown", ole.NewError(hr)
	}
	if setting == 0 {
		return "granted", nil
	}
	if setting >= 1 && setting <= 4 {
		return "notGranted", nil
	}
	return "unknown", fmt.Errorf("unexpected notification setting %d", setting)
}

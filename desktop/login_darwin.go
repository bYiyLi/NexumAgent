//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -Wno-unguarded-availability-new
#cgo LDFLAGS: -framework Foundation -framework ServiceManagement
#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <stdlib.h>
#include <string.h>

static int desktopLoginState(const char *expected) {
	@autoreleasepool {
		NSString *actual = [[NSBundle mainBundle] bundleIdentifier];
		if (!actual || ![actual isEqualToString:[NSString stringWithUTF8String:expected]]) return -2;
		if (@available(macOS 13.0, *)) {
			switch ([SMAppService mainAppService].status) {
				case SMAppServiceStatusEnabled: return 2;
				case SMAppServiceStatusRequiresApproval: return 3;
				case SMAppServiceStatusNotRegistered: return 1;
				case SMAppServiceStatusNotFound: return 1;
				default: return -2;
			}
		}
		return 0;
	}
}
static int desktopLoginSet(const char *expected, int enabled, char **message) {
	@autoreleasepool {
		if (desktopLoginState(expected) < 1) return 0;
		if (@available(macOS 13.0, *)) {
			SMAppService *svc = [SMAppService mainAppService];
			NSError *err = nil;
			BOOL ok = enabled ? [svc registerAndReturnError:&err] : [svc unregisterAndReturnError:&err];
			if (!ok && err) *message = strdup([[err localizedDescription] UTF8String]);
			return ok ? 1 : 0;
		}
		return 0;
	}
}
*/
import "C"

import (
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

type nativeLogin struct{ id string }

func newLoginRegistration(id string) loginRegistration { return nativeLogin{id: id} }

// macOS 12 uses an owned exact-label LaunchAgent, without loading the job in
// the current session or booting out an already-running Desktop process.
func (n nativeLogin) legacyPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", n.id+".plist"), nil
}
func (n nativeLogin) legacyBody() ([]byte, error) {
	exe, err := currentExecutable()
	if err != nil {
		return nil, err
	}
	var label, program strings.Builder
	if err := xml.EscapeText(&label, []byte(n.id)); err != nil {
		return nil, err
	}
	if err := xml.EscapeText(&program, []byte(exe)); err != nil {
		return nil, err
	}
	return []byte("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>" + label.String() + "</string><key>ProgramArguments</key><array><string>" + program.String() + "</string></array><key>RunAtLoad</key><true/></dict></plist>\n"), nil
}
func (n nativeLogin) legacyStatus() (LoginStatus, error) {
	path, err := n.legacyPath()
	if err != nil {
		return LoginStatus{}, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return LoginStatus{State: "disabled"}, nil
	}
	if err != nil {
		return LoginStatus{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > 65536 {
		return LoginStatus{}, errors.New("unexpected Desktop login item")
	}
	actual, err := os.ReadFile(path)
	if err != nil {
		return LoginStatus{}, err
	}
	want, err := n.legacyBody()
	if err != nil {
		return LoginStatus{}, err
	}
	if string(actual) != string(want) {
		return LoginStatus{}, errors.New("existing login item differs from Desktop registration; inspect system settings")
	}
	return LoginStatus{Registered: true, State: "enabled"}, nil
}
func (n nativeLogin) Status() (LoginStatus, error) {
	id := C.CString(n.id)
	defer C.free(unsafe.Pointer(id))
	switch C.desktopLoginState(id) {
	case 2:
		return LoginStatus{Registered: true, State: "enabled"}, nil
	case 3:
		return LoginStatus{Registered: true, State: "blocked"}, nil
	case 1:
		return LoginStatus{State: "disabled"}, nil
	case 0:
		return n.legacyStatus()
	default:
		return LoginStatus{}, errors.New("Desktop login item requires its own application bundle")
	}
}
func (n nativeLogin) Set(enabled bool) error {
	id := C.CString(n.id)
	defer C.free(unsafe.Pointer(id))
	state := C.desktopLoginState(id)
	if state < 0 {
		return errors.New("Desktop login item requires its own application bundle")
	}
	if state > 0 {
		if enabled && state == 2 || !enabled && state == 1 {
			return nil
		}
		if enabled && state == 3 {
			return errors.New("enable Desktop login item in System Settings")
		}
		var message *C.char
		flag := C.int(0)
		if enabled {
			flag = 1
		}
		ok := C.desktopLoginSet(id, flag, &message)
		if message != nil {
			defer C.free(unsafe.Pointer(message))
		}
		if ok != 1 {
			if message != nil {
				return fmt.Errorf("login item: %s", C.GoString(message))
			}
			return errors.New("login item operation failed")
		}
		return nil
	}
	status, err := n.legacyStatus()
	if err != nil {
		return err
	}
	path, err := n.legacyPath()
	if err != nil {
		return err
	}
	if !enabled {
		if !status.Registered {
			return nil
		}
		return os.Remove(path)
	}
	if status.Registered {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	body, err := n.legacyBody()
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".nexum-login-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(body); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	// Link is atomic and refuses an unexpected preexisting target.
	return os.Link(f.Name(), path)
}

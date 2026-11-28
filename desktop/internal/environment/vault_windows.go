//go:build windows

package environment

import (
	"errors"
	"golang.org/x/sys/windows"
	"runtime"
	"unsafe"
)

const credentialGeneric = 1
const credentialPersistLocalMachine = 2

type winCredential struct {
	Flags, Type             uint32
	TargetName, Comment     *uint16
	LastWritten             windows.Filetime
	BlobSize                uint32
	Blob                    *byte
	Persist, AttributeCount uint32
	Attributes              uintptr
	TargetAlias, UserName   *uint16
}

var advapi = windows.NewLazySystemDLL("advapi32.dll")
var credWrite = advapi.NewProc("CredWriteW")
var credRead = advapi.NewProc("CredReadW")
var credDelete = advapi.NewProc("CredDeleteW")
var credFree = advapi.NewProc("CredFree")

func target(namespace, ref string) (*uint16, error) {
	return windows.UTF16PtrFromString(namespace + "/ssh/" + ref)
}
func nativePut(namespace, ref string, data []byte) error {
	if len(data) == 0 || len(data) > 2560 {
		return errors.New("credential exceeds Windows Credential Manager capacity")
	}
	name, e := target(namespace, ref)
	if e != nil {
		return e
	}
	c := winCredential{Type: credentialGeneric, TargetName: name, BlobSize: uint32(len(data)), Blob: &data[0], Persist: credentialPersistLocalMachine}
	ok, _, _ := credWrite.Call(uintptr(unsafe.Pointer(&c)), 0)
	runtime.KeepAlive(name)
	runtime.KeepAlive(data)
	runtime.KeepAlive(&c)
	if ok == 0 {
		return errors.New("Credential Manager write failed")
	}
	return nil
}
func nativeGet(namespace, ref string) ([]byte, error) {
	name, e := target(namespace, ref)
	if e != nil {
		return nil, e
	}
	var c *winCredential
	ok, _, _ := credRead.Call(uintptr(unsafe.Pointer(name)), credentialGeneric, 0, uintptr(unsafe.Pointer(&c)))
	runtime.KeepAlive(name)
	if ok == 0 || c == nil {
		return nil, ErrCredentialMissing
	}
	defer credFree.Call(uintptr(unsafe.Pointer(c)))
	if c.Blob == nil || c.BlobSize == 0 || c.BlobSize > 2560 {
		return nil, ErrCredentialMissing
	}
	data := unsafe.Slice(c.Blob, int(c.BlobSize))
	result := append([]byte(nil), data...)
	clear(data)
	return result, nil
}
func nativeDelete(namespace, ref string) error {
	name, e := target(namespace, ref)
	if e != nil {
		return e
	}
	ok, _, err := credDelete.Call(uintptr(unsafe.Pointer(name)), credentialGeneric, 0)
	runtime.KeepAlive(name)
	if ok == 0 && !errors.Is(err, windows.ERROR_NOT_FOUND) {
		return errors.New("Credential Manager removal failed")
	}
	return nil
}

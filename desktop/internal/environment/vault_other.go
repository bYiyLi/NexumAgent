//go:build !windows && (!darwin || !cgo)

package environment

import "errors"

func nativePut(string, string, []byte) error {
	return errors.New("native credential store unavailable")
}
func nativeGet(string, string) ([]byte, error) { return nil, ErrCredentialMissing }
func nativeDelete(string, string) error        { return errors.New("native credential store unavailable") }

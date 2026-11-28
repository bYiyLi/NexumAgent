package environment

import (
	"encoding/json"
	"errors"
)

var ErrCredentialMissing = errors.New("saved SSH credential is unavailable")

// Vault stores only explicitly remembered secrets under the Desktop profile.
// Neither the renderer nor SQLite receives the credential payload.
type Vault interface {
	Put(ref string, secret Secret) error
	Get(ref string) (Secret, error)
	Delete(ref string) error
}
type nativeVault struct{ namespace string }

func NewNativeVault(namespace string) Vault { return nativeVault{namespace} }
func (v nativeVault) Put(ref string, s Secret) error {
	data, e := json.Marshal(s)
	if e != nil {
		return e
	}
	defer clear(data)
	return nativePut(v.namespace, ref, data)
}
func (v nativeVault) Get(ref string) (Secret, error) {
	var s Secret
	data, e := nativeGet(v.namespace, ref)
	if e != nil {
		return s, e
	}
	defer clear(data)
	if len(data) > 16*1024 {
		return s, ErrCredentialMissing
	}
	if e = json.Unmarshal(data, &s); e != nil {
		return Secret{}, ErrCredentialMissing
	}
	return s, nil
}
func (v nativeVault) Delete(ref string) error { return nativeDelete(v.namespace, ref) }

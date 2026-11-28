//go:build windows || (darwin && cgo)

package environment

import (
	"crypto/rand"
	"errors"
	"os"
	"testing"
)

// Explicit opt-in only. Use a fresh, test-only namespace and generated data;
// never read or alter an existing Desktop or OS login credential.
func TestNativeVaultRoundTrip(t *testing.T) {
	if os.Getenv("NEXUM_DESKTOP_NATIVE_VAULT_TEST") != "1" {
		t.Skip("native credential-store acceptance is opt-in")
	}
	namespace := "com.nexum.desktop.acceptance." + rand.Text()
	first := NewNativeVault(namespace + ".development")
	other := NewNativeVault(namespace + ".production")
	ref := rand.Text()
	defer func() {
		if err := first.Delete(ref); err != nil {
			t.Error("fixture cleanup failed", err)
		}
	}()
	value := Secret{Password: rand.Text()}
	if err := first.Put(ref, value); err != nil {
		t.Fatal(err)
	}
	actual, err := first.Get(ref)
	if err != nil || actual != value {
		t.Fatal("native credential round trip failed", err)
	}
	if _, err = other.Get(ref); !errors.Is(err, ErrCredentialMissing) {
		t.Fatal("credential namespace isolation failed", err)
	}
	if err = first.Delete(ref); err != nil {
		t.Fatal(err)
	}
	if _, err = first.Get(ref); !errors.Is(err, ErrCredentialMissing) {
		t.Fatal("deleted fixture still exists", err)
	}
}

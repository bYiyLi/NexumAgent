//go:build !darwin && !windows

package updater

import (
	"fmt"
	"os/exec"
)

func validateInstallTarget(c Config, binary string) error {
	return fmt.Errorf("%w: unsupported platform", ErrPermission)
}
func verifyPackage(c Config, source, path string, a Artifact) error {
	return validateInstallTarget(c, source)
}
func installPackage(c Config, s State, a Artifact, path string) error {
	return validateInstallTarget(c, s.SourceBinary)
}
func detach(cmd *exec.Cmd)                          {}
func launchInstalled(c Config, binary string) error { return validateInstallTarget(c, binary) }
func revealPackage(path string) error               { return fmt.Errorf("unsupported platform") }

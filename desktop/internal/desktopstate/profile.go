package desktopstate

import (
	"fmt"
	"os"
	"path/filepath"
)

// Profile defines the desktop's identity, not an Agent's profile or identity.
type Profile string

const (
	Production  Profile = "production"
	Development Profile = "development"
)

func (p Profile) Name() string {
	if p == Development {
		return "Nexum Desktop Dev"
	}
	return "Nexum Desktop"
}

func (p Profile) AppID() string {
	if p == Development {
		return "com.nexum.desktop.dev"
	}
	return "com.nexum.desktop"
}

func (p Profile) applicationID() int {
	if p == Development {
		return 0x4e584444
	}
	return 0x4e584450
}

func (p Profile) directory() (string, error) {
	switch p {
	case Production:
		return "NexumDesktop", nil
	case Development:
		return "NexumDesktopDev", nil
	default:
		return "", fmt.Errorf("invalid desktop profile %q", p)
	}
}

type Paths struct {
	Root     string
	Database string
	Logs     string
	WebView  string
}

func Resolve(p Profile) (Paths, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return Paths{}, err
	}
	return ResolveAt(base, p)
}

// ResolveAt is used for hermetic tests; application builds always use UserConfigDir.
func ResolveAt(base string, p Profile) (Paths, error) {
	name, err := p.directory()
	if err != nil {
		return Paths{}, err
	}
	if !filepath.IsAbs(base) {
		return Paths{}, fmt.Errorf("desktop config base must be absolute")
	}
	root := filepath.Join(base, name)
	return Paths{
		Root:     root,
		Database: filepath.Join(root, "desktop.sqlite"),
		Logs:     filepath.Join(root, "logs"),
		WebView:  filepath.Join(root, "webview"),
	}, nil
}

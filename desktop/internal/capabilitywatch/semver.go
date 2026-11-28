package capabilitywatch

import (
	"regexp"
	"strings"
)

// Compare arbitrarily large numeric identifiers as strings so registry data
// cannot overflow and prerelease precedence follows SemVer 2.0.0.
type version struct {
	core [3]string
	pre  []string
}

var semverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

func parseVersion(raw string) (version, bool) {
	if len(raw) > 256 {
		return version{}, false
	}
	match := semverPattern.FindStringSubmatch(raw)
	if match == nil {
		return version{}, false
	}
	v := version{core: [3]string{match[1], match[2], match[3]}}
	if match[4] != "" {
		v.pre = strings.Split(match[4], ".")
		for _, part := range v.pre {
			if numeric(part) && len(part) > 1 && part[0] == '0' {
				return version{}, false
			}
		}
	}
	return v, true
}

func numeric(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return s != ""
}

func compareNumber(a, b string) int {
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return strings.Compare(a, b)
}

func compareVersion(a, b version) int {
	for i := range a.core {
		if n := compareNumber(a.core[i], b.core[i]); n != 0 {
			return n
		}
	}
	if len(a.pre) == 0 && len(b.pre) == 0 {
		return 0
	}
	if len(a.pre) == 0 {
		return 1
	}
	if len(b.pre) == 0 {
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		x, y := a.pre[i], b.pre[i]
		xnum, ynum := numeric(x), numeric(y)
		if xnum && ynum {
			if n := compareNumber(x, y); n != 0 {
				return n
			}
			continue
		}
		if xnum != ynum {
			if xnum {
				return -1
			}
			return 1
		}
		if n := strings.Compare(x, y); n != 0 {
			return n
		}
	}
	if len(a.pre) < len(b.pre) {
		return -1
	}
	if len(a.pre) > len(b.pre) {
		return 1
	}
	return 0
}

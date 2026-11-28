package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

type materialTransport func(*http.Request) (*http.Response, error)

func (fn materialTransport) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func TestSkillUpdatesUseDirectoryRevisionAndShareRepositoryReads(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: materialTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		var body string
		switch req.URL.Path {
		case "/repos/example/skills":
			body = `{"archived":false,"default_branch":"main"}`
		case "/repos/example/skills/git/trees/main":
			body = `{"truncated":false,"tree":[{"path":"skills/first","type":"tree","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},{"path":"skills/second","type":"tree","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}`
		default:
			t.Fatalf("unexpected URL %s", req.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	evidence := []lifecycle.SkillEvidence{
		{ID: "first", Repo: "example/skills", Path: "skills/first", Installed: strings.Repeat("a", 40)},
		{ID: "second", Repo: "example/skills", Path: "skills/second", Installed: strings.Repeat("a", 40)},
	}
	results := checkSkillUpdatesWithClient(context.Background(), client, evidence)
	if requests != 2 || results["first"].notice != "update" || !results["first"].checked ||
		results["second"].notice != "" || !results["second"].checked {
		t.Fatalf("unexpected update results: %+v requests=%d", results, requests)
	}
}

func TestSkillUpdatesKeepTruncatedTreeUnknown(t *testing.T) {
	client := &http.Client{Transport: materialTransport(func(req *http.Request) (*http.Response, error) {
		body := `{"archived":true,"default_branch":"main"}`
		if strings.Contains(req.URL.Path, "/git/trees/") {
			body = `{"truncated":true,"tree":[]}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	evidence := []lifecycle.SkillEvidence{{ID: "skill", Repo: "example/skills", Path: "skills/fixture", Installed: strings.Repeat("a", 40)}}
	results := checkSkillUpdatesWithClient(context.Background(), client, evidence)
	if results["skill"].notice != "advice" || results["skill"].checked || results["skill"].available != "" {
		t.Fatalf("unexpected result for truncated tree: %+v", results["skill"])
	}
}

func TestSkillUpdatesCompareRootTreeAndRejectChangedRef(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "matching ref", true: "ref changed during check"}[changed], func(t *testing.T) {
			client := &http.Client{Transport: materialTransport(func(req *http.Request) (*http.Response, error) {
				var body string
				switch req.URL.Path {
				case "/repos/example/skills":
					body = `{"default_branch":"main"}`
				case "/repos/example/skills/git/trees/main":
					body = `{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tree":[{"path":"SKILL.md","type":"blob"}]}`
				case "/repos/example/skills/commits/main":
					commit := strings.Repeat("a", 40)
					if changed {
						commit = strings.Repeat("c", 40)
					}
					body = `{"sha":"` + commit + `","commit":{"tree":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}}`
				default:
					t.Fatalf("unexpected URL %s", req.URL)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
			})}
			results := checkSkillUpdatesWithClient(context.Background(), client, []lifecycle.SkillEvidence{{
				ID: "root", Repo: "example/skills", Path: "SKILL.md", Installed: strings.Repeat("a", 40),
			}})
			result := results["root"]
			if changed && (result.checked || result.notice != "" || result.available != "") {
				t.Fatalf("changed ref must remain unknown: %+v", result)
			}
			if !changed && (!result.checked || result.notice != "update" || result.available != strings.Repeat("b", 40)) {
				t.Fatalf("root tree was not compared: %+v", result)
			}
		})
	}
}

func TestSkillUpdatesAcceptCaseVariantEntryPath(t *testing.T) {
	client := &http.Client{Transport: materialTransport(func(req *http.Request) (*http.Response, error) {
		body := `{"default_branch":"main"}`
		if strings.Contains(req.URL.Path, "/git/trees/") {
			body = `{"tree":[{"path":"skills/fixture","type":"tree","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	result := checkSkillUpdatesWithClient(context.Background(), client, []lifecycle.SkillEvidence{{
		ID: "skill", Repo: "example/skills", Path: "skills/fixture/skill.md", Installed: strings.Repeat("a", 40),
	}})["skill"]
	if !result.checked || result.notice != "update" {
		t.Fatalf("case variant was not compared: %+v", result)
	}
}

func TestSkillUpdatesPublicGitHubAcceptance(t *testing.T) {
	if os.Getenv("NEXUM_TEST_GITHUB_MATERIALS") != "1" {
		t.Skip("set NEXUM_TEST_GITHUB_MATERIALS=1 for the public GitHub API check")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	results := checkSkillUpdates(ctx, []lifecycle.SkillEvidence{{ID: "fixture", Repo: "vercel-labs/agent-skills",
		Path: "skills/react-best-practices", Installed: strings.Repeat("0", 40)}})
	result := results["fixture"]
	if !result.checked || result.notice != "update" || !githubTreeSHA.MatchString(result.available) {
		t.Fatalf("public GitHub tree comparison did not complete: %+v", result)
	}
}

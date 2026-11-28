package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/lifecycle"
)

type skillUpdate struct {
	notice, installed, available string
	checked                      bool
}

type githubRepository struct {
	Archived      bool   `json:"archived"`
	DefaultBranch string `json:"default_branch"`
}

type githubTree struct {
	SHA       string `json:"sha"`
	Truncated bool   `json:"truncated"`
	Tree      []struct {
		Path string `json:"path"`
		Type string `json:"type"`
		SHA  string `json:"sha"`
	} `json:"tree"`
}

type githubCommit struct {
	SHA    string `json:"sha"`
	Commit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	} `json:"commit"`
}

var githubTreeSHA = regexp.MustCompile(`^[a-f0-9]{40}$`)

// GitHub is a fixed public endpoint. No local installation path or credential
// is sent to it.
func githubRead(ctx context.Context, client *http.Client, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com"+endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Nexum-Desktop")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("github_unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024+1))
	if err != nil || len(body) > 8*1024*1024 {
		return errors.New("github_unavailable")
	}
	return json.Unmarshal(body, out)
}

func checkSkillUpdates(ctx context.Context, evidence []lifecycle.SkillEvidence) map[string]skillUpdate {
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" || req.URL.Host != "api.github.com" || len(via) > 2 {
			return errors.New("github_redirect_rejected")
		}
		return nil
	}}
	return checkSkillUpdatesWithClient(ctx, client, evidence)
}

func checkSkillUpdatesWithClient(ctx context.Context, client *http.Client, evidence []lifecycle.SkillEvidence) map[string]skillUpdate {
	type repositoryResult struct {
		data githubRepository
		err  error
	}
	type treeResult struct {
		data githubTree
		err  error
	}
	type commitResult struct {
		data githubCommit
		err  error
	}
	repositories := map[string]repositoryResult{}
	trees := map[string]treeResult{}
	commits := map[string]commitResult{}
	updates := map[string]skillUpdate{}
	for _, item := range evidence {
		if ctx.Err() != nil {
			break
		}
		if item.Problem != "" {
			continue
		}
		repo, ok := repositories[item.Repo]
		if !ok {
			repo.err = githubRead(ctx, client, "/repos/"+item.Repo, &repo.data)
			repositories[item.Repo] = repo
		}
		if repo.err != nil {
			continue
		}
		update := skillUpdate{installed: item.Installed}
		if repo.data.Archived {
			update.notice = "advice"
		}
		ref := item.Ref
		if ref == "" {
			ref = repo.data.DefaultBranch
		}
		if ref == "" {
			updates[item.ID] = update
			continue
		}
		key := item.Repo + "\x00" + ref
		tree, ok := trees[key]
		if !ok {
			tree.err = githubRead(ctx, client, "/repos/"+item.Repo+"/git/trees/"+url.PathEscape(ref)+"?recursive=1", &tree.data)
			trees[key] = tree
		}
		if tree.err != nil || tree.data.Truncated {
			updates[item.ID] = update
			continue
		}
		folder := strings.TrimSuffix(item.Path, "/")
		if strings.EqualFold(folder, "SKILL.md") {
			// GitHub's Trees endpoint can return the commit SHA when addressed by
			// a ref; use the corresponding commit's root tree, and reject races.
			hasEntry := false
			for _, node := range tree.data.Tree {
				hasEntry = hasEntry || node.Type == "blob" && strings.EqualFold(node.Path, "SKILL.md")
			}
			if hasEntry {
				commit, ok := commits[key]
				if !ok {
					commit.err = githubRead(ctx, client, "/repos/"+item.Repo+"/commits/"+url.PathEscape(ref), &commit.data)
					commits[key] = commit
				}
				if commit.err == nil && githubTreeSHA.MatchString(tree.data.SHA) && commit.data.SHA == tree.data.SHA && githubTreeSHA.MatchString(commit.data.Commit.Tree.SHA) {
					update.available = commit.data.Commit.Tree.SHA
				}
			}
		} else {
			if strings.HasSuffix(strings.ToLower(folder), "/skill.md") {
				folder = folder[:len(folder)-len("/skill.md")]
			}
			for _, node := range tree.data.Tree {
				if node.Type == "tree" && node.Path == folder && githubTreeSHA.MatchString(node.SHA) {
					update.available = node.SHA
					break
				}
			}
		}
		if update.available != "" {
			update.checked = true
			if update.available != item.Installed && update.notice == "" {
				update.notice = "update"
			}
		}
		updates[item.ID] = update
	}
	return updates
}

package environment

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalCommandHelper(t *testing.T) {
	if os.Getenv("NEXUM_ENVIRONMENT_TEST_HELPER") != "1" {
		return
	}
	cwd, _ := os.Getwd()
	fmt.Printf("%s\n%s", cwd, os.Getenv("NEXUM_ENVIRONMENT_TEST_VALUE"))
	fmt.Fprint(os.Stderr, "fixture stderr")
	os.Exit(7)
}
func TestLocalRuntime(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	r := NewLocal()
	if !r.Alive() || r.Identity().Platform == "" || r.Identity().Home == "" {
		t.Fatal("local identity unavailable")
	}
	dir := t.TempDir()
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	result, e := r.Run(ctx, Command{Program: exe, Args: []string{"-test.run=^TestLocalCommandHelper$"}, Dir: dir, Env: map[string]string{"NEXUM_ENVIRONMENT_TEST_HELPER": "1", "NEXUM_ENVIRONMENT_TEST_VALUE": "spaces and ' quotes"}})
	if e != nil || !result.Started || !result.OutcomeKnown || result.ExitCode != 7 || !strings.Contains(result.Stdout, "spaces and ' quotes") || result.Stderr != "fixture stderr" {
		t.Fatalf("unexpected local result: %+v, %v", result, e)
	}
	child, e := r.Join(dir, "nested", "dir")
	if e != nil {
		t.Fatal(e)
	}
	if e = r.MkdirAll(ctx, child, 0700); e != nil {
		t.Fatal(e)
	}
	file, e := r.Join(child, "hello.txt")
	if e != nil {
		t.Fatal(e)
	}
	if e = r.WriteFile(ctx, file, []byte("first"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = r.WriteFile(ctx, file, []byte("changed"), 0600); e != nil {
		t.Fatal(e)
	}
	if b, e := r.ReadFile(ctx, file, 10); e != nil || string(b) != "changed" {
		t.Fatalf("read: %q %v", b, e)
	}
	if _, e := r.ReadFile(ctx, file, 2); e == nil {
		t.Fatal("read limit not enforced")
	}
	if i, e := r.Stat(ctx, file); e != nil || i.Size() != 7 {
		t.Fatal("stat", i, e)
	}
	if entries, e := r.ReadDir(ctx, child); e != nil || len(entries) != 1 {
		t.Fatal("list", entries, e)
	}
	src := filepath.Join(dir, "upload.txt")
	if e = os.WriteFile(src, []byte("upload"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = r.Upload(ctx, src, file, 0600); e != nil {
		t.Fatal(e)
	}
	dst := filepath.Join(dir, "download.txt")
	if e = r.Download(ctx, file, dst, 0600); e != nil {
		t.Fatal(e)
	}
	if b, e := os.ReadFile(dst); e != nil || string(b) != "upload" {
		t.Fatal("transfer", string(b), e)
	}
	stopped, stop := context.WithCancel(ctx)
	stop()
	if _, e := r.ReadFile(stopped, file, 10); !errors.Is(e, context.Canceled) {
		t.Fatal("cancelled read", e)
	}
	if _, e := r.Run(stopped, Command{Program: exe}); !errors.Is(e, context.Canceled) {
		t.Fatal("cancelled process", e)
	}
}
func TestTargetPathsAndConfig(t *testing.T) {
	p, e := joinTarget("windows", `c:\Users\Some User`, "data", "x")
	if e != nil || p != "C:/Users/Some User/data/x" {
		t.Fatal(p, e)
	}
	if _, e := targetPath("windows", "relative"); e == nil {
		t.Fatal("relative Windows path accepted")
	}
	if _, e := targetPath("linux", "C:/local"); e == nil {
		t.Fatal("host path accepted as POSIX")
	}
	p, e = joinTarget("linux", "/home/u", "a", "b")
	if e != nil || p != "/home/u/a/b" {
		t.Fatal(p, e)
	}
	c, e := NormalizeConfig(SSHConfig{Host: "[::1]", Port: 22, Username: "fixture", AuthType: "agent"})
	if e != nil || c.Host != "::1" {
		t.Fatal(c, e)
	}
	for _, host := range []string{"ssh://example.com", "user@host", "host/path", "bad name", "-host"} {
		if _, e = NormalizeConfig(SSHConfig{Host: host, Port: 22, Username: "fixture", AuthType: "agent"}); e == nil {
			t.Fatalf("invalid host accepted: %s", host)
		}
	}
	for _, p := range []int{0, 65536} {
		if _, e = NormalizeConfig(SSHConfig{Host: "localhost", Port: p, Username: "fixture", AuthType: "password"}); e == nil {
			t.Fatal("invalid port accepted")
		}
	}
	if got := windowsArg(""); got != `""` {
		t.Fatal(got)
	}
	if got := windowsArg("a b"); got != `"a b"` {
		t.Fatal(got)
	}
	if got := windowsArg(`a"b`); got != `"a\"b"` {
		t.Fatal(got)
	}
}

func TestDesktopTransferAndRuntimeMarkers(t *testing.T) {
	for _, s := range []string{"install_download:0:100", "install_download:100:100", "repair_download:42:100", "runtime:node_download:20:100", "runtime:host_start:0:0", "runtime:ready:0:0"} {
		if !validDesktopProgress(s) {
			t.Errorf("valid progress rejected: %s", s)
		}
	}
	for _, s := range []string{"install_download:101:100", "install_download:0:0", "repair_download:-1:100", "install_download:0:1073741825", "runtime:host_start:2:10", "runtime:unknown_stage:0:0", "runtime:node_download:5:4", "runtime:node_download:1:2:3"} {
		if validDesktopProgress(s) {
			t.Errorf("invalid progress accepted: %s", s)
		}
	}
}
func TestBoundedOutputProgressMarkers(t *testing.T) {
	var stages []string
	b := boundedOutput{progress: func(stage string) { stages = append(stages, stage) }}
	chunks := []string{"ordinary output\nNEXUM_DESKTOP_PROG", "RESS:install_down", "load\nNEXUM_DESKTOP_PROGRESS:unknown\n", "NEXUM_DESKTOP_PROGRESS:repair_verify\r\n"}
	for _, chunk := range chunks {
		if _, err := b.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if strings.Join(stages, ",") != "install_download,repair_verify" {
		t.Fatalf("unexpected progress: %v", stages)
	}
	if !strings.Contains(string(b.data), "NEXUM_DESKTOP_PROGRESS:unknown") {
		t.Fatal("progress filtering must not alter captured output")
	}
}

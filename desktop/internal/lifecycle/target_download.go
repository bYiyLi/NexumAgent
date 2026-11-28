package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
	"time"

	"github.com/bYiyLi/NexumAgent/desktop/internal/environment"
)

// stageTargetDownload creates an isolated directory on the selected target.
// Only bounded metadata and scripts are read back; binaries stay on the target.
func stageTargetDownload(ctx context.Context, rt environment.Runtime, origin, profile, resource, name string, limit int64, progress ...func(int64, int64)) (string, func(), error) {
	if !safeOrigin(origin, profile) || name == "" || strings.ContainsAny(name, `/\`) || limit <= 0 {
		return "", nil, errors.New("target_download_failed")
	}
	id := rt.Identity()
	if id.Platform != "darwin" && id.Platform != "linux" && id.Platform != "windows" {
		return "", nil, errors.New("target_download_failed")
	}
	nonce, err := newOperation()
	if err != nil {
		return "", nil, errors.New("installer_staging_unavailable")
	}
	dir, err := rt.Join(id.Home, ".nexum-desktop-install-"+nonce)
	if err != nil {
		return "", nil, errors.New("installer_staging_unavailable")
	}
	if _, err = rt.Lstat(ctx, dir); !errors.Is(err, fs.ErrNotExist) {
		return "", nil, errors.New("installer_staging_unavailable")
	}
	if err = rt.MkdirAll(ctx, dir, 0700); err != nil {
		return "", nil, errors.New("installer_staging_unavailable")
	}
	path, err := rt.Join(dir, name)
	if err != nil {
		return "", nil, errors.New("installer_staging_unavailable")
	}
	cleanup := func() {
		if !rt.Alive() {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if id.Platform == "windows" {
			cmd := "Remove-Item -LiteralPath " + psLiteral(path) + " -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath " + psLiteral(dir) + " -ErrorAction SilentlyContinue"
			_, _ = rt.Run(cleanupCtx, environment.Command{Program: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", cmd}})
		} else {
			_, _ = rt.Run(cleanupCtx, environment.Command{Program: "/bin/rm", Args: []string{"-f", "--", path}})
			_, _ = rt.Run(cleanupCtx, environment.Command{Program: "/bin/rmdir", Args: []string{dir}})
		}
	}
	info, err := rt.Lstat(ctx, dir)
	if err != nil || !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 || id.Platform != "windows" && info.Mode().Perm()&0077 != 0 {
		cleanup()
		return "", nil, errors.New("installer_staging_unavailable")
	}
	var cmd environment.Command
	var report func(int64, int64)
	if len(progress) > 0 {
		report = progress[0]
	}
	if id.Platform == "windows" {
		// WebRequest streams to disk with an explicit byte cap and redirects disabled.
		script := fmt.Sprintf(`$ErrorActionPreference='Stop'
$request=[System.Net.HttpWebRequest]::Create(%s)
$request.AllowAutoRedirect=$false
$request.Timeout=60000
$request.ReadWriteTimeout=60000
$response=$request.GetResponse()
try {
  if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt %d) { throw 'download_failed' }
  $source=$response.GetResponseStream()
  try {
    $output=[System.IO.File]::Open(%s,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
    try {
      $buffer=New-Object byte[] 65536
      $total=0
      while (($count=$source.Read($buffer,0,$buffer.Length)) -gt 0) {
        $total += $count
        if ($total -gt %d) { throw 'download_too_large' }
        $output.Write($buffer,0,$count)
      }
    } finally { $output.Dispose() }
  } finally { $source.Dispose() }
} finally { $response.Dispose() }`, psLiteral(origin+resource), limit, psLiteral(path), limit)
		if report != nil {
			script = strings.Replace(script, "$total=0", "$total=0; $clock=[Diagnostics.Stopwatch]::StartNew(); $last=0", 1)
			script = strings.Replace(script, "$output.Write($buffer,0,$count)", "$output.Write($buffer,0,$count); if ($clock.ElapsedMilliseconds - $last -ge 250 -or $total -eq "+strconv.FormatInt(limit, 10)+") { [Console]::WriteLine(('NEXUM_DESKTOP_PROGRESS:install_download:{0}:"+strconv.FormatInt(limit, 10)+"' -f $total)); $last=$clock.ElapsedMilliseconds }", 1)
		}
		cmd = environment.Command{Program: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", script}}
	} else {
		cmd = environment.Command{Program: "curl", Args: []string{
			"--disable", "--fail", "--silent", "--show-error", "--no-buffer", "--proto", "=http,https",
			"--max-redirs", "0", "--connect-timeout", "10", "--max-time", "60",
			"--max-filesize", strconv.FormatInt(limit, 10), "--output", path,
			"--write-out", "%{http_code}", origin + resource,
		}}
	}
	// Keep curl as the directly managed process; a background shell child could
	// outlive cancellation of the Local/SSH command. Observe the private staged
	// file while it is written and join the observer before cleanup or verification.
	var stop, joined chan struct{}
	if report != nil {
		report(0, limit)
		if id.Platform == "windows" {
			var previous int64
			cmd.Progress = func(marker string) {
				stage, done, total, ok := environment.ParseDesktopProgress(marker)
				if ok && stage == "install_download" && total == limit && done >= previous && ctx.Err() == nil {
					previous = done
					report(done, total)
				}
			}
		} else {
			stop, joined = make(chan struct{}), make(chan struct{})
			go func() {
				defer close(joined)
				ticker := time.NewTicker(500 * time.Millisecond)
				defer ticker.Stop()
				var previous int64
				for {
					select {
					case <-stop:
						return
					case <-ctx.Done():
						return
					case <-ticker.C:
						info, err := rt.Lstat(ctx, path)
						if err == nil && info.Mode().IsRegular() && info.Size() > previous && info.Size() <= limit && ctx.Err() == nil {
							previous = info.Size()
							report(previous, limit)
						}
					}
				}
			}()
		}
	}
	result, err := rt.Run(ctx, cmd)
	if stop != nil {
		close(stop)
		<-joined
	}
	if err != nil || ctx.Err() != nil || !result.OutcomeKnown || result.Truncated {
		cleanup()
		return "", nil, errors.New("target_download_unconfirmed")
	}
	// Keep the response-code check; progress lines carry no success authority.
	var responseLines []string
	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		line = strings.TrimSpace(line)
		if report != nil && strings.HasPrefix(line, environment.DesktopProgressPrefix) {
			if _, _, _, ok := environment.ParseDesktopProgress(strings.TrimPrefix(line, environment.DesktopProgressPrefix)); ok {
				continue
			}
		}
		if line != "" {
			responseLines = append(responseLines, line)
		}
	}
	if result.ExitCode != 0 || id.Platform != "windows" && strings.Join(responseLines, "\n") != "200" {
		cleanup()
		return "", nil, errors.New("target_download_failed")
	}
	info, err = rt.Lstat(ctx, path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limit {
		cleanup()
		return "", nil, errors.New("target_download_failed")
	}
	if report != nil {
		report(info.Size(), limit)
	}
	return path, cleanup, nil
}

func psLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func verifyTargetArtifact(ctx context.Context, rt environment.Runtime, path string, expected artifact) error {
	info, err := rt.Lstat(ctx, path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != expected.Size {
		return errors.New("repair_artifact_unverified")
	}
	var command environment.Command
	switch rt.Identity().Platform {
	case "darwin":
		command = environment.Command{Program: "shasum", Args: []string{"-a", "256", "--", path}}
	case "linux":
		command = environment.Command{Program: "sha256sum", Args: []string{"--", path}}
	case "windows":
		command = environment.Command{Program: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", "(Get-FileHash -Algorithm SHA256 -LiteralPath " + psLiteral(path) + ").Hash"}}
	default:
		return errors.New("repair_artifact_unverified")
	}
	result, err := rt.Run(ctx, command)
	fields := strings.Fields(result.Stdout)
	if err != nil || !result.OutcomeKnown || result.Truncated || result.ExitCode != 0 || len(fields) == 0 || !strings.EqualFold(fields[0], expected.SHA256) {
		return errors.New("repair_artifact_unverified")
	}
	if rt.Identity().Platform != "windows" {
		result, err = rt.Run(ctx, environment.Command{Program: "chmod", Args: []string{"0700", path}})
		if err != nil || !result.OutcomeKnown || result.Truncated || result.ExitCode != 0 {
			return errors.New("repair_artifact_unverified")
		}
	}
	return nil
}

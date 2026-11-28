package main

import (
	"github.com/bYiyLi/NexumAgent/desktop/internal/desktopstate"
	"io"
	"log/slog"
	"os"
	"sync"
)

// Wails can report a native startup error before the private log directory
// exists. Route subsequent output to the profile log once it is opened.
type desktopLog struct {
	mu   sync.Mutex
	file *os.File
}

func (l *desktopLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out io.Writer = os.Stderr
	if l.file != nil {
		out = l.file
	}
	return out.Write(p)
}
func (l *desktopLog) open(paths desktopstate.Paths) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		return nil
	}
	f, e := desktopstate.OpenLog(paths, currentProfile)
	if e == nil {
		l.file = f
	}
	return e
}
func (l *desktopLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}
func (l *desktopLog) logger() *slog.Logger {
	// Wails debug messages may include serialized binding arguments. They
	// must never reach persistent logs (even if the log level changes).
	return slog.New(slog.NewJSONHandler(l, &slog.HandlerOptions{Level: slog.LevelInfo, ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
		if a.Key == "args" {
			return slog.Attr{}
		}
		return a
	}}))
}

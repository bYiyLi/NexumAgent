//go:build windows

package main

import (
	"golang.org/x/sys/windows"
)

func showStartupError() {
	title, _ := windows.UTF16PtrFromString("Nexum Desktop")
	message, _ := windows.UTF16PtrFromString("The client could not prepare its local environment. Check its installation and data directory.")
	_, _ = windows.MessageBox(0, message, title, 0x10)
}

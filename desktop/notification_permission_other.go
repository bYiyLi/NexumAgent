//go:build !darwin && !windows

package main

func systemNotificationPermission(n nativeNotifier) (string, error) { return "unknown", nil }

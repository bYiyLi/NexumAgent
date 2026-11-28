//go:build darwin

package main

func systemNotificationPermission(n nativeNotifier) (string, error) {
	ok, err := n.CheckNotificationAuthorization()
	if err != nil {
		return "unknown", err
	}
	if ok {
		return "granted", nil
	}
	return "notGranted", nil
}

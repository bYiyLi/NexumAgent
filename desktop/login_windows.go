//go:build windows

package main

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const loginRunKey = `Software\Microsoft\Windows\CurrentVersion\Run`

type nativeLogin struct{ id string }

func newLoginRegistration(id string) loginRegistration { return nativeLogin{id: id} }

func (n nativeLogin) command() (string, error) {
	exe, err := currentExecutable()
	if err != nil {
		return "", err
	}
	return windows.EscapeArg(exe), nil
}
func (n nativeLogin) Status() (LoginStatus, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, loginRunKey, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return LoginStatus{State: "disabled"}, nil
	}
	if err != nil {
		return LoginStatus{}, err
	}
	defer k.Close()
	value, _, err := k.GetStringValue(n.id)
	if errors.Is(err, registry.ErrNotExist) {
		return LoginStatus{State: "disabled"}, nil
	}
	if err != nil {
		return LoginStatus{}, err
	}
	want, err := n.command()
	if err != nil {
		return LoginStatus{}, err
	}
	if !strings.EqualFold(value, want) {
		return LoginStatus{Registered: true, State: "stale"}, nil
	}
	// Run registration is not proof that Windows Startup Apps policy permits it.
	return LoginStatus{Registered: true, State: "registered"}, nil
}
func (n nativeLogin) Set(enabled bool) error {
	if enabled {
		value, err := n.command()
		if err != nil {
			return err
		}
		k, _, err := registry.CreateKey(registry.CURRENT_USER, loginRunKey, registry.SET_VALUE)
		if err != nil {
			return err
		}
		defer k.Close()
		if err := k.SetStringValue(n.id, value); err != nil {
			return fmt.Errorf("register Desktop login item: %w", err)
		}
		return nil
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, loginRunKey, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer k.Close()
	if err = k.DeleteValue(n.id); errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	return err
}

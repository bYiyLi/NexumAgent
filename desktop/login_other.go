//go:build !darwin && !windows

package main

import "errors"

type unsupportedLogin struct{}

func newLoginRegistration(string) loginRegistration { return unsupportedLogin{} }
func (unsupportedLogin) Status() (LoginStatus, error) {
	return LoginStatus{}, errors.New("login item unsupported")
}
func (unsupportedLogin) Set(bool) error { return errors.New("login item unsupported") }

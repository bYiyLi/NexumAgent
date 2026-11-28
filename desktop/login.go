package main

import (
	"errors"
	"os"
	"path/filepath"
)

type LoginStatus struct {
	Registered bool   `json:"registered"`
	State      string `json:"state"`
}

type loginRegistration interface {
	Status() (LoginStatus, error)
	Set(bool) error
}

func currentExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(exe) {
		return "", errors.New("invalid Desktop executable path")
	}
	return exe, nil
}

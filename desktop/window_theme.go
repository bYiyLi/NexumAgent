package main

import (
	_ "embed"
	"encoding/json"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed frontend/src/theme-palette.json
var desktopPaletteJSON []byte

type canvasPalette struct {
	Light [3]uint8 `json:"light"`
	Dark  [3]uint8 `json:"dark"`
}

// Initial colour uses the same palette as React. Once the webview is ready,
// the frontend synchronizes the actual system/stored theme with the frame.
func initialWindowBackground(theme string, systemDark bool) (application.RGBA, error) {
	var palette canvasPalette
	if err := json.Unmarshal(desktopPaletteJSON, &palette); err != nil {
		return application.RGBA{}, err
	}
	rgb := palette.Light
	if theme == "dark" || (theme == "system" && systemDark) {
		rgb = palette.Dark
	}
	return application.NewRGB(rgb[0], rgb[1], rgb[2]), nil
}

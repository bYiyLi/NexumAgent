import palette from "./theme-palette.json";

export type Theme = "system" | "light" | "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

export function darkTheme(theme: Theme, systemDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && systemDark);
}

// The same palette is embedded by Go for the opaque native window.
export function desktopCanvas(dark: boolean): [number, number, number] {
  const rgb = dark ? palette.dark : palette.light;
  return [rgb[0], rgb[1], rgb[2]];
}

export function applyDesktopTheme(dark: boolean, root: HTMLElement = document.documentElement) {
  const rgb = desktopCanvas(dark);
  root.style.setProperty("--desktop-canvas", `rgb(${rgb.join(", ")})`);
  root.classList.toggle("dark", dark);
  return rgb;
}

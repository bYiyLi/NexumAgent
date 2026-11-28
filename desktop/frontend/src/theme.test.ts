import { describe, expect, it } from "vitest";
import { darkTheme, desktopCanvas, isTheme } from "./theme";

describe("desktop theme", () => {
  it("honors explicit and system appearance", () => {
    expect(darkTheme("system", true)).toBe(true);
    expect(darkTheme("system", false)).toBe(false);
    expect(darkTheme("light", true)).toBe(false);
    expect(darkTheme("dark", false)).toBe(true);
    expect(isTheme("unknown")).toBe(false);
  });
  it("shares the product canvas with the native window", () => {
    expect(desktopCanvas(false)).toEqual([248, 250, 252]);
    expect(desktopCanvas(true)).toEqual([20, 27, 45]);
  });
});

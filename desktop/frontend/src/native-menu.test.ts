import { describe, expect, it } from "vitest";
import { parseNativeMenuNavigation } from "./native-menu";

describe("native menu navigation", () => {
  it("accepts only positive safe revisions and known destinations", () => {
    expect(parseNativeMenuNavigation({revision: 1, destination: "settings"})).toEqual({revision: 1, destination: "settings"});
    expect(parseNativeMenuNavigation({revision: 2, destination: "about"})).toEqual({revision: 2, destination: "about"});
    for (const value of [undefined, null, {}, [], {revision:0,destination:""}, {revision:1,destination:"quit"}, {revision:-1,destination:"about"}, {revision:1.5,destination:"settings"}, {revision:Number.MAX_SAFE_INTEGER+1,destination:"about"}]) {
      expect(parseNativeMenuNavigation(value)).toBeNull();
    }
  });
});

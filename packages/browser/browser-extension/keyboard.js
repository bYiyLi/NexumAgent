import { BrowserActionError, requireValue, text } from "./errors.js";

const named = {
  Enter: ["Enter", 13],
  Tab: ["Tab", 9],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  Escape: ["Escape", 27],
  Esc: ["Escape", 27],
  Space: [" ", 32],
  Spacebar: [" ", 32],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowUp: ["ArrowUp", 38],
  ArrowRight: ["ArrowRight", 39],
  ArrowDown: ["ArrowDown", 40],
  Left: ["ArrowLeft", 37],
  Up: ["ArrowUp", 38],
  Right: ["ArrowRight", 39],
  Down: ["ArrowDown", 40],
  Home: ["Home", 36],
  End: ["End", 35],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
  Insert: ["Insert", 45],
  Control: ["Control", 17],
  Ctrl: ["Control", 17],
  Alt: ["Alt", 18],
  Shift: ["Shift", 16],
  Meta: ["Meta", 91],
  Command: ["Meta", 91],
  CapsLock: ["CapsLock", 20],
  NumLock: ["NumLock", 144],
  ScrollLock: ["ScrollLock", 145],
  Pause: ["Pause", 19],
  PrintScreen: ["PrintScreen", 44],
};
const modifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const isMac = () =>
  /mac/i.test(
    globalThis.navigator?.userAgentData?.platform ??
      globalThis.navigator?.platform ??
      "",
  );
export function keyDescription(input) {
  text(input, 128);
  const value =
    input === "ControlOrMeta" ? (isMac() ? "Meta" : "Control") : input;
  const entry = named[value];
  if (entry)
    return {
      key: entry[0],
      windowsVirtualKeyCode: entry[1],
      ...(modifierBits[entry[0]] ? { code: `${entry[0]}Left` } : {}),
    };
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(value))
    return {
      key: value,
      code: value,
      windowsVirtualKeyCode: 111 + Number(value.slice(1)),
    };
  requireValue(
    [...value].length === 1,
    "INVALID_ARGUMENT",
    "Use a single character or a supported native key name.",
  );
  const code = value.codePointAt(0),
    ascii = value.toUpperCase().charCodeAt(0);
  requireValue(code >= 32 && !(code >= 0xd800 && code <= 0xdfff));
  return {
    key: value,
    ...(/^[a-z]$/i.test(value)
      ? { code: `Key${value.toUpperCase()}`, windowsVirtualKeyCode: ascii }
      : /^[0-9]$/.test(value)
        ? { code: `Digit${value}`, windowsVirtualKeyCode: ascii }
        : value === " "
          ? { code: "Space", windowsVirtualKeyCode: 32 }
          : {}),
  };
}
export const keyToken = (params, source = {}) =>
  `${source.sessionId ?? ""}\0${params.key ?? params.code ?? params.windowsVirtualKeyCode}`;
export function heldModifiers(ctx) {
  let mask = 0;
  for (const entry of ctx.lease.keys.get(Number(ctx.target.tabId))?.values() ??
    [])
    if (!entry.source.sessionId) mask |= modifierBits[entry.params.key] ?? 0;
  return mask;
}
export async function keyDown(ctx, input, commands) {
  const key = keyDescription(input),
    modifier = modifierBits[key.key] ?? 0;
  const held = ctx.router.heldKey(ctx, key);
  const modifiers = heldModifiers(ctx) | modifier;
  // Headless macOS has no AppKit accelerator dispatch; ask Chromium's native editor to
  // perform the same Cmd+A operation on the currently focused editable element.
  const editCommands =
    commands ??
    (isMac() && key.key.toLowerCase() === "a" && modifiers === 4
      ? ["SelectAll"]
      : undefined);
  await ctx.router.send(ctx, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...key,
    modifiers,
    autoRepeat: !!held,
    ...(editCommands ? { commands: editCommands } : {}),
    ...(!modifier &&
    !((modifiers & (1 | 2 | 4)) !== 0) &&
    [...key.key].length === 1
      ? { text: key.key, unmodifiedText: key.key }
      : key.key === "Enter"
        ? { text: "\r", unmodifiedText: "\r" }
        : {}),
  });
  return { key, owned: !held };
}
export async function keyUp(ctx, input) {
  const key = keyDescription(input);
  await ctx.router.send(ctx, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...key,
    modifiers: heldModifiers(ctx) & ~(modifierBits[key.key] ?? 0),
  });
}
export async function pressKeys(ctx, inputs, duration = 0, commands) {
  requireValue(
    Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 8,
  );
  requireValue(Number.isFinite(duration) && duration >= 0 && duration <= 30);
  // Validate the entire chord before the first native key is pressed.
  inputs.forEach(keyDescription);
  const acquired = [];
  let failure;
  try {
    for (const [index, input] of inputs.entries()) {
      const key = keyDescription(input),
        previous = ctx.router.heldKey(ctx, key);
      // Keep the intent even if dispatch rejects after the browser accepted keyDown.
      if (!previous) acquired.push(key);
      await keyDown(
        ctx,
        input,
        index === inputs.length - 1 ? commands : undefined,
      );
    }
    if (duration > 0) await ctx.router.delay(ctx, duration * 1000);
  } catch (cause) {
    failure = cause;
  }
  for (const key of acquired.reverse()) {
    try {
      await ctx.router.releaseKey(ctx, key);
    } catch {
      failure ??= new BrowserActionError(
        "CDP_DISCONNECTED",
        "A native key release is not confirmed.",
        { dispatched: true, effect: "unknown" },
      );
    }
  }
  if (failure) throw failure;
}
export function chord(key, modifiers = []) {
  requireValue(Array.isArray(modifiers) && modifiers.length <= 7);
  text(key, 128);
  return [...modifiers, ...(key === "+" ? [key] : key.split("+"))];
}

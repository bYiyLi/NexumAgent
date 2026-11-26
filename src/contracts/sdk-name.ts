// Portable SDK root names, not npm package names or method keys.
export function isSDKNamespace(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i.test(value);
}

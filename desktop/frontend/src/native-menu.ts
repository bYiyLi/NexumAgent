// Native menu events are invalidation hints. Read the process-local snapshot
// to recover navigation requested before React observed the event.
export type NativeMenuDestination = "settings" | "about";
export type NativeMenuNavigation = {
  revision: number;
  destination: NativeMenuDestination;
};

export function parseNativeMenuNavigation(value: unknown): NativeMenuNavigation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const {revision, destination} = value as Record<string, unknown>;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) return null;
  if (destination !== "settings" && destination !== "about") return null;
  return {revision, destination};
}

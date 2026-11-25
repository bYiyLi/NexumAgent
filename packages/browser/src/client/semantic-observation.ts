import type { SemanticPageObservation } from "./types.js";

// Strings are always escaped. Do not turn arbitrary page-provided IDs into
// selectors or allow page content to forge a sibling node or metadata line.
const q = (value: string | number | boolean) => JSON.stringify(value);
const safeCssWord = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
export function formatSemanticObservation(observation: SemanticPageObservation): string {
  const lines = [
    "Page Observation",
    `Browser ID: ${q(observation.target.browserId)}`,
    `Tab ID: ${q(observation.target.tabId)}`,
    `Title: ${q(observation.title)}`,
    `URL: ${q(observation.url)}`,
    `Ready State: ${observation.readyState}`,
    `Coverage: ${observation.coverage} (rendered/mounted semantic DOM; not unmounted page data)`,
  ];
  if (observation.warnings.length) lines.push(`Warnings: ${observation.warnings.map(q).join(", ")}`);
  if (observation.dialog) lines.push(`Native dialog: ${q(observation.dialog.type)} ${q(observation.dialog.message)}`);
  lines.push("", "Semantic DOM");
  for (const node of observation.nodes) {
    const { id, class: classes, ...attributes } = node.attributes ?? {};
    const parts = [node.tag];
    if (id !== undefined) {
      if (safeCssWord.test(id)) parts[0] += `#${id}`;
      else parts.push(`id=${q(id)}`);
    }
    if (classes !== undefined) {
      const words = classes.split(/\s+/);
      if (words.every(word => safeCssWord.test(word))) parts[0] += words.map(word => `.${word}`).join("");
      else parts.push(`class=${q(classes)}`);
    }
    if (node.role !== undefined) parts.push(`role=${q(node.role)}`);
    if (node.name !== undefined) parts.push(q(node.name));
    if (node.text !== undefined) parts.push(node.name === undefined ? q(node.text) : `text=${q(node.text)}`);
    for (const [key, value] of Object.entries(attributes)) parts.push(`${key}=${q(value)}`);
    for (const [key,value] of Object.entries(node.states ?? {})) {
      if ((value === false || value === "false") && ["disabled","readonly","required","focused","multiple","busy","open","clickable","invalid"].includes(key)) continue;
      if (key === "valueRedacted" && value === true) { parts.push("value=[redacted]"); continue; }
      parts.push(value === true ? key : `${key}=${q(value)}`);
    }
    if (node.frameSelector !== undefined) parts.push(`frame-selector=${q(node.frameSelector)}`);
    if (node.locatorSupported === false) parts.push("locator=unsupported");
    lines.push(`${"  ".repeat(node.depth)}${parts.join(" ")}`);
  }
  return lines.join("\n");
}

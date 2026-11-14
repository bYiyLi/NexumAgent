/** Isolated CI diagnostics: names and lifecycle events only, no fixture values. */
export default async function* events(source) {
  for await (const event of source) {
    if (
      !["test:enqueue", "test:start", "test:pass", "test:fail"].includes(
        event.type,
      )
    )
      continue;
    yield JSON.stringify({
      ciTest: event.type,
      at: new Date().toISOString(),
      name: event.data.name,
      file: event.data.file,
      nesting: event.data.nesting,
    }) + "\n";
  }
}

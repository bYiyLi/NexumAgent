import { BrowserActionError, requireValue, text } from "./errors.js";
import { pageCommand } from "./page.js";

/** Transfer only native DOM identities into MAIN world; user code never closes over the resolver. */
export async function evaluateLocated(ctx, args, multiple, scope) {
  text(args.expression, 65536);
  const encoded = JSON.stringify(args.arg ?? null);
  requireValue(new TextEncoder().encode(encoded).byteLength <= 1024 * 1024);
  const { native, frameId, executionContextId, input } = scope;
  const objects = new Set();
  const retain = (object) => {
    if (typeof object?.objectId === "string") objects.add(object.objectId);
    return object;
  };
  const call = async (method, params) => {
    const result = await native(method, params);
    retain(result.result);
    retain(result.object);
    if (method === "Runtime.getProperties")
      for (const property of [
        ...(result.result ?? []),
        ...(result.internalProperties ?? []),
        ...(result.privateProperties ?? []),
      ])
        for (const key of ["value", "get", "set"]) retain(property[key]);
    requireValue(
      !result.exceptionDetails,
      "INVALID_ARGUMENT",
      "The locator page expression rejected.",
    );
    return result;
  };
  try {
    const observed = await call("Runtime.callFunctionOn", {
      executionContextId,
      functionDeclaration: pageCommand.toString(),
      arguments: [{ value: { ...input, command: "nativeNodes", multiple } }],
      awaitPromise: true,
      returnByValue: false,
    });
    const root = observed.result;
    if (root?.subtype !== (multiple ? "array" : "node")) {
      const error = root?.objectId
        ? await call("Runtime.callFunctionOn", {
            objectId: root.objectId,
            functionDeclaration: "function(){return this.error}",
            returnByValue: true,
          })
        : null;
      throw new BrowserActionError(
        error?.result?.value?.code ?? "INVALID_TARGET",
        error?.result?.value?.message ??
          "The locator no longer resolves to the required native nodes.",
      );
    }
    let nodes = [root];
    if (multiple) {
      const properties = await call("Runtime.getProperties", {
        objectId: root.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
      });
      const length = properties.result.find(
        (property) => property.name === "length",
      )?.value?.value;
      requireValue(
        Number.isInteger(length) && length >= 0 && length <= 10000,
        "OUTPUT_TOO_LARGE",
        "The locator node collection exceeds its native bridge budget.",
      );
      nodes = properties.result
        .filter((property) => /^(?:0|[1-9]\d*)$/.test(property.name))
        .sort((a, b) => Number(a.name) - Number(b.name))
        .map((property) => retain(property.value));
      requireValue(
        nodes.length === length &&
          nodes.every((node) => node?.subtype === "node" && node.objectId),
        "STALE_REF",
        "The original native node collection is no longer available.",
      );
    }
    const main = await ctx.router.frameContext(ctx, frameId, "main");
    const selected = [];
    for (const node of nodes) {
      const description = await call("DOM.describeNode", {
        objectId: node.objectId,
      });
      requireValue(
        Number.isInteger(description.node?.backendNodeId),
        "STALE_REF",
        "The original locator node was detached.",
      );
      const resolved = await call("DOM.resolveNode", {
        backendNodeId: description.node.backendNodeId,
        executionContextId: main,
      });
      requireValue(
        resolved.object?.subtype === "node" && resolved.object.objectId,
        "STALE_REF",
        "The original locator node has no live page-world identity.",
      );
      selected.push(resolved.object.objectId);
    }
    let first = selected[0];
    if (multiple) {
      const array = await call("Runtime.callFunctionOn", {
        executionContextId: main,
        functionDeclaration: "function(...nodes){return nodes}",
        arguments: selected.map((objectId) => ({ objectId })),
        returnByValue: false,
      });
      first = array.result?.objectId;
      requireValue(
        first,
        "STALE_REF",
        "The native page-world node collection was not created.",
      );
    }
    const fn = await call("Runtime.evaluate", {
      expression: `(${args.expression})`,
      contextId: main,
      returnByValue: false,
    });
    requireValue(
      fn.result?.type === "function" && fn.result.objectId,
      "INVALID_ARGUMENT",
      "Locator evaluation requires a page function.",
    );
    const result = await call("Runtime.callFunctionOn", {
      objectId: fn.result.objectId,
      functionDeclaration: "function(nodes,arg){return this(nodes,arg)}",
      arguments: [
        { objectId: first },
        ...(args.arg === undefined ? [{}] : [{ value: JSON.parse(encoded) }]),
      ],
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const value = result.result?.value ?? null;
    requireValue(
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024,
      "OUTPUT_TOO_LARGE",
      "The page expression exceeds its inline result budget.",
    );
    return value;
  } finally {
    // Cancellation cannot skip native RemoteObject release, and one failed release cannot skip the rest.
    const released = await Promise.allSettled(
      [...objects].map((objectId) =>
        ctx.router.releaseFrameObject(ctx, frameId, objectId),
      ),
    );
    requireValue(
      released.every((result) => result.status === "fulfilled"),
      "CDP_DISCONNECTED",
      "Some locator page objects have not confirmed native release.",
    );
  }
}

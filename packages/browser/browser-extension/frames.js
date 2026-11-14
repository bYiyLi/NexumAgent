import { BrowserActionError, requireValue, text } from "./errors.js";
import { pageCommand } from "./page.js";

/** Runs in a native isolated world. Returns the actual owner node, never a URL-derived guess. */
export function findFrameOwner(selector) {
  const nodes = document.querySelectorAll(selector);
  if (nodes.length !== 1 || !["IFRAME", "FRAME"].includes(nodes[0].tagName))
    throw new Error(
      "The frame selector must resolve to exactly one current frame owner.",
    );
  return nodes[0];
}
export function frameOwnerGeometry() {
  if (!this.isConnected) throw new Error("The frame owner was detached.");
  for (let node = this; node; node = node.parentElement) {
    const transform = getComputedStyle(node).transform;
    if (transform !== "none") {
      const matrix = new DOMMatrixReadOnly(transform);
      if (
        !matrix.is2D ||
        Math.abs(matrix.b) > 0.000001 ||
        Math.abs(matrix.c) > 0.000001 ||
        matrix.a <= 0 ||
        matrix.d <= 0
      )
        throw new Error(
          "The frame transform is not an axis-aligned positive scale.",
        );
    }
  }
  const rect = this.getBoundingClientRect(),
    style = getComputedStyle(this);
  const scaleX = rect.width / this.offsetWidth,
    scaleY = rect.height / this.offsetHeight;
  if (![scaleX, scaleY].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0)
    throw new Error("The frame has no native visible content area.");
  return {
    x:
      rect.x +
      (this.clientLeft + parseFloat(style.paddingLeft || "0")) * scaleX,
    y: rect.y + (this.clientTop + parseFloat(style.paddingTop || "0")) * scaleY,
    scaleX,
    scaleY,
  };
}
export function frameHitTest(input) {
  const node = this.ownerDocument.elementFromPoint(input.x, input.y);
  return this.isConnected && (node === this || this.contains(node));
}

function mappedPoint(point, owners) {
  let result = { x: point.x, y: point.y };
  for (const owner of [...owners].reverse())
    result = {
      x: owner.geometry.x + result.x * owner.geometry.scaleX,
      y: owner.geometry.y + result.y * owner.geometry.scaleY,
    };
  return result;
}
function mappedRect(rect, owners) {
  const start = mappedPoint(rect, owners),
    end = mappedPoint(
      { x: rect.x + rect.width, y: rect.y + rect.height },
      owners,
    );
  return { ...start, width: end.x - start.x, height: end.y - start.y };
}
export async function framePage(ctx, payload, selectors, execute) {
  requireValue(
    Array.isArray(selectors) && selectors.length > 0 && selectors.length <= 8,
  );
  selectors.forEach((selector) => text(selector, 8192));
  await ctx.router.enableFrameTargets(ctx);
  const tree = await ctx.router.send(ctx, "Page.getFrameTree", {});
  let frameId = tree.frameTree?.frame?.id;
  text(frameId, 512);
  const owners = [];
  const native = async (method, params, id = frameId) =>
    ctx.router.frameSend(ctx, id, method, params);
  const world = async () => {
    const result = await native("Page.createIsolatedWorld", {
      frameId,
      worldName: "nexum.browser.frame.v1",
      grantUniveralAccess: false,
    });
    requireValue(
      Number.isInteger(result.executionContextId),
      "STALE_REF",
      "The browser did not create the actual frame world.",
    );
    return result.executionContextId;
  };
  try {
    for (const selector of selectors) {
      ctx.signal?.throwIfAborted();
      const result = await native("Runtime.callFunctionOn", {
        executionContextId: await world(),
        functionDeclaration: findFrameOwner.toString(),
        arguments: [{ value: selector }],
        returnByValue: false,
      });
      requireValue(
        !result.exceptionDetails &&
          result.result?.subtype === "node" &&
          typeof result.result.objectId === "string",
        "INVALID_TARGET",
        "The frame selector must resolve to one current native frame owner.",
      );
      const owner = { frameId, objectId: result.result.objectId };
      owners.push(owner);
      const node = await native("DOM.describeNode", {
        objectId: owner.objectId,
      });
      requireValue(
        typeof node.node?.frameId === "string" && node.node.frameId !== frameId,
        "STALE_REF",
        "The observed native node has no live child-frame identity.",
      );
      const geometry = await native("Runtime.callFunctionOn", {
        objectId: owner.objectId,
        functionDeclaration: frameOwnerGeometry.toString(),
        returnByValue: true,
      });
      requireValue(
        !geometry.exceptionDetails && geometry.result?.value,
        "INVALID_TARGET",
        "The current frame transform has no supported native coordinate mapping.",
      );
      owner.geometry = geometry.result.value;
      ctx.router.noteFrameParent(ctx, node.node.frameId, frameId);
      frameId = node.node.frameId;
    }
    const input = {
      ...payload,
      framePath: [],
      ...(payload.locator
        ? { locator: { ...payload.locator, framePath: [] } }
        : {}),
      pageVersion: ctx.router.version(ctx.target.tabId),
      leaseId: ctx.router.referenceLease(ctx),
    };
    const executionContextId = await world();
    if (execute)
      return await execute({ input, native, frameId, executionContextId });
    const response = await native("Runtime.callFunctionOn", {
      executionContextId,
      functionDeclaration: pageCommand.toString(),
      arguments: [{ value: input }],
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    requireValue(
      !response.exceptionDetails && response.result?.value,
      "STALE_REF",
      "The actual frame execution context is no longer available.",
    );
    const result = response.result.value;
    if (!result.ok)
      throw new BrowserActionError(result.error.code, result.error.message);
    if (input.command === "resolve" && result.value?.rect) {
      // scrollIntoView in the resolved descendant can scroll every native ancestor.
      // Coordinates read during traversal are no longer an observation of this input target.
      for (const owner of owners) {
        const geometry = await ctx.router.frameSend(
          ctx,
          owner.frameId,
          "Runtime.callFunctionOn",
          {
            objectId: owner.objectId,
            functionDeclaration: frameOwnerGeometry.toString(),
            returnByValue: true,
          },
        );
        requireValue(
          !geometry.exceptionDetails && geometry.result?.value,
          "STALE_REF",
          "An ancestor frame moved or detached before native input.",
        );
        owner.geometry = geometry.result.value;
      }
      let point = {
        x: result.value.rect.x + result.value.rect.width / 2,
        y: result.value.rect.y + result.value.rect.height / 2,
      };
      for (const owner of [...owners].reverse()) {
        point = {
          x: owner.geometry.x + point.x * owner.geometry.scaleX,
          y: owner.geometry.y + point.y * owner.geometry.scaleY,
        };
        const hit = await ctx.router.frameSend(
          ctx,
          owner.frameId,
          "Runtime.callFunctionOn",
          {
            objectId: owner.objectId,
            functionDeclaration: frameHitTest.toString(),
            arguments: [{ value: point }],
            returnByValue: true,
          },
        );
        requireValue(
          !hit.exceptionDetails && hit.result?.value === true,
          "INVALID_TARGET",
          "Another element blocks an ancestor frame's native action target.",
        );
      }
      result.value.rect = mappedRect(result.value.rect, owners);
    }
    if (input.command === "elementInfo" && Array.isArray(result.value))
      for (const entry of result.value)
        if (entry.boundingBox)
          entry.boundingBox = mappedRect(entry.boundingBox, owners);
    return result.value;
  } finally {
    for (const owner of owners.reverse())
      await ctx.router.releaseFrameObject(ctx, owner.frameId, owner.objectId);
  }
}

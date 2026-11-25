/** Serialized by chrome.scripting into the extension's isolated page world. No outer closure is used. */
export async function pageCommand(input) {
  const failure = (code, message, reason) => {
    throw Object.assign(new Error(message), { code, reason });
  };
  const check = (
    value,
    code = "INVALID_ARGUMENT",
    message = "The page input is invalid.",
    reason,
  ) => {
    if (!value) failure(code, message, reason);
  };
  try {
    const slot = Symbol.for("nexum.browser.document.v1");
    let state = globalThis[slot];
    if (
      !state ||
      state.document !== document ||
      state.version !== input.pageVersion
    ) {
      for (const receipt of state?.clickReceipts?.values?.() ?? []) {
        document.removeEventListener(receipt.type, receipt.listener, true);
        clearTimeout(receipt.timer);
      }
      state = {
        document,
        version: input.pageVersion,
        token: [...crypto.getRandomValues(new Uint8Array(16))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join(""),
        next: 0,
        refs: new Map(),
        reverse: new WeakMap(),
        clickReceipts: new Map(),
      };
      Object.defineProperty(globalThis, slot, {
        value: state,
        configurable: true,
      });
    }
    const maxBytes = Math.min(input.maxBytes ?? 65536, 1024 * 1024);
    const encodeSize = (value) =>
      new TextEncoder().encode(
        typeof value === "string" ? value : JSON.stringify(value),
      ).byteLength;
    const bounded = (value) => {
      check(
        encodeSize(value) <= maxBytes,
        "OUTPUT_TOO_LARGE",
        "Use a scoped observation or an exported file for this page result.",
      );
      return value;
    };
    const owned = (node) =>
      !!node.closest?.(
        '[data-nexum-visual-layer="v1"],[data-nexum-visual-icon="v1"]',
      );
    const elements = (root) =>
      [...root.querySelectorAll("*")].filter((node) => !owned(node));
    const visible = (node) => {
      if (!(node instanceof Element) || !node.isConnected) return false;
      const style = getComputedStyle(node),
        rect = node.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const enabled = (node) => {
      // The native pseudo-class includes controls disabled by a fieldset or
      // optgroup, even when their own `disabled` property remains false.
      if (node.disabled || node.matches?.(":disabled")) return false;
      for (
        let current = node;
        current;
        current = current.parentElement ?? current.getRootNode?.()?.host ?? null
      ) {
        const state = current.getAttribute("aria-disabled")?.toLowerCase();
        if (state === "true") return false;
        if (state === "false") return true;
      }
      return true;
    };
    const roleExposed = (node) => {
      const style = getComputedStyle(node);
      if (["hidden", "collapse"].includes(style.visibility)) return false;
      for (let current = node; current; current = current.parentElement) {
        if (
          current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
          current.inert ||
          getComputedStyle(current).display === "none"
        )
          return false;
      }
      return true;
    };
    const role = (node) =>
      node.getAttribute("role") ||
      {
        BUTTON: "button",
        A: node.hasAttribute("href") ? "link" : "generic",
        TEXTAREA: "textbox",
        SELECT: "combobox",
        IMG: "img",
        H1: "heading",
        H2: "heading",
        H3: "heading",
        INPUT: ["checkbox", "radio"].includes(node.type)
          ? node.type
          : ["button", "submit", "reset"].includes(node.type)
            ? "button"
            : "textbox",
      }[node.tagName] ||
      "generic";
    // An implicit label contains the control itself. Its option/value text
    // must not become part of that control's own locator name.
    const labelText = (label, control) => {
      if (!label.childNodes) return label.textContent || "";
      const pending = [...label.childNodes].reverse(), parts = [];
      while (pending.length) {
        const child = pending.pop();
        if (child === control) continue;
        if (child.nodeType === 3) parts.push(child.nodeValue || "");
        else if (child.nodeType === 1 && child.childNodes)
          for (let i = child.childNodes.length - 1; i >= 0; i--)
            pending.push(child.childNodes[i]);
      }
      return parts.join("").replace(/\s+/g, " ").trim();
    };
    const name = (node) =>
      (node.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || "")
        .filter(Boolean)
        .join(" ")
        .trim() ||
      node.getAttribute("aria-label") ||
      Array.from(node.labels || [], (label) => labelText(label, node)).filter(Boolean).join(" ") ||
      node.getAttribute("alt") ||
      node.innerText?.trim() ||
      node.textContent?.trim() ||
      "";
    const matcher = (value, rule, normalizeText = false) => {
      check(rule && ["text", "regexp"].includes(rule.kind));
      if (rule.kind === "regexp") {
        check(
          typeof rule.source === "string" &&
            encodeSize(rule.source) <= 1024 &&
            typeof rule.flags === "string",
        );
        return new RegExp(rule.source, rule.flags).test(value);
      }
      check(typeof rule.value === "string");
      const normalize = (text) =>
        text
          .replace(/[\u200b\u00ad]/g, "")
          .trim()
          .replace(/\s+/g, " ");
      const actual = normalizeText ? normalize(value) : value;
      const expected = normalizeText ? normalize(rule.value) : rule.value;
      return rule.exact
        ? actual === expected
        : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
    };
    const skipText = (node) =>
      ["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.tagName) ||
      !!node.ownerDocument?.head?.contains(node);
    const textValue = (node) => {
      if (skipText(node)) return "";
      const buttonValue = (element) =>
        element.tagName === "INPUT" &&
        ["button", "submit", "reset"].includes(element.type?.toLowerCase());
      if (buttonValue(node)) return node.value || "";
      if (!node.childNodes) return node.textContent || "";
      const pending = [...node.childNodes].reverse(),
        parts = [];
      while (pending.length) {
        const child = pending.pop();
        if (child.nodeType === 3) parts.push(child.nodeValue || "");
        else if (child.nodeType === 1 && !skipText(child)) {
          if (buttonValue(child)) parts.push(child.value || "");
          else
            for (let index = child.childNodes.length - 1; index >= 0; index--)
              pending.push(child.childNodes[index]);
        }
      }
      return parts.join("");
    };
    const makeRef = (node) => {
      let byLease = state.reverse.get(node);
      if (!byLease) {
        byLease = new Map();
        state.reverse.set(node, byLease);
      }
      let ref = byLease.get(input.leaseId);
      if (!ref) {
        check(
          state.refs.size < 10000,
          "QUEUE_FULL",
          "This document reached its fixed-reference budget.",
        );
        ref = `r_${input.leaseId}_${state.version}_${state.token}_${++state.next}`;
        byLease.set(input.leaseId, ref);
        state.refs.set(ref, node);
      }
      return ref;
    };
    const getRef = (ref, pageVersion = input.pageVersion) => {
      check(
        pageVersion === state.version &&
          typeof ref === "string" &&
          ref.startsWith(`r_${input.leaseId}_${state.version}_${state.token}_`),
        "STALE_REF",
        "The element observation belongs to another document.",
      );
      const node = state.refs.get(ref);
      check(
        node && node.isConnected,
        "STALE_REF",
        "The observed element is no longer available.",
      );
      return node;
    };
    let astNodes = new Set();
    const query = (root, ast, depth = 0) => {
      check(depth <= 16 && ast && typeof ast === "object");
      astNodes.add(ast);
      check(astNodes.size <= 128);
      let result;
      const sub = (value, scope = root) => query(scope, value, depth + 1);
      switch (ast.kind) {
        case "selector":
          check(typeof ast.selector === "string");
          result = [...root.querySelectorAll(ast.selector)];
          break;
        case "role":
          result = elements(root).filter(
            (n) =>
              role(n) === ast.role &&
              roleExposed(n) &&
              (!ast.name ||
                matcher(
                  name(n),
                  ast.name.kind === "text" && ast.exact !== undefined
                    ? { ...ast.name, exact: ast.exact }
                    : ast.name,
                )),
          );
          break;
        case "label":
          result = elements(root).filter(
            (n) =>
              matcher(name(n), ast.matcher) &&
              (n.labels?.length ||
                n.hasAttribute("aria-label") ||
                n.hasAttribute("aria-labelledby")),
          );
          break;
        case "placeholder":
          result = elements(root).filter((n) =>
            matcher(n.getAttribute("placeholder") || "", ast.matcher),
          );
          break;
        case "testId":
          result = elements(root).filter(
            (n) => n.getAttribute("data-testid") === ast.value,
          );
          break;
        case "text":
          result = elements(root).filter(
            (n) =>
              !skipText(n) &&
              matcher(textValue(n), ast.matcher, true) &&
              ![...n.children].some(
                (c) => !skipText(c) && matcher(textValue(c), ast.matcher, true),
              ),
          );
          break;
        case "descendant":
          result = sub(ast.root).flatMap((n) => sub(ast.query, n));
          break;
        case "and": {
          const right = new Set(sub(ast.right));
          result = sub(ast.left).filter((n) => right.has(n));
          break;
        }
        case "or":
          result = [...new Set([...sub(ast.left), ...sub(ast.right)])].sort(
            (left, right) => {
              const position = left.compareDocumentPosition(right);
              if (position & Node.DOCUMENT_POSITION_DISCONNECTED) return 0;
              if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
              if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
              return 0;
            },
          );
          break;
        case "position": {
          const all = sub(ast.query);
          check(
            ast.at === "first" ||
              ast.at === "last" ||
              (Number.isInteger(ast.at) && ast.at >= 0),
          );
          const at =
            ast.at === "first"
              ? 0
              : ast.at === "last"
                ? all.length - 1
                : ast.at;
          result = at >= 0 && all[at] ? [all[at]] : [];
          break;
        }
        case "filter":
          result = sub(ast.query).filter(
            (n) =>
              (ast.visible === undefined || visible(n) === ast.visible) &&
              (!ast.has || sub(ast.has, n).length > 0) &&
              (!ast.hasNot || sub(ast.hasNot, n).length === 0) &&
              (!ast.hasText || matcher(textValue(n), ast.hasText, true)) &&
              (!ast.hasNotText || !matcher(textValue(n), ast.hasNotText, true)),
          );
          break;
        case "ref":
          result = [getRef(ast.ref, ast.pageVersion)];
          break;
        default:
          failure("INVALID_ARGUMENT", "Unknown locator AST node.");
      }
      return [...new Set(result)].filter((node) => !owned(node));
    };
    let root = document;
    const framePath = input.locator?.framePath || input.framePath || [];
    check(Array.isArray(framePath) && framePath.length <= 8);
    for (const selector of framePath) {
      const frames = [...root.querySelectorAll(selector)];
      check(
        frames.length === 1,
        frames.length > 1 ? "AMBIGUOUS_TARGET" : "INVALID_TARGET",
        "A frame selector must match one frame.",
      );
      check(
        frames[0].contentDocument,
        "CAPABILITY_NOT_ALLOWED",
        "This page-world route cannot enter this frame; use a registered native frame target.",
      );
      root = frames[0].contentDocument;
    }
    const all = () => {
      astNodes = new Set();
      if (input.ref) return [getRef(input.ref)];
      if (input.nodeId) return [getRef(input.nodeId)];
      return query(root, input.locator?.query ?? input.query);
    };
    const actionGeometry = (node, pending = false) => {
      if (pending && !(visible(node) && enabled(node))) return null;
      check(
        visible(node) && enabled(node),
        "INVALID_TARGET",
        "The current element is not visible and enabled.",
        "element_not_actionable",
      );
      // The first preflight scrolls the target into view. Later checks must
      // observe the compositor's settled position without requesting another
      // scroll that can move the target after coordinates were captured.
      if (!input.noScroll)
        node.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        });
      const r = rect(node),
        position = input.command === "resolve" ? input.position : undefined;
      const x = position?.x ?? r.width / 2,
        y = position?.y ?? r.height / 2;
      check(
        Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          y >= 0 &&
          x < r.width &&
          y < r.height,
        "INVALID_ARGUMENT",
        "The requested position must be inside the current element rectangle.",
      );
      const point = { x: r.x + x, y: r.y + y };
      const top = node.ownerDocument.elementFromPoint(point.x, point.y);
      if (pending && !(top === node || node.contains(top))) return null;
      check(
        top === node || node.contains(top),
        "INVALID_TARGET",
        "Another element blocks the action target.",
        "element_blocked",
      );
      return { rect: r, point };
    };
    const unique = (action = false, pending = false) => {
      const found = all();
      if (pending && found.length === 0) return null;
      check(
        found.length === 1,
        found.length > 1 ? "AMBIGUOUS_TARGET" : "INVALID_TARGET",
        "The locator must resolve to exactly one current element.",
        found.length > 1 ? "element_not_unique" : "element_not_found",
      );
      const node = found[0];
      if (action) actionGeometry(node);
      return node;
    };
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const describe = (node) => ({
      ref: makeRef(node),
      role: role(node),
      name: name(node).slice(0, 4096),
      disabled: !enabled(node),
      ...(typeof node.checked === "boolean" ? { checked: node.checked } : {}),
    });
    const setValue = (node, value) => {
      check(typeof value === "string");
      check(!node.readOnly, "INVALID_TARGET", "The element is readonly.");
      if (node.isContentEditable) node.textContent = value;
      else {
        check(
          ["INPUT", "TEXTAREA"].includes(node.tagName),
          "INVALID_TARGET",
          "The target is not a text input.",
        );
        const proto =
          node.tagName === "INPUT"
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
      }
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    };
    let value;
    switch (input.command) {
      case "inputReceipt": {
        check(
          typeof input.token === "string" &&
            input.token.length > 0 &&
            input.token.length <= 128,
        );
        const receipts = (state.clickReceipts ??= new Map());
        const release = (receipt) => {
          if (!receipt) return;
          document.removeEventListener(receipt.type, receipt.listener, true);
          clearTimeout(receipt.timer);
          receipts.delete(input.token);
        };
        if (input.action === "arm") {
          check(!receipts.has(input.token) && receipts.size < 32, "QUEUE_FULL");
          check(
            Number.isFinite(input.x) &&
              Number.isFinite(input.y) &&
              [0, 1, 2].includes(input.button) &&
              Number.isFinite(input.expiresAt) &&
              input.expiresAt > Date.now(),
          );
          const type =
            input.button === 2
              ? "contextmenu"
              : input.button === 1
                ? "auxclick"
                : "click";
          const expected = input.expectedRef
            ? getRef(input.expectedRef)
            : null;
          if (expected) {
            const hit = document.elementFromPoint(input.x, input.y);
            if (hit !== expected && !expected.contains(hit)) {
              value = { armed: false, documentToken: state.token };
              break;
            }
          }
          const receipt = {
            type,
            count: 0,
            expiresAt: input.expiresAt,
            x: input.x,
            y: input.y,
            button: input.button,
            expected,
          };
          receipt.listener = (event) => {
            if (
              event.isTrusted &&
              event.button === input.button &&
              (!receipt.expected ||
                event.composedPath().includes(receipt.expected)) &&
              Math.abs(event.clientX - input.x) <= 6 &&
              Math.abs(event.clientY - input.y) <= 6
            )
              receipt.count++;
          };
          receipt.timer = setTimeout(
            () => release(receipt),
            Math.min(30000, input.expiresAt - Date.now()),
          );
          document.addEventListener(type, receipt.listener, true);
          receipts.set(input.token, receipt);
          value = { armed: true, documentToken: state.token };
        } else if (input.action === "peek" || input.action === "drop") {
          check(
            !input.expectedDocumentToken ||
              input.expectedDocumentToken === state.token,
            "STALE_REF",
            "The receipt belongs to a replaced document.",
          );
          const receipt = receipts.get(input.token);
          value = { observed: receipt?.count ?? 0 };
          if (input.action === "drop") release(receipt);
        } else check(false);
        break;
      }
      // Core-only native bridge: the caller retains the actual remote Node(s), never serializes them.
      case "nativeNodes":
        return input.multiple ? all() : unique();
      case "scroll": {
        const x = input.x ?? 0,
          y = input.y ?? 0;
        check(
          Number.isFinite(x) &&
            Number.isFinite(y) &&
            Math.abs(x) <= 1000000000 &&
            Math.abs(y) <= 1000000000,
        );
        check(["auto", "smooth"].includes(input.behavior ?? "auto"));
        const node = input.ref || input.nodeId ? unique() : globalThis;
        node.scrollBy({ left: x, top: y, behavior: input.behavior ?? "auto" });
        value = null;
        break;
      }
      case "waitProbe": {
        const condition = input.condition;
        let matched = false;
        if (["element", "selector"].includes(condition.kind)) {
          const found = query(root, {
              kind: "selector",
              selector: condition.selector ?? condition.value,
            }),
            wanted = condition.state ?? "visible";
          check(["attached", "detached", "visible", "hidden"].includes(wanted));
          matched =
            wanted === "attached"
              ? found.length > 0
              : wanted === "detached"
                ? found.length === 0
                : wanted === "visible"
                  ? found.some(visible)
                  : !found.some(visible);
        } else if (condition.kind === "text")
          matched = (
            document.body?.innerText ??
            document.documentElement?.textContent ??
            ""
          ).includes(condition.value);
        else if (condition.kind === "url")
          matched = location.href === condition.value;
        else if (condition.kind === "navigation")
          matched = !condition.url || location.href === condition.url;
        else if (condition.kind === "state") matched = true;
        else failure("INVALID_ARGUMENT", "Unknown page wait condition.");
        value = {
          matched,
          documentToken: state.token,
          url: location.href,
          readyState: document.readyState,
        };
        break;
      }
      case "readyState":
        value = document.readyState;
        break;
      case "devicePixelRatio":
        value = globalThis.devicePixelRatio;
        break;
      case "mediaSource": {
        let node =
          input.locator || input.ref || input.nodeId
            ? unique()
            : root.elementFromPoint(input.x, input.y);
        check(
          node,
          "INVALID_TARGET",
          "There is no current media target at the requested point.",
        );
        node = node.closest?.("img,video,audio,source") ?? node;
        if (!["IMG", "VIDEO", "AUDIO", "SOURCE"].includes(node.tagName))
          node = node.querySelector?.("img,video,audio,source");
        check(
          node && ["IMG", "VIDEO", "AUDIO", "SOURCE"].includes(node.tagName),
          "INVALID_TARGET",
          "The exact target contains no readable native media source.",
        );
        const raw =
          node.currentSrc ||
          node.src ||
          node.getAttribute("src") ||
          node.querySelector?.("source[src]")?.src;
        check(
          typeof raw === "string" && raw.length > 0,
          "FILE_UNAVAILABLE",
          "The actual media element has no current source URL.",
        );
        const url = new URL(raw, node.ownerDocument.baseURI).href;
        check(
          /^(?:https?:|blob:|data:)/.test(url),
          "FILE_UNAVAILABLE",
          "The actual media source URL is not readable by this adapter.",
        );
        value = { url, ref: makeRef(node), mimeType: node.type || null };
        bounded(value);
        break;
      }
      case "fileInfo": {
        const node = unique();
        check(
          node.tagName === "INPUT" && node.type === "file",
          "INVALID_TARGET",
          "The observed node is not a file input.",
        );
        value = { multiple: node.multiple };
        break;
      }
      case "snapshot": {
        const nodes = elements(root)
          .filter(
            (n) =>
              visible(n) && (role(n) !== "generic" || n.children.length === 0),
          )
          .map(describe);
        value = {
          url: location.href,
          title: document.title,
          root: {
            ref: "document",
            role: "document",
            name: document.title,
            children: nodes,
          },
          truncated: false,
        };
        bounded(value);
        break;
      }
      case "domSnapshot":
        value = elements(root)
          .filter(visible)
          .map(
            (n) =>
              `${makeRef(n)} ${role(n)} ${JSON.stringify(name(n).slice(0, 2048))}`,
          )
          .join("\n");
        bounded(value);
        break;
      case "visibleTree":
        value = {
          nodes: elements(root)
            .filter(visible)
            .map((n) => ({
              nodeId: makeRef(n),
              role: role(n),
              name: name(n).slice(0, 4096),
              rect: rect(n),
            })),
          truncated: false,
        };
        bounded(value);
        break;
      case "count":
        value = all().length;
        break;
      case "all":
        value = all().map((n) => ({
          kind: "ref",
          ref: makeRef(n),
          pageVersion: state.version,
        }));
        break;
      case "allTextContents":
        value = all().map((n) => n.textContent || "");
        bounded(value);
        break;
      case "textContent":
        value = unique().textContent;
        bounded(value);
        break;
      case "innerText":
        value = unique().innerText;
        bounded(value);
        break;
      case "isVisible": {
        const n = all();
        check(n.length <= 1, "AMBIGUOUS_TARGET");
        value = n.length === 1 && visible(n[0]);
        break;
      }
      case "isEnabled":
        value = enabled(unique());
        break;
      case "getAttribute":
        check(typeof input.name === "string");
        value = unique().getAttribute(input.name);
        bounded(value);
        break;
      case "resolve": {
        const node = unique(false, true),
          geometry = node && actionGeometry(node, true);
        value = geometry
          ? {
              ...describe(node),
              ...geometry,
              tagName: node.tagName,
              documentToken: state.token,
            }
          : null;
        break;
      }
      case "fill": {
        const node = unique(true),
          expected = input.value ?? input.text;
        setValue(node, expected);
        check(
          (node.isContentEditable ? node.textContent : node.value) === expected,
          "INVALID_TARGET",
          "The input did not retain the requested value.",
        );
        value = null;
        break;
      }
      case "focus":
        unique(true).focus();
        value = null;
        break;
      case "selectOption": {
        const node = unique(true);
        check(
          node.tagName === "SELECT",
          "INVALID_TARGET",
          "The target is not a select element.",
        );
        const values = Array.isArray(input.values ?? input.value)
          ? (input.values ?? input.value)
          : [input.values ?? input.value];
        check(node.multiple || values.length <= 1);
        const matches = values.map((item) =>
          [...node.options].find((o, index) =>
            typeof item === "string"
              ? o.value === item
              : (item.value === undefined || o.value === item.value) &&
                (item.label === undefined || o.label === item.label) &&
                (item.index === undefined || index === item.index),
          ),
        );
        check(
          matches.every(Boolean),
          "INVALID_TARGET",
          "A requested select option is missing.",
        );
        for (const option of node.options)
          option.selected = matches.includes(option);
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        value = matches.map((o) => o.value);
        const actual = [...node.selectedOptions].map((o) => o.value);
        check(
          actual.length === value.length &&
            actual.every((item) => value.includes(item)),
          "INVALID_TARGET",
          "The select did not retain the requested option values.",
        );
        break;
      }
      case "checked": {
        const node = unique();
        check(
          typeof node.checked === "boolean",
          "INVALID_TARGET",
          "The target is not checkable.",
        );
        value = node.checked;
        break;
      }
      case "waitState": {
        const found = all();
        value =
          input.state === "attached"
            ? found.length > 0
            : input.state === "detached"
              ? found.length === 0
              : input.state === "visible"
                ? found.some(visible)
                : !found.some(visible);
        break;
      }
      case "elementInfo":
      case "elementScreenshot": {
        const node = root.elementFromPoint(input.x, input.y);
        if (input.command === "elementScreenshot") {
          check(
            node,
            "INVALID_TARGET",
            "No element exists at these coordinates.",
          );
          const box = rect(node);
          // Observe the element and its document scroll in the same native
          // execution. Screenshot clips use document CSS coordinates.
          value = {
            ...box,
            x: box.x + globalThis.scrollX,
            y: box.y + globalThis.scrollY,
          };
          break;
        }
        value = !node
          ? []
          : [
              {
                preview: node.outerHTML.slice(0, 4096),
                tagName: node.tagName.toLowerCase(),
                role: role(node),
                ariaName: name(node),
                visibleText: (node.innerText || "").slice(0, 4096),
                boundingBox: rect(node),
                testId: node.getAttribute("data-testid"),
                selector: { candidates: [], primary: null },
                ref: makeRef(node),
              },
            ];
        break;
      }
      case "content":
        if (input.format === "html") {
          const copy = root.documentElement.cloneNode(true);
          for (const node of copy.querySelectorAll(
            '[data-nexum-visual-layer="v1"],[data-nexum-visual-icon="v1"]',
          ))
            node.remove();
          value = copy.outerHTML;
        } else
          value =
            root.body?.innerText || root.documentElement.textContent || "";
        bounded(value);
        break;
      case "readText":
        value = await navigator.clipboard.readText();
        bounded(value);
        break;
      case "writeText":
        check(typeof input.text === "string");
        await navigator.clipboard.writeText(input.text);
        value = null;
        break;
      case "assets":
        value = [
          ...new Set([
            ...elements(root).flatMap((n) =>
              [n.src, n.href, n.poster].filter(
                (v) => typeof v === "string" && /^https?:/.test(v),
              ),
            ),
            ...performance
              .getEntriesByType("resource")
              .map((n) => n.name)
              .filter((v) => /^https?:/.test(v)),
          ]),
        ];
        bounded(value);
        break;
      default:
        failure(
          "CAPABILITY_NOT_ALLOWED",
          "This build has no implementation for that page command.",
        );
    }
    return { ok: true, value };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: typeof cause?.code === "string" ? cause.code : "INVALID_ARGUMENT",
        message:
          typeof cause?.code === "string"
            ? cause.message
            : "The page command could not be completed.",
        ...(typeof cause?.reason === "string" ? { reason: cause.reason } : {}),
      },
    };
  }
}

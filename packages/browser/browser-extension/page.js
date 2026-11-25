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
  // The same serialized resolver is used in the main document and native
  // child-frame worlds. Open roots extend query scope, never frame scope.
  const openRoot = (node) => node?.shadowRoot?.mode === "open" ? node.shadowRoot : null;
  const treeParent = (node) => {
    if (node?.parentElement) return node.parentElement;
    const root = node?.getRootNode?.();
    return root?.mode === "open" && openRoot(root.host) === root ? root.host : null;
  };
  const composedParent = (node) => node?.assignedSlot ?? treeParent(node);
  // Cache only for the duration of this synchronous page command. Slot
  // redistribution and DOM edits are observed again by the very next command.
  const renderedCache = new WeakMap();
  const renderedInTree = (node) => {
    const pending = [];
    let result = true;
    for (let current = node; current; current = composedParent(current)) {
      if (renderedCache.has(current)) { result = renderedCache.get(current); break; }
      pending.push(current);
      if (current.assignedSlot) continue;
      const parent = current.parentElement;
      if (openRoot(parent) || (parent?.tagName === "SLOT" && parent.assignedNodes?.().length)) {
        result = false;
        break;
      }
    }
    for (const current of pending) renderedCache.set(current, result);
    return result;
  };
  const contains = (ancestor, node) => {
    for (let current = node; current; current = composedParent(current))
      if (current === ancestor) return true;
    return false;
  };
  const privateLayer = '[data-nexum-visual-layer="v1"],[data-nexum-visual-icon="v1"]';
  const ownedCache = new WeakMap();
  const owned = (node) => {
    const pending = [];
    let result = false;
    for (let current = node; current; current = composedParent(current)) {
      if (ownedCache.has(current)) { result = ownedCache.get(current); break; }
      pending.push(current);
      if (current.closest?.(privateLayer)) { result = true; break; }
    }
    for (const current of pending) ownedCache.set(current,result);
    return result;
  };
  const rootAccess = new WeakMap();
  const accessibleRoot = (node) => {
    const pending = [];
    let result = true;
    for (let current = node; current;) {
      const root = current.getRootNode?.();
      if (!root?.host) break;
      if (rootAccess.has(root)) { result = rootAccess.get(root); break; }
      pending.push(root);
      if (root.mode !== "open" || openRoot(root.host) !== root) { result = false; break; }
      current = root.host;
    }
    for (const root of pending) rootAccess.set(root,result);
    return result;
  };
  // One command, one deterministic shadow-including preorder. A SLOT adds
  // its actual assigned subtree to the current scope. Keep inactive light
  // and fallback elements available to explicit CSS, but visit each node
  // only once. No cross-document traversal, fabricated CSS relationships,
  // DOM mutation or persistent tree index.
  const treeCache = new WeakMap(), hasOpenBelow = new WeakSet();
  const tree = (scope) => {
    const cached = treeCache.get(scope);
    if (cached) return cached;
    const roots = [], nodes = [], seen = new Set(), nativeCovered = new Set();
    const stack = [];
    const enter = (root) => {
      roots.push(root);
      stack.push({native:true,iterator:(root.querySelectorAll?.("*") ?? [])[Symbol.iterator]()});
    };
    function* branch(node) {
      yield node;
      yield* node.querySelectorAll?.("*") ?? [];
    }
    const enterAssignments = (slot) => {
      if (slot?.tagName !== "SLOT" || !accessibleRoot(slot) || !renderedInTree(slot)) return;
      const assigned = slot.assignedElements?.() ?? [];
      for (let i = assigned.length - 1; i >= 0; i--)
        if (!seen.has(assigned[i])) stack.push({native:false,iterator:branch(assigned[i])});
    };
    const noteShadow = (host) => {
      for (let node = host; node && !hasOpenBelow.has(node); node = treeParent(node)) hasOpenBelow.add(node);
    };
    enter(scope);
    const ownRoot = openRoot(scope);
    if (ownRoot) { noteShadow(scope); enter(ownRoot); }
    enterAssignments(scope);
    while (stack.length) {
      const entry = stack.at(-1), next = entry.iterator.next();
      if (next.done) { stack.pop(); continue; }
      const node = next.value;
      if (entry.native) nativeCovered.add(node);
      if (seen.has(node) || owned(node) || !accessibleRoot(node)) continue;
      seen.add(node);
      nodes.push(node);
      const shadow = openRoot(node);
      if (shadow) { noteShadow(node); enter(shadow); }
      enterAssignments(node);
    }
    // A projected light subtree may live outside the ordinary native CSS
    // query scope. Query its own actual DOM root, then intersect ONLY those
    // projected identities. Never let that broader native query escape scope.
    const projected = new Map();
    for (const node of nodes) {
      if (nativeCovered.has(node)) continue;
      const root = node.getRootNode?.();
      if (!root?.querySelectorAll) continue;
      if (!projected.has(root)) projected.set(root,new Set());
      projected.get(root).add(node);
    }
    const value = { roots, projected, nodes, order: new Map(nodes.map((node, index) => [node, index])) };
    treeCache.set(scope, value);
    return value;
  };
  const elements = (scope) => tree(scope).nodes;
  const ordered = (scope, values) => {
    const unique = [...new Set(values)];
    if (unique.length <= 1) return unique;
    const order = tree(scope).order;
    return unique.sort((a,b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
  };
  const cssCache = new WeakMap();
  const cssMatches = (root, selector) => {
    let cache = cssCache.get(root);
    if (!cache) cssCache.set(root,cache = new Map());
    if (!cache.has(selector)) cache.set(selector,[...(root.querySelectorAll?.(selector) ?? [])]);
    return cache.get(selector);
  };
  const selectCSS = (scope, selector) => {
    const {roots,projected} = tree(scope);
    const matches = roots.flatMap(root => cssMatches(root,selector));
    for (const [root, allowed] of projected)
      for (const node of cssMatches(root,selector))
        if (allowed.has(node)) matches.push(node);
    return ordered(scope,matches).filter(node => !owned(node) && accessibleRoot(node));
  };
  const deepestHit = (root, x, y) => {
    let node = root.elementFromPoint(x,y);
    // Never start a shadow-root hit test independently of the actual outer
    // hit: doing that could see through an overlay covering the whole host.
    while (openRoot(node)) {
      const next = openRoot(node).elementFromPoint?.(x,y);
      if (!next || next === node || !contains(node,next)) break;
      node = next;
    }
    return node;
  };
  const hits = (node,x,y) => {
    const hit = deepestHit(node.ownerDocument,x,y);
    return hit === node || contains(node,hit) || node.contains?.(hit);
  };
  const deepActive = (doc) => {
    let node = doc.activeElement;
    while (openRoot(node)?.activeElement) node = openRoot(node).activeElement;
    return node;
  };
  const frameGeometry = (node) => {
    check(node?.isConnected && accessibleRoot(node), "STALE_REF", "The frame owner was detached.");
    for (let current = node; current; current = composedParent(current)) {
      const transform = getComputedStyle(current).transform;
      if (transform !== "none") {
        const matrix = new DOMMatrixReadOnly(transform);
        check(matrix.is2D && Math.abs(matrix.b) <= 0.000001 && Math.abs(matrix.c) <= 0.000001 && matrix.a > 0 && matrix.d > 0,
          "INVALID_TARGET", "The frame transform is not an axis-aligned positive scale.");
      }
    }
    const r = node.getBoundingClientRect(), style = getComputedStyle(node);
    const scaleX = r.width / node.offsetWidth, scaleY = r.height / node.offsetHeight;
    check([scaleX,scaleY].every(Number.isFinite) && scaleX > 0 && scaleY > 0,
      "INVALID_TARGET", "The frame has no native visible content area.");
    return {x:r.x+(node.clientLeft+parseFloat(style.paddingLeft || "0"))*scaleX,
      y:r.y+(node.clientTop+parseFloat(style.paddingTop || "0"))*scaleY,scaleX,scaleY};
  };
  try {
    // Native frame traversal calls this exact resolver in the parent's
    // isolated world. These commands do not initialize or replace refs.
    if (input.command === "frameOwner") {
      let found;
      try { found = selectCSS(document,input.selector); }
      catch { return "invalid_selector"; }
      if (found.length !== 1) return found.length ? "element_not_unique" : "element_not_found";
      if (!["IFRAME","FRAME"].includes(found[0].tagName)) return "frame_wrong_type";
      return found[0];
    }
    if (input.command === "frameGeometry") return {ok:true,value:frameGeometry(this)};
    if (input.command === "frameHit") return {ok:true,value:!!(this?.isConnected && hits(this,input.x,input.y))};
    if (input.command === "frameFocus") return {ok:true,value:!!(this?.isConnected && deepActive(this.ownerDocument) === this)};
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
    const visible = (node) => {
      if (!(node?.nodeType === 1 || node instanceof Element) || !node.isConnected || !accessibleRoot(node) || !renderedInTree(node)) return false;
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
      if (node.disabled || node.matches?.(":disabled")) return false;
      let aria;
      for (let current = node; current; current = composedParent(current)) {
        if (current.inert) return false;
        const disabled = current.getAttribute?.("aria-disabled")?.toLowerCase();
        if (aria === undefined && ["true","false"].includes(disabled)) aria = disabled === "true";
      }
      return aria !== true;
    };
    const exposureCache = new WeakMap();
    const structuralExposure = (node) => {
      if (!renderedInTree(node)) return false;
      const pending = [];
      let result = true;
      for (let current = node; current; current = composedParent(current)) {
        if (exposureCache.has(current)) { result = exposureCache.get(current); break; }
        pending.push(current);
        if (current.getAttribute?.("aria-hidden")?.toLowerCase() === "true" || current.inert || getComputedStyle(current).display === "none") { result = false; break; }
      }
      // Do not cache ancestor visibility:hidden: descendants may override it.
      for (const current of pending) exposureCache.set(current,result);
      return result;
    };
    const roleExposed = (node) => structuralExposure(node) && !["hidden","collapse"].includes(getComputedStyle(node).visibility);
    const role = (node) => {
      const explicit = node.getAttribute("role")?.trim().split(/\s+/)[0];
      if (explicit) return explicit;
      const tag = node.tagName;
      if (/^H[1-6]$/.test(tag)) return "heading";
      if (tag === "INPUT") {
        if (["checkbox", "radio"].includes(node.type)) return node.type;
        if (["button", "submit", "reset", "image"].includes(node.type)) return "button";
        if (node.type === "range") return "slider";
        if (node.type === "number") return "spinbutton";
        if (node.type === "search") return node.hasAttribute("list") ? "combobox" : "searchbox";
        if (node.type === "hidden") return "generic";
        if (node.hasAttribute("list")) return "combobox";
        // Preserve the existing password/file locator behavior; use the real
        // input type/id when the native AX role is not a public Locator role.
        return "textbox";
      }
      if (tag === "SELECT") return node.multiple || node.size > 1 ? "listbox" : "combobox";
      if (tag === "TH") return node.getAttribute("scope") === "row" || node.getAttribute("scope") === "rowgroup" ? "rowheader" : "columnheader";
      return ({
        BUTTON: "button", A: node.hasAttribute("href") ? "link" : "generic",
        TEXTAREA: "textbox", IMG: "img", MAIN: "main", NAV: "navigation",
        ASIDE: "complementary", ARTICLE: "article", DIALOG: "dialog",
        FORM: "form", FIELDSET: "group", TABLE: "table", TR: "row",
        TD: "cell", THEAD: "rowgroup", TBODY: "rowgroup", TFOOT: "rowgroup",
        UL: "list", OL: "list", LI: "listitem", DL: "list", DT: "term",
        DD: "definition", OPTION: "option", OPTGROUP: "group", PROGRESS: "progressbar",
        METER: "meter", DETAILS: "group", SUMMARY: "button", P: "paragraph",
        HR: "separator", OUTPUT: "status", FIGURE: "figure",
      })[tag] || (node.isContentEditable ? "textbox" : "generic");
    };
    // IDREFs are resolved in the target's own tree, not another root that
    // happens to contain an identically named id. Native labels stay native.
    const normalizeSpace = (value) => (value || "").replace(/\s+/g," ").trim();
    const nameCache = new WeakMap();
    const name = (node) => {
      if (nameCache.has(node)) return nameCache.get(node);
      const scope = node.getRootNode?.() ?? node.ownerDocument ?? document;
      const referencedName = (label) => {
        if (!label || !accessibleRoot(label) || owned(label)) return "";
        // A referenced node can carry its own explicit accessible name,
        // including a self IDREF used with another label. Resolve once, not
        // recursively following a chain of IDREFs (which can contain cycles).
        return normalizeSpace(label.getAttribute?.("aria-label")) ||
          normalizeSpace(label.getAttribute?.("alt")) ||
          normalizeSpace(textValue(label,label === node ? null : node,false,true)) ||
          normalizeSpace(label.getAttribute?.("title"));
      };
      const labelledBy = [...new Set((node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean))]
        .map(id => referencedName(scope.getElementById?.(id))).filter(Boolean).join(" ");
      const labels = Array.from(node.labels || [], label => normalizeSpace(textValue(label,node,false,true))).filter(Boolean).join(" ");
      const value = normalizeSpace(labelledBy || node.getAttribute("aria-label") || labels || node.getAttribute("alt") ||
        (node.tagName === "INPUT" && ["button","submit","reset"].includes(node.type) ? node.value : "") ||
        (hasComposedContent(node) ? textValue(node,null,true,true) : node.innerText?.trim() || node.textContent?.trim()) ||
        node.getAttribute("title") || "");
      nameCache.set(node,value);
      return value;
    };
    const regexCache = new WeakMap();
    const matcher = (value, rule, normalizeText = false) => {
      check(rule && ["text", "regexp"].includes(rule.kind));
      if (rule.kind === "regexp") {
        check(
          typeof rule.source === "string" &&
            encodeSize(rule.source) <= 1024 &&
            typeof rule.flags === "string",
        );
        let regex = regexCache.get(rule);
        if (!regex) { regex = new RegExp(rule.source,rule.flags); regexCache.set(rule,regex); }
        regex.lastIndex = 0;
        return regex.test(value);
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
    const skipText = (node) => ["SCRIPT","STYLE","NOSCRIPT"].includes(node.tagName) || !!node.ownerDocument?.head?.contains(node) || owned(node);
    const childrenForText = (node) => {
      if (node.tagName === "SLOT") {
        const assigned = node.assignedNodes?.({flatten:true});
        if (assigned?.length) return [...assigned];
      }
      return [...(openRoot(node)?.childNodes ?? node.childNodes ?? node.children ?? [])];
    };
    const hasComposedContent = (node) => !!(openRoot(node) || node.getRootNode?.()?.host || node.assignedSlot || hasOpenBelow.has(node));
    // Names use layout-aware word boundaries and accessible descendant
    // labels, unlike raw getByText/hasText regex input. Do not expose internal
    // closed-root text or change the native textContent return contract.
    const textValue = (node, exclude = null, visibleOnly = false, forName = false) => {
      const pending = [node], seen = new Set(), parts = [];
      const space = Symbol("name-boundary");
      while (pending.length) {
        const child = pending.pop();
        if (child === space) { parts.push(" "); continue; }
        if (seen.has(child) || child === exclude) continue;
        seen.add(child);
        if (child.nodeType === 3) {
          const parent = composedParent(child);
          if (accessibleRoot(child) && !owned(child) && (!visibleOnly || !parent || roleExposed(parent))) parts.push(child.nodeValue || "");
          continue;
        }
        if (child.nodeType !== undefined && child.nodeType !== 1) continue;
        if (skipText(child) || !accessibleRoot(child)) continue;
        // visibility is inherited but can be restored by a descendant. Only
        // prune truly absent/inert/aria-hidden branches; a hidden wrapper can
        // contain visible content that contributes to the accessible name.
        if (visibleOnly && !structuralExposure(child)) continue;
        const ownVisible = !visibleOnly || roleExposed(child);
        if (forName && child !== node && ownVisible) {
          const explicit = child.getAttribute?.("aria-label");
          const alt = child.tagName === "IMG" ? child.getAttribute?.("alt") : null;
          if (explicit || alt) { parts.push(" ",explicit || alt," "); continue; }
        }
        if (child.tagName === "INPUT" && ["button","submit","reset"].includes(child.type?.toLowerCase())) { if (ownVisible) parts.push(child.value || ""); continue; }
        if (!child.childNodes && !openRoot(child)) { if (ownVisible) parts.push(child.textContent || ""); continue; }
        const boundary = forName && child !== node && (child.tagName === "BR" ||
          (typeof getComputedStyle === "function" && /^(?:block|flow-root|flex|grid|table|list-item)/.test(getComputedStyle(child).display)));
        if (boundary) { parts.push(" "); pending.push(space); }
        const children = childrenForText(child);
        for (let i = children.length-1; i >= 0; i--) pending.push(children[i]);
      }
      return parts.join("");
    };
    // SLOT is transparent to textual matching. The actual assigned element,
    // or the enclosing control for assigned text nodes, is the useful target.
    const textChildren = (node) => {
      const pending = childrenForText(node).reverse(), result = [];
      while (pending.length) {
        const child = pending.pop();
        if (child.tagName === "SLOT") {
          const assigned = childrenForText(child);
          for (let i=assigned.length-1;i>=0;i--) pending.push(assigned[i]);
        } else if (child.nodeType === 1 || child.tagName) result.push(child);
      }
      return result;
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
        node && node.isConnected && (!node.ownerDocument || node.ownerDocument === root) && accessibleRoot(node) && !owned(node),
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
          result = selectCSS(root, ast.selector);
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
              (n.labels?.length || n.hasAttribute("aria-label") || n.hasAttribute("aria-labelledby")) &&
              renderedInTree(n) && matcher(name(n), ast.matcher),
          );
          break;
        case "placeholder":
          result = elements(root).filter((n) =>
            n.hasAttribute("placeholder") && renderedInTree(n) && matcher(n.getAttribute("placeholder") || "", ast.matcher),
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
              n.tagName !== "SLOT" && renderedInTree(n) && !skipText(n) &&
              matcher(textValue(n), ast.matcher, true) &&
              !textChildren(n).some(
                (c) => renderedInTree(c) && !skipText(c) && matcher(textValue(c), ast.matcher, true),
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
          result = ordered(root,[...sub(ast.left),...sub(ast.right)]);
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
        case "ref": {
          const node = getRef(ast.ref, ast.pageVersion);
          // A fixed reference already validated its original document and
          // current open-root identity; no whole-document scan is needed.
          return root === document || tree(root).order.has(node) ? [node] : [];
          break;
        }
        default:
          failure("INVALID_ARGUMENT", "Unknown locator AST node.");
      }
      return ordered(root,result).filter(node => !owned(node) && accessibleRoot(node));
    };
    let root = document;
    const framePath = input.locator?.framePath || input.framePath || [];
    check(Array.isArray(framePath) && framePath.length <= 8);
    for (const selector of framePath) {
      const frames = selectCSS(root,selector);
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
      if (pending && !(visible(node) && enabled(node)))
        return input.reportPendingReason ? { pendingReason: "element_not_actionable" } : null;
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
      const hit = hits(node,point.x,point.y);
      if (pending && !hit)
        return input.reportPendingReason ? { pendingReason: "element_blocked" } : null;
      check(
        hit,
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
      node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
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
            if (!hits(expected,input.x,input.y)) {
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
        } else if (condition.kind === "text") {
          const body = root.body ?? root.documentElement;
          tree(root);
          matched = !!body && (hasComposedContent(body) ? textValue(body,null,true) : body.innerText ?? body.textContent ?? "").includes(condition.value);
        }
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
            : deepestHit(root,input.x,input.y);
        check(
          node,
          "INVALID_TARGET",
          "There is no current media target at the requested point.",
        );
        const media = n => ["IMG","VIDEO","AUDIO","SOURCE"].includes(n?.tagName);
        let ancestor = node;
        while (ancestor && !media(ancestor)) ancestor = composedParent(ancestor);
        if (ancestor) node = ancestor;
        else {
          const found = selectCSS(node,"img,video,audio");
          check(found.length <= 1,"AMBIGUOUS_TARGET","Select one exact media element.","element_not_unique");
          node = found[0];
        }
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
        value = geometry?.pendingReason
          ? geometry
          : geometry
          ? {
              ...describe(node),
              ...geometry,
              tagName: node.tagName,
              documentToken: state.token,
            }
          : input.reportPendingReason && !node ? { pendingReason: "element_not_found" } : null;
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
      case "focus": {
        const node = unique(true);
        node.focus();
        check(deepActive(node.ownerDocument) === node,"INVALID_TARGET","The target did not receive keyboard focus.","element_not_actionable");
        value = {ref:makeRef(node),documentToken:state.token};
        break;
      }
      case "assertFocus": {
        const node = unique();
        check(state.token === input.expectedDocumentToken && deepActive(node.ownerDocument) === node && enabled(node),
          "STALE_REF","The original keyboard target lost focus or changed.");
        value = true;
        break;
      }
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
        node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
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
        value = input.captureRef ? {checked:node.checked,ref:makeRef(node),documentToken:state.token} : node.checked;
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
        const node = deepestHit(root,input.x,input.y);
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

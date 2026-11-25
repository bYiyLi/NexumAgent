import { BrowserActionError, requireValue, nativeId, publicUrl } from "./errors.js";
import { framePage } from "./frames.js";

const own = (o, k) => Object.hasOwn(o, k);
const normalize = (s) => typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
const primitive = (v) => typeof v === "string" || typeof v === "boolean" || typeof v === "number";
const secret = /(?:pass(?:word|code|wd)?|secret|token|credential|authorization|api[-_]?key|session[-_]?id|csrf|xsrf|otp|one[-_]?time|cvv|cvc|card[-_]?(?:number|security)|cc[-_]?(?:number|csc))/i;
const safeIdentifier = /^[\p{L}\p{N}_:.-]+$/u;
const directAttributes = new Set(["id", "name", "type", "placeholder", "title", "aria-label", "aria-labelledby", "aria-describedby", "aria-controls", "for", "data-testid", "data-test-id", "data-qa", "data-cy", "data-key", "alt", "autocomplete", "scope", "rowspan", "colspan"]);
const structural = new Set(["main", "header", "footer", "nav", "aside", "section", "article", "form", "fieldset", "legend", "label", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "ul", "ol", "li", "dl", "dt", "dd", "details", "summary", "dialog", "select", "optgroup", "option", "input", "textarea", "button", "a", "img", "video", "audio", "canvas", "iframe", "frame", "progress", "meter", "pre", "code", "p", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);
const never = new Set(["head", "script", "style", "noscript", "template", "meta", "link", "base", "title"]);
const stateKeys = ["checked", "selected", "expanded", "disabled", "readonly", "required", "focused", "pressed", "invalid", "busy", "current", "multiselectable", "level", "valuemin", "valuemax", "valuetext"];
const genericRoles = new Set(["generic", "none", "presentation", "StaticText", "InlineTextBox", "RootWebArea"]);
// Only discard recognizably utility-style classes. Unknown classes may be real selectors.
const utility = /^(?:(?:[\w-]+:)*)(?:flex|grid|block|inline(?:-block|-flex|-grid)?|hidden|relative|absolute|fixed|sticky|(?:items|justify|self|content|gap|space-[xy]|p[trblxy]?|m[trblxy]?|w|h|min-w|min-h|max-w|max-h|text|bg|border|rounded|shadow|opacity|font|leading|tracking|overflow|z|inset|top|right|bottom|left)-(?:\d.*|\[.*\]|(?:auto|full|screen|center|start|end|between|stretch|none|sm|md|lg|xl|xs|white|black|transparent|bold|medium|normal|[a-z]+-\d+)))$/;
const sparse = (field) => new Map((field?.index ?? []).map((index, i) => [index, field.value ? field.value[i] : true]));
const urlValue = (v) => {
  if (typeof v !== "string" || !v || /^(?:javascript|data|blob|file):/i.test(v)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//")) {
    const url = new URL(v, "https://example.invalid");
    if (!/^https?:$/.test(url.protocol)) return undefined;
    return v.startsWith("//") ? `//${url.host}${url.pathname}` : publicUrl(v);
  }
  return v.split(/[?#]/, 1)[0] || undefined;
};
const safeUrl = (value) => {
  try { return urlValue(value); } catch { return undefined; }
};
const documentUrl = (value) => {
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'file:', 'about:'].includes(url.protocol)) return publicUrl(value);
    return `${url.protocol}[redacted]`;
  } catch { return ""; }
};
const cssString = (s) => `"${s.replace(/["\\\n\r\f\0]/g, (c) => `\\${c.codePointAt(0).toString(16)} `)}"`;

/** Decode only the fields needed by the observation. Backend DOM ids are used
 * for the native AX join inside this capture; never expose or reuse them. */
export function decodeSemanticDocument(capture, documentIndex, axNodes) {
  const strings = capture?.strings, doc = capture?.documents?.[documentIndex];
  requireValue(Array.isArray(strings) && doc && Array.isArray(doc.nodes?.nodeType) && Array.isArray(doc.layout?.nodeIndex), "PROTOCOL_MISMATCH", "The browser did not return a native DOM snapshot.");
  const str = (index) => typeof strings[index] === "string" ? strings[index] : "";
  const n = doc.nodes, len = n.nodeType.length;
  const children = Array.from({length:len}, () => []);
  const attrs = Array.from({length:len}, (_, i) => {
    const result = Object.create(null), values = n.attributes?.[i] ?? [];
    for (let j = 0; j + 1 < values.length; j += 2) result[str(values[j])] = str(values[j+1]);
    return result;
  });
  const tags = Array.from({length:len}, (_, i) => str(n.nodeName[i]).toLowerCase());
  const roots = [];
  for (let i = 0; i < len; i++) {
    const parent = n.parentIndex[i];
    requireValue(Number.isInteger(parent) && parent >= -1 && parent < i, "PROTOCOL_MISMATCH", "The native DOM snapshot has invalid parent identity.");
    if (parent < 0) roots.push(i); else children[parent].push(i);
  }
  const layout = new Map(doc.layout.nodeIndex.map((index, i) => [index, i]));
  const displayed = (i) => {
    const index = layout.get(i);
    if (index === undefined) return false;
    const style = doc.layout.styles?.[index] ?? [];
    return !["hidden", "collapse"].includes(str(style[0])) && str(style[1]) !== "none";
  };
  const inputValue = sparse(n.inputValue), textValue = sparse(n.textValue), inputChecked = sparse(n.inputChecked), optionSelected = sparse(n.optionSelected), shadow = sparse(n.shadowRootType), documents = sparse(n.contentDocumentIndex), clickable = sparse(n.isClickable);
  const ax = new Map();
  for (const node of axNodes ?? []) {
    if (node.ignored || !Number.isInteger(node.backendDOMNodeId)) continue;
    const previous = ax.get(node.backendDOMNodeId);
    // One native identity may appear more than once. Do not substitute a
    // descendant's accessible name for its owner on an ambiguous join.
    ax.set(node.backendDOMNodeId, previous === undefined && !ax.has(node.backendDOMNodeId) ? node : null);
  }
  const info = (i) => ax.get(n.backendNodeId[i]);
  const blocked = new Uint8Array(len), included = new Uint8Array(len), inShadow = Array(len).fill(""), shadowKinds = new Map(), redacted = new Uint8Array(len);
  const closedNameRisk = new Set();
  // Closed details content may still have a layout entry (content-visibility).
  // Only its first summary is rendered, unless the details element is open.
  const closedDetails = new Map();
  for (let i = 0; i < len; i++) if (tags[i] === "details" && !own(attrs[i],"open")) closedDetails.set(i,children[i].find(j=>tags[j] === "summary"));
  for (let i = 0; i < len; i++) {
    const p = n.parentIndex[i], a = attrs[i], tag = tags[i];
    const shadowKind = shadow.has(i) ? str(shadow.get(i)) : "";
    // Native DOMSnapshot may place shadowRootType on the first descendant
    // rather than return a document-fragment row. Keep the boundary explicit.
    const parentShadow = p >= 0 ? inShadow[p] : "";
    if (shadowKind && (shadowKind !== parentShadow || n.nodeType[i] === 11)) {
      shadowKinds.set(i, shadowKind);
      if (shadowKind === "closed") {
        // Native AX names/values on enclosing elements may include text from
        // a closed descendant. Do not export those derived strings either.
        for (let ancestor=p;ancestor>=0&&!closedNameRisk.has(ancestor);ancestor=n.parentIndex[ancestor]) closedNameRisk.add(ancestor);
      }
    }
    // Never let an open root nested inside a closed/UA root make its
    // descendants observable. Native captures can flatten shadow fragments.
    inShadow[i] = ["closed","user-agent"].includes(parentShadow) ? parentShadow : shadowKind || parentShadow;
    const sensitive = ["input", "textarea", "select"].includes(tag) || own(a,"contenteditable") ?
      a.type === "password" || secret.test([a.id, a.name, a.autocomplete, a["aria-label"], a.placeholder].filter(Boolean).join(" ")) : false;
    redacted[i] = sensitive || (p >= 0 && redacted[p]) ? 1 : 0;
    // A hidden input is not a user-visible control; UA/closed shadow content
    // must not be exported even when CDP is able to read it.
    blocked[i] = (p >= 0 && blocked[p]) || (closedDetails.has(p) && closedDetails.get(p) !== i) || never.has(tag) || tag === "input" && a.type === "hidden" || own(a,"hidden") || own(a,"data-nexum-visual-layer") || own(a,"data-nexum-visual-icon") || ["closed","user-agent"].includes(inShadow[i]) ? 1 : 0;
  }
  // Native layout excludes collapsed options and display:contents wrappers.
  // Retain a select's actual options and relevant ancestor containers, not
  // arbitrary hidden branches. Text nodes belong to the nearest kept owner.
  for (let i = len - 1; i >= 0; i--) {
    if (blocked[i]) {
      if (shadowKinds.get(i) === "closed" && !blocked[n.parentIndex[i]]) included[i] = 1;
      continue;
    }
    const tag = tags[i], a = attrs[i], p = n.parentIndex[i];
    if (n.nodeType[i] === 3 && redacted[i]) continue;
    const frame = tag === "iframe" || tag === "frame";
    const option = tag === "option" || tag === "optgroup";
    let keep = displayed(i) || option || (n.nodeType[i] === 11 && shadowKinds.has(i)) || children[i].some((j) => included[j]);
    if (option) {
      let parent = p;
      while (parent >= 0 && tags[parent] === "optgroup") parent = n.parentIndex[parent];
      keep = parent >= 0 && tags[parent] === "select" && displayed(parent) && !blocked[parent];
    }
    if (frame && !displayed(i)) keep = false;
    if (n.nodeType[i] === 3) keep = displayed(i) && normalize(str(n.nodeValue[i])) !== "";
    included[i] = keep ? 1 : 0;
  }
  const classes = (a) => (a.class ?? "").split(/\s+/).filter((c) => c && !utility.test(c) && !secret.test(c)).join(" ");
  const documentSelectors = new Map();
  for (let i = 0; i < len; i++) {
    if (n.nodeType[i] !== 1 || ["closed","user-agent"].includes(inShadow[i])) continue;
    for (const key of ["id","name","data-testid"]) {
      const val = attrs[i][key];
      if (!val) continue;
      const token = key === "id" ? `${key}:${val}` : `${tags[i]}:${key}:${val}`;
      documentSelectors.set(token, (documentSelectors.get(token) ?? 0) + 1);
    }
  }
  const selectorFor = (i) => {
    if (["closed","user-agent"].includes(inShadow[i])) return undefined;
    const tag = tags[i], a = attrs[i];
    for (const key of ["id","name","data-testid"]) {
      if (a[key] && documentSelectors.get(key === "id" ? `${key}:${a[key]}` : `${tag}:${key}:${a[key]}`) === 1)
        return `${tag}[${key}=${cssString(a[key])}]`;
    }
    // Exact observed DOM path, not an identity. A later locator must re-check
    // both the frame and its business target after any page change.
    const parts = [];
    for (let j = i; j >= 0 && n.nodeType[j] === 1; j = n.parentIndex[j]) {
      const p = n.parentIndex[j], t = tags[j];
      if (!/^[a-z][a-z0-9-]*$/.test(t)) return undefined;
      const same = p < 0 ? [j] : children[p].filter((k) => n.nodeType[k] === 1 && tags[k] === t);
      parts.unshift(`${t}${same.length > 1 ? `:nth-of-type(${same.indexOf(j)+1})` : ""}`);
      if (shadowKinds.has(j)) break;
    }
    return parts.join(" > ") || undefined;
  };
  const rows = [], frames = [], warnings = new Set(), emittedShadow = new Set();
  const pending = roots.slice().reverse().map(i => ({i,depth:0}));
  while (pending.length) {
    const {i,depth} = pending.pop();
    if (!included[i]) continue;
    const tag = tags[i], a = attrs[i], axNode = info(i), type = n.nodeType[i];
    let d = depth;
    const kind = shadowKinds.get(i);
    if (kind && kind !== "user-agent") {
      const key = `${n.parentIndex[i]}:${kind}`;
      if (!emittedShadow.has(key)) {
        emittedShadow.add(key);
        rows.push({depth:d,tag:"#shadow-root",attributes:{mode:kind},...(kind === "closed" ? {locatorSupported:false} : {})});
      }
      d++;
      if (kind === "closed") warnings.add("shadow_content_unavailable");
      if (kind !== "open") continue;
    }
    if (blocked[i]) continue;
    if (type === 3) {
      if (!redacted[i]) rows.push({depth:d,tag:"#text",text:normalize(str(n.nodeValue[i]))});
      continue;
    }
    const role = axNode?.role?.value;
    const realRole = typeof role === "string" && !genericRoles.has(role) ? role : undefined;
    const attributes = Object.create(null), redactedUrls = [];
    for (const [key,value] of Object.entries(a)) {
      if (key === "href" || key === "src") {
        const url = safeUrl(value);
        if (url) attributes[key] = url;
        if (value && url !== value) redactedUrls.push(key);
      } else if (directAttributes.has(key) && value !== "" && (key !== "autocomplete" || !redacted[i])) attributes[key] = value;
      else if (/^data-[a-z][a-z0-9-]*-id$/.test(key) && !secret.test(key) && safeIdentifier.test(value)) attributes[key] = value;
    }
    const cls = classes(a); if (cls) attributes.class = cls;
    const states = Object.create(null);
    for (const key of redactedUrls) states[`${key}Redacted`] = true;
    if (!realRole && a.role) attributes.role = a.role;
    if (a["aria-hidden"] === "true") states.ariaHidden = true;
    if (own(a,"inert")) states.inert = true;
    const props = new Map((axNode?.properties ?? []).map(x => [x.name,x.value?.value]));
    for (const key of stateKeys) if (props.has(key) && primitive(props.get(key))) states[key] = props.get(key);
    for (const [attr,key] of [["aria-current","current"],["aria-expanded","expanded"],["aria-pressed","pressed"],["aria-checked","checked"],["aria-selected","selected"],["aria-disabled","disabled"],["aria-invalid","invalid"],["aria-busy","busy"],["aria-readonly","readonly"],["aria-required","required"]]) {
      if (!own(states,key) && own(a,attr)) states[key] = a[attr] === "true" ? true : a[attr] === "false" ? false : a[attr];
    }
    for (const key of ["disabled","readonly","required","multiple","open"]) if (own(a,key) && !own(states,key)) states[key] = true;
    if (["", "true", "false", "plaintext-only"].includes(a.contenteditable)) states.contenteditable = a.contenteditable !== "false";
    if (tag === "dialog" && own(a,"open")) states.open = true;
    if (tag === "input" && ["checkbox","radio"].includes(a.type)) states.checked = inputChecked.has(i);
    if (tag === "option") states.selected = optionSelected.has(i);
    if (clickable.has(i) && !realRole && !structural.has(tag)) states.clickable = true;
    if (closedNameRisk.has(i)) delete states.valuetext;
    if (redacted[i]) { states.valueRedacted = true; delete states.valuetext; }
    else if (tag === "input" || tag === "textarea" || tag === "select" || tag === "option") {
      let value;
      if (tag === "option") value = own(a,"value") ? a.value : normalize(children[i].filter(j => n.nodeType[j] === 3).map(j => str(n.nodeValue[j])).join(""));
      else if (inputValue.has(i)) value = str(inputValue.get(i));
      else if (textValue.has(i)) value = str(textValue.get(i));
      else if (tag === "select") {
        const selected = [], scan = children[i].slice();
        while(scan.length) { const j = scan.shift(); if (tags[j] === "option" && optionSelected.has(j)) selected.push(own(attrs[j],"value") ? attrs[j].value : normalize(children[j].filter(k => n.nodeType[k] === 3).map(k => str(n.nodeValue[k])).join(""))); else if (tags[j] === "optgroup") scan.unshift(...children[j]); }
        // HTMLSelectElement.value is the first selected option even for
        // multiple selects; every actual selected option is retained below.
        value = selected[0] ?? "";
      } else if (tag === "input" && ["checkbox","radio","button","submit","reset"].includes(a.type)) value = a.value ?? (["checkbox","radio"].includes(a.type) ? "on" : "");
      // Do not infer a live text input from its initial HTML value.
      if (value !== undefined) states.value = value;
    } else if (primitive(axNode?.value?.value) && !redacted[i] && !closedNameRisk.has(i)) states.value = axNode.value.value;
    const frame = tag === "iframe" || tag === "frame";
    const directText = redacted[i] ? "" : normalize(children[i].filter(j => n.nodeType[j] === 3 && included[j]).map(j => str(n.nodeValue[j])).join(" "));
    const accessibleName = redacted[i] || closedNameRisk.has(i) ? undefined : normalize(axNode?.name?.value) || undefined;
    const semantic = type === 1 && tag !== "html" && tag !== "body" && (structural.has(tag) || realRole || Object.keys(attributes).some(k => !["title","alt","aria-label"].includes(k)) || Object.keys(states).length || directText || tag.includes("-"));
    if (semantic) {
      const row = {depth:d++,tag,...(realRole ? {role:realRole}:{}),...(accessibleName ? {name:accessibleName}:{}),...(directText && directText !== accessibleName ? {text:directText}:{}),...(Object.keys(attributes).length ? {attributes}:{}),...(Object.keys(states).length ? {states}:{})};
      if (frame) {
        const frameSelector = selectorFor(i);
        if (frameSelector) row.frameSelector = frameSelector;
        frames.push({row, documentIndex:documents.get(i), frameSelector, backendNodeId:n.backendNodeId[i]});
      }
      rows.push(row);
    }
    for (let j = children[i].length-1; j >= 0; j--) {
      const child = children[i][j];
      // Direct visible text is already carried by the nearest retained owner.
      if (semantic && n.nodeType[child] === 3) continue;
      pending.push({i:child,depth:d});
    }
  }
  return {rows,frames,warnings:[...warnings],url:documentUrl(str(doc.documentURL)),title:str(doc.title),frameId:str(doc.frameId)};
}

const captureOptions = {computedStyles:["visibility","display"],includePaintOrder:false,includeDOMRects:false};
const expectedFrameFailure = (cause) => cause instanceof BrowserActionError && ["INVALID_TARGET","AMBIGUOUS_TARGET","STALE_REF","PERMISSION_DENIED","UNSUPPORTED"].includes(cause.code);

/** A read-only observation scoped by the same Browser lease and frame router
 * as Locator. No HTML export, page writes, scrolling or synthetic clicks. */
export async function observeSemantic(ctx, screenshot = false) {
  const router = ctx.router, target = router.target(ctx.target.tabId,ctx.lease);
  const verify = () => {
    ctx.signal?.throwIfAborted();
    const current = router.target(ctx.target.tabId,ctx.lease);
    requireValue(current.pageVersion === target.pageVersion && current.controlEpoch === target.controlEpoch, "STALE_REF", "The document or control identity changed during observation.");
  };
  const tab = await ctx.chrome.tabs.get(nativeId(ctx.target.tabId));
  const dialog = router.dialog(ctx);
  if (dialog) {
    requireValue(!screenshot, "INVALID_TARGET", "A native dialog blocks the combined observation; read the dialog and use the screenshot separately.", "dialog_already_open");
    verify();
    return {target,title:tab.title ?? "",url:documentUrl(tab.url ?? ""),readyState:"unknown",coverage:"partial",warnings:["native_dialog_open"],nodes:[],dialog:{type:dialog.type,message:dialog.message}};
  }
  const readyState = await router.page(ctx,{command:"readyState"});
  const capture = await router.send(ctx,"DOMSnapshot.captureSnapshot",captureOptions);
  requireValue(Array.isArray(capture?.documents) && capture.documents.length > 0,"PROTOCOL_MISMATCH","The browser did not return a document snapshot.");
  const warnings = new Set(), activeFrames = new Set();
  const read = async (data,index,send,path) => {
    verify();
    const doc = data.documents[index], frameId = data.strings[doc.frameId];
    requireValue(typeof frameId === "string" && !activeFrames.has(frameId),"PROTOCOL_MISMATCH","The native document frame identity is missing or recursive.");
    activeFrames.add(frameId);
    try {
    await send("Accessibility.enable",{});
    const ax = await send("Accessibility.getFullAXTree",{frameId});
    requireValue(Array.isArray(ax?.nodes),"PROTOCOL_MISMATCH","The browser did not return native accessibility nodes.");
    const decoded = decodeSemanticDocument(data,index,ax.nodes);
    for (const w of decoded.warnings) warnings.add(w);
    const byRow = new Map(decoded.frames.map(f=>[f.row,f]));
    const rows = [];
    for (const row of decoded.rows) {
      rows.push(row);
      const frame = byRow.get(row);
      if (!frame) continue;
      const marker = {depth:row.depth+1,tag:"#document"};
      if (!frame.frameSelector || path.length >= 8) {
        marker.states={accessible:false,reason:"frame_locator_unavailable"}; warnings.add("frame_locator_unavailable"); rows.push(marker); continue;
      }
      try {
        let nested;
        // Resolve the observed frame owner again via the existing native frame
        // adapter, even when a same-renderer document was included in capture.
        nested = await framePage(ctx,{command:"readyState"},[...path,frame.frameSelector],async ({native,frameId:currentFrame,ownerBackendNodeId})=>{
          requireValue(ownerBackendNodeId === frame.backendNodeId, "STALE_REF", "The original frame owner changed during observation.");
          let nextData = data, nextIndex = frame.documentIndex;
          if (nextIndex !== undefined)
            requireValue(data.strings[data.documents[nextIndex]?.frameId] === currentFrame, "STALE_REF", "The original frame document changed during observation.");
          if (nextIndex === undefined) {
            nextData = await native("DOMSnapshot.captureSnapshot",captureOptions);
            nextIndex = nextData.documents.findIndex(d=>nextData.strings[d.frameId] === currentFrame);
          }
          requireValue(nextIndex >= 0 && nextData.documents[nextIndex],"STALE_REF","The observed frame document is no longer available.");
          return read(nextData,nextIndex,native,[...path,frame.frameSelector]);
        });
        marker.attributes={url:nested.url}; rows.push(marker);
        for (const child of nested.rows) rows.push({...child,depth:child.depth+row.depth+2});
      } catch (cause) {
        if (!expectedFrameFailure(cause)) throw cause;
        verify(); marker.states={accessible:false,reason:cause.code}; warnings.add("frame_unavailable"); rows.push(marker);
      }
    }
    return {...decoded,rows};
    } finally { activeFrames.delete(frameId); }
  };
  const observed = await read(capture,0,(method,params)=>router.send(ctx,method,params),[]);
  verify();
  const after = await ctx.chrome.tabs.get(nativeId(ctx.target.tabId));
  requireValue(after.url === tab.url && observed.url === documentUrl(after.url ?? ""),"STALE_REF","The page address changed during observation.");
  const image = screenshot ? await router.screenshot(ctx,{}) : undefined;
  verify();
  const finalTab = screenshot ? await ctx.chrome.tabs.get(nativeId(ctx.target.tabId)) : after;
  verify();
  requireValue(finalTab.url === after.url,"STALE_REF","The page address changed during observation.");
  return {target,title:observed.title,url:observed.url,readyState:["loading","interactive","complete"].includes(readyState)?readyState:"unknown",coverage:warnings.size?"partial":"complete",warnings:[...warnings],nodes:observed.rows,...(image === undefined?{}:{screenshot:image})};
}

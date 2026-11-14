/** Serialized by Runtime.callFunctionOn with its receiver bound to a native resolved DOM node. */
export function nativeNodeCommand(input) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  check(this?.isConnected, "The observed node is no longer connected.");
  if (input.command === "setValue") {
    check(
      typeof input.value === "string" && !this.readOnly && !this.disabled,
      "The target is not editable.",
    );
    if (this.isContentEditable) this.textContent = input.value;
    else {
      const view = this.ownerDocument.defaultView;
      const prototype =
        this.tagName === "INPUT"
          ? view.HTMLInputElement.prototype
          : this.tagName === "TEXTAREA"
            ? view.HTMLTextAreaElement.prototype
            : null;
      check(prototype, "The target is not a text input.");
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        this,
        input.value,
      );
    }
    const EventClass = this.ownerDocument.defaultView.Event;
    this.dispatchEvent(new EventClass("input", { bubbles: true }));
    this.dispatchEvent(new EventClass("change", { bubbles: true }));
    return true;
  }
  if (input.command === "selectText") {
    const content =
      typeof this.value === "string" ? this.value : (this.textContent ?? "");
    const matches = [];
    let at = 0;
    while (at <= content.length) {
      const found = content.indexOf(input.text, at);
      if (found < 0) break;
      if (
        (!input.prefix || content.slice(0, found).endsWith(input.prefix)) &&
        (!input.suffix ||
          content.slice(found + input.text.length).startsWith(input.suffix))
      )
        matches.push(found);
      at = found + Math.max(1, input.text.length);
      check(matches.length <= 1, "The requested text is ambiguous.");
    }
    check(matches.length === 1, "The requested text was not found.");
    let start = matches[0],
      end = start + input.text.length;
    if (input.selectionType === "cursor_before") end = start;
    if (input.selectionType === "cursor_after") start = end;
    this.focus();
    if (typeof this.setSelectionRange === "function")
      this.setSelectionRange(start, end);
    else {
      const doc = this.ownerDocument,
        walk = doc.createTreeWalker(this, 4),
        range = doc.createRange();
      let offset = 0,
        node,
        begin,
        finish;
      while ((node = walk.nextNode())) {
        const length = node.textContent.length;
        if (!begin && start <= offset + length)
          begin = { node, offset: start - offset };
        if (end <= offset + length) {
          finish = { node, offset: end - offset };
          break;
        }
        offset += length;
      }
      check(begin && finish, "The requested text selection is unavailable.");
      range.setStart(begin.node, begin.offset);
      range.setEnd(finish.node, finish.offset);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }
  throw new Error("Unknown native node operation.");
}

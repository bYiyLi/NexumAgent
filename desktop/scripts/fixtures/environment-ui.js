(async function runEnvironmentAcceptance(fixture) {
  const steps = [];
  let step = "startup";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  async function until(check, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(75);
    }
    throw new Error("Timeout: " + label);
  }
  const query = selector => document.querySelector(selector);
  const page = name => until(() => query('.desktop-shell[data-page="' + name + '"]'), name);
  const button = label => Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === label && !el.disabled);
  const click = async label => (await until(() => button(label), label)).click();
  async function openMenu() {
    const trigger = await until(() => query(".agent-trigger"), "environment menu");
    if (!query(".agent-menu")) trigger.click();
    await sleep(200);
    if (!query(".agent-menu")) {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }
    await until(() => query(".agent-menu"), "menu popup");
  }
  function input(name, value) {
    const element = query('input[name="' + name + '"]');
    assert(element, "Missing input " + name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  async function submit(value, remember) {
    input("password", value);
    if (remember) query(".remote-remember input").click();
    await until(() => query('.remote-page button[type="submit"]:not(:disabled)'), "enabled connect");
    query('.remote-page button[type="submit"]').click();
  }
  async function verification() {
    await until(() => query('[data-ssh-stage="verify"]'), "host verification");
    assert(query(".ssh-fingerprint-card code").textContent === fixture.fingerprint, "Wrong host fingerprint");
    assert(!query(".ssh-preview-toolbar"), "Preview controls visible in real flow");
  }
  async function report(ok, issue) {
    await fetch(location.origin + "/wails/runtime", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wails-client-id": "environment-acceptance" },
      body: JSON.stringify({ object: 3, method: 0,
        args: { name: "desktop:acceptance:environment", data: { ok, step, steps, issue } } }),
    });
  }
  try {
    await page("workspace");
    await openMenu();
    (await until(() => query(".agent-menu-add"), "real add environment")).click();
    await page("remote-setup");
    step = "cancel before authentication";
    assert(!query(".remote-preview-label"), "Preview form reached");
    input("host", "127.0.0.1");
    input("port", String(fixture.port));
    input("user", "fixture");
    await submit(fixture.secret, false);
    await verification();
    await click("Cancel");
    await page("remote-setup");
    assert(query('input[name="password"]').value === "", "Cancelled form retained secret");
    assert(query('input[name="host"]').value === "127.0.0.1", "Cancelled form lost endpoint");
    steps.push(step);

    step = "authentication rejection";
    await submit("invalid-fixture-value", false);
    await verification();
    await click("Trust and connect");
    await until(() => query('[data-ssh-stage="authFailed"]'), "auth failure");
    await click("Edit connection settings");
    await page("remote-setup");
    steps.push(step);

    step = "verified connection and save";
    await submit(fixture.secret, true);
    await verification();
    await click("Trust and connect");
    await page("workspace");
    await until(() => query(".workspace-target-name")?.textContent === fixture.hostname, "remote target selected");
    assert(query(".workspace-target").textContent.includes("SSH connected"), "Missing actual SSH connection state");
    assert(query(".workspace-target").textContent.includes("Agent not connected"), "SSH conflated with Agent");
    steps.push(step);

    step = "disconnect";
    await click("Disconnect SSH");
    await until(() => button("Reconnect"), "disconnected state");
    steps.push(step);

    step = "reconnect using native store";
    await click("Reconnect");
    await page("workspace");
    await until(() => button("Disconnect SSH"), "reconnected state");
    steps.push(step);

    step = "switch local and remote";
    await openMenu();
    (await until(() => query('.agent-menu-item[title="Local"]'), "local target")).click();
    await until(() => query(".workspace-target-name")?.textContent === "Local", "local selected");
    await openMenu();
    (await until(() => Array.from(document.querySelectorAll(".agent-menu-item")).find(el => el.title === fixture.hostname), "remote target")).click();
    await until(() => query(".workspace-target-name")?.textContent === fixture.hostname, "remote selected again");
    steps.push(step);

    step = "remove environment";
    await click("Remove environment");
    await click("Confirm removal");
    await until(() => query(".workspace-target-name")?.textContent === "Local", "removed target returns local");
    await openMenu();
    assert(!Array.from(document.querySelectorAll(".agent-menu-item")).some(el => el.title === fixture.hostname), "Removed target still in menu");
    steps.push(step);
    await report(true, "");
  } catch (error) {
    await report(false, error instanceof Error ? error.message.slice(0, 180) : "Unknown test error");
  }
})
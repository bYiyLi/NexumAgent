import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { nativeFixture, select } from "./helpers/native.mjs";
test(
  "actual native debugger Cancel ends the current control lease and original waiter",
  { timeout: 150000 },
  async (t) => {
    assert.equal(process.env.NEXUM_BROWSER_NATIVE_HEADFUL, "1");
    const title = "Nexum native user stop " + randomUUID().slice(0, 8);
    const f = await nativeFixture(t, {
      html: `<!doctype html><title>${title}</title><h1>${title}</h1><label for="name">Name</label><input id="name"><button>Safe native stop target</button>`,
    });
    let view = await f.start(
      select +
        `await tab.playwright.getByRole('textbox',{name:'Name'}).fill('Before native cancel');const pending=tab.playwright.waitForDownload({timeoutMs:110000});let waitError;try{await pending;}catch(error){waitError={code:error.code,message:error.message};}let writeError;try{await tab.playwright.getByRole('textbox',{name:'Name'}).fill('Must not happen after native cancel');}catch(error){writeError={code:error.code,message:error.message};}return {waitError:waitError??null,writeError:writeError??null};`,
      { base: f.base },
      { timeoutMs: 120000 },
    );
    const until = performance.now() + 120000;
    while (
      !view.operations?.items?.some(
        (o) => o.method === "waiters.get" && o.status === "running",
      )
    ) {
      assert.equal(view.run.endedAt, null, JSON.stringify(view.run));
      assert.ok(performance.now() < until);
      view = await f.observe(view.run.runId);
      await delay(10);
    }
    const ready = {
      readyForNativeCancel: true,
      title,
      url: f.base,
      runId: view.run.runId,
    };
    if (process.env.NEXUM_NATIVE_STOP_READY_FILE)
      writeFileSync(
        process.env.NEXUM_NATIVE_STOP_READY_FILE,
        JSON.stringify(ready),
      );
    console.log(JSON.stringify(ready));
    while (view.run.endedAt === null) {
      assert.ok(
        performance.now() < until,
        "The native Cancel action was not observed before the test deadline.",
      );
      view = await f.observe(view.run.runId);
      await delay(10);
    }
    assert.equal(view.run.status, "succeeded", JSON.stringify(view.run));
    assert.equal(view.result.data.waitError?.code, "USER_TAKEOVER");
    assert.equal(view.result.data.writeError?.code, "USER_TAKEOVER");
    t.diagnostic(
      JSON.stringify({
        nativeStopObserved: true,
        waitError: view.result.data.waitError.code,
        writeError: view.result.data.writeError.code,
        originalRunId: view.run.runId,
      }),
    );
    const after = await f.run(
      select +
        `return {value:await tab.playwright.getByRole('textbox',{name:'Name'}).evaluate('element=>element.value')};`,
      { base: f.base },
    );
    assert.equal(after.result.data.value, "Before native cancel");
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { nativeFixture, select } from "./helpers/native.mjs";

test(
  "native concurrent runs retain both browser lease closure receipts",
  { timeout: 150000 },
  async (t) => {
    const barriers = [];
    let released = false;
    const release = () => {
      released = true;
      for (const response of barriers.splice(0)) response.writeHead(200).end();
    };
    const f = await nativeFixture(t, {
      html: "<!doctype html><title>Lease receipt fixture</title><h1>Independent tabs</h1>",
      handleRequest(request, response) {
        if (request.url !== "/receipt-barrier") return false;
        if (released) response.writeHead(200).end();
        else barriers.push(response);
        return true;
      },
    });
    const setup = await f.run(
      select +
        'const other=await selected.tabs.new(context.input.base+"?receipt-second",{active:false});await other.playwright.waitForURL(context.input.base+"?receipt-second");return {first:tab.id,second:other.id};',
      { base: f.base },
    );
    const script = `try { const {createBrowserClient}=await import('@nexum/browser');
    const selected=await createBrowserClient(browser).browsers.get(context.input.fixtureBrowserId);
    const tab=await selected.tabs.get(context.input.tabId);
    await tab.playwright.evaluate('() => { window.receiptProbe = true; return true; }');
    await fetch(context.input.base+'receipt-barrier');
    return {done:true}; } catch(error) {return {nativeFailure:{code:error.code??'native_error',message:String(error.message)}};}`;
    try {
      const started = await Promise.all(
        [setup.result.data.first, setup.result.data.second].map((tabId) =>
          f.start(script, { tabId, base: f.base }),
        ),
      );
      assert.notEqual(started[0].run.runId, started[1].run.runId);
      const deadline = Date.now() + 30000;
      while (barriers.length < 2) {
        assert.ok(Date.now() < deadline, "Both runs must reach their barrier");
        for (const initial of started) {
          const state = await f.observe(initial.run.runId, 10);
          assert.equal(
            state.run.endedAt,
            null,
            JSON.stringify({ run: state.run, result: state.result }),
          );
        }
        await delay(10);
      }
      const before = await f.cleanupFacts();
      assert.equal(
        typeof before.closedReceipts,
        "number",
        JSON.stringify(before),
      );
      release();
      const finishDeadline = Date.now() + 30000;
      const finish = async (state) => {
        while (state.run.endedAt === null) {
          assert.ok(
            Date.now() < finishDeadline,
            "Both runs must finish actual cleanup",
          );
          state = await f.observe(state.run.runId);
          if (state.run.endedAt === null) await delay(10);
        }
        assert.equal(state.run.status, "succeeded", JSON.stringify(state.run));
        assert.deepEqual(state.run.cleanup.unconfirmed, []);
        assert.deepEqual(state.result.data, { done: true });
      };
      await Promise.all(started.map(finish));
      const after = await f.cleanupFacts();
      assert.deepEqual(after.owned, [], JSON.stringify(after));
      assert.ok(
        after.closedReceipts >= before.closedReceipts + 2,
        JSON.stringify({ before, after }),
      );
      t.diagnostic(
        JSON.stringify({
          before: before.closedReceipts,
          after: after.closedReceipts,
        }),
      );
    } finally {
      release();
    }
  },
);

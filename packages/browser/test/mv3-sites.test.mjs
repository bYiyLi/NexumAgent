import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createBrowserRouter } from "../browser-extension/router.js";

function officeZip(names) {
  const central = [],
    local = [];
  let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name),
      content = Buffer.from("<actual-native-document/>"),
      header = Buffer.alloc(30 + bytes.length),
      record = Buffer.alloc(46 + bytes.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(bytes.length, 26);
    bytes.copy(header, 30);
    local.push(header, content);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt32LE(content.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(bytes.length, 28);
    record.writeUInt32LE(offset, 42);
    bytes.copy(record, 46);
    central.push(record);
    offset += header.length + content.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixture(t, url) {
  const location = { href: url },
    responses = new Map(),
    fetches = [],
    nativeCalls = [],
    segments = [];
  const document = {
    title: "Actual document",
    baseURI: url,
    querySelectorAll(selector) {
      return selector === "ytd-transcript-segment-renderer"
        ? segments
        : [image];
    },
    querySelector() {
      return null;
    },
  };
  class Element {
    tagName = "IMG";
    isConnected = true;
    children = [];
    ownerDocument = document;
    src = "https://media.example/picture.png";
    getAttribute(name) {
      return name === "src" ? this.src : null;
    }
    hasAttribute() {
      return false;
    }
    closest(selector) {
      return selector === "img,video,audio,source" ? this : null;
    }
  }
  const image = new Element();
  const globals = {
    document,
    location,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Blob,
    AbortController,
    crypto,
    Element,
  };
  const main = vm.createContext({ ...globals }),
    isolated = vm.createContext({
      ...globals,
      async fetch(url, options) {
        fetches.push({ url, options });
        const response = responses.get(url);
        if (!response) throw Error("actual source unavailable");
        return new Response(response.data, {
          headers: { "content-type": response.mimeType },
        });
      },
    });
  const chrome = {
    tabs: {
      async get() {
        return { id: 1, url: location.href, title: document.title };
      },
      async query() {
        return [{ id: 1 }];
      },
    },
    scripting: {
      async executeScript(input) {
        nativeCalls.push(input);
        const realm = input.world === "MAIN" ? main : isolated;
        const value = await vm.runInContext(
          `(${input.func.toString()})`,
          realm,
        )(...input.args);
        return [{ result: JSON.parse(JSON.stringify(value)) }];
      },
    },
  };
  const router = createBrowserRouter(chrome);
  router.start();
  const binding = {
    bootId: "boot",
    browserId: "browser",
    browserSessionId: "session",
    generation: 1,
    connectionId: "connection",
  };
  router.bind(binding);
  const target = { ...binding, tabId: "1" };
  router.openLease({
    ...binding,
    target,
    leaseId: "lease",
    runId: "run",
    operationId: "open",
  });
  t.after(() => router.dispose());
  const call = (method, args = {}) =>
    router.dispatch({
      ...binding,
      target,
      leaseId: "lease",
      runId: "run",
      actionId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      method,
      args: { target, ...args },
      budgetMs: 1000,
    });
  return {
    call,
    main,
    document,
    image,
    location,
    segments,
    responses,
    fetches,
    nativeCalls,
    target,
  };
}

test("Google Workspace plans are network-free and format/source-bound; only actual export bytes become a document", async (t) => {
  const f = fixture(
    t,
    "https://docs.google.com/spreadsheets/d/actual_document/edit#gid=42",
  );
  const plan = await f.call("content.plan", {
    method: "content.exportGsuite",
    type: "csv",
  });
  assert.deepEqual(plan.urls, [
    "https://docs.google.com/spreadsheets/d/actual_document/export?format=csv&gid=42",
  ]);
  assert.equal(f.fetches.length, 0);
  f.responses.set(plan.urls[0], {
    data: "one,two\n1,2\n",
    mimeType: "text/csv",
  });
  const file = await f.call("content.exportGsuite", {
    type: "csv",
    planId: plan.id,
  });
  assert.equal(new TextDecoder().decode(file.data), "one,two\n1,2\n");
  assert.equal(file.mimeType, "text/csv");
  assert.ok(file.name.endsWith(".csv"));
  assert.equal(f.fetches[0].options.credentials, "include");
  assert.equal(f.fetches[0].options.redirect, "error");
  await assert.rejects(
    f.call("content.plan", { method: "content.exportGsuite", type: "docx" }),
    { code: "FILE_UNAVAILABLE" },
  );
  const pdf = await f.call("content.plan", {
    method: "content.exportGsuite",
    type: "pdf",
  });
  f.responses.set(pdf.urls[0], {
    data: "<html>Please sign in</html>",
    mimeType: "text/html",
  });
  await assert.rejects(
    f.call("content.exportGsuite", { type: "pdf", planId: pdf.id }),
    { code: "FILE_UNAVAILABLE" },
  );
  f.location.href =
    "https://docs.google.com/spreadsheets/d/a_different_document/edit";
  await assert.rejects(
    f.call("content.exportGsuite", { type: "csv", planId: plan.id }),
    { code: "STALE_REF" },
  );
  f.location.href = "https://docs.google.com/document/d/actual_document/edit";
  const word = await f.call("content.plan", {
    method: "content.exportGsuite",
    type: "docx",
  });
  f.responses.set(word.urls[0], {
    data: new Uint8Array([80, 75, 3, 4, 0]),
    mimeType: "application/zip",
  });
  await assert.rejects(
    f.call("content.exportGsuite", { type: "docx", planId: word.id }),
    { code: "FILE_UNAVAILABLE" },
  );
  f.responses.set(word.urls[0], {
    data: officeZip(["[Content_Types].xml", "word/document.xml"]),
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.equal(
    (
      await f.call("content.exportGsuite", { type: "docx", planId: word.id })
    ).name.endsWith(".docx"),
    true,
  );
});

test("YouTube exports an actually rendered transcript or the fixed observed track, never invented captions or another video's response", async (t) => {
  const f = fixture(t, "https://www.youtube.com/watch?v=actualVideo1");
  f.segments.push({
    querySelector(selector) {
      return {
        textContent:
          selector === ".segment-timestamp" ? "0:03" : "Actual rendered words",
      };
    },
  });
  const rendered = await f.call("content.plan", {
    method: "content.exportYouTubeTranscript",
  });
  assert.deepEqual(rendered.urls, []);
  assert.equal(f.fetches.length, 0);
  const text = await f.call("content.exportYouTubeTranscript", {
    planId: rendered.id,
  });
  assert.equal(text.text, "[0:03] Actual rendered words");
  f.segments.length = 0;
  f.main.ytInitialPlayerResponse = {
    videoDetails: { videoId: "actualVideo1", title: "Native captions" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl:
              "https://www.youtube.com/api/timedtext?v=actualVideo1&fmt=json3",
          },
        ],
      },
    },
  };
  const planned = await f.call("content.plan", {
    method: "content.exportYouTubeTranscript",
  });
  assert.equal(f.fetches.length, 0);
  f.responses.set(planned.urls[0], {
    data: JSON.stringify({
      events: [
        { segs: [{ utf8: "First " }, { utf8: "actual cue" }] },
        { segs: [{ utf8: "Second cue" }] },
      ],
    }),
    mimeType: "application/json",
  });
  const file = await f.call("content.exportYouTubeTranscript", {
    planId: planned.id,
  });
  assert.equal(
    new TextDecoder().decode(file.data),
    "First actual cue\nSecond cue",
  );
  assert.equal(file.sourceUrl, planned.urls[0]);
  f.main.ytInitialPlayerResponse.videoDetails.videoId = "previousVideo";
  await assert.rejects(
    f.call("content.plan", { method: "content.exportYouTubeTranscript" }),
    { code: "FILE_UNAVAILABLE" },
  );
});

test("coordinate, fixed-node and Locator media use their actual native source and cannot rebind after preflight", async (t) => {
  const f = fixture(t, "https://page.example/"),
    data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 3, 4]);
  f.document.elementFromPoint = () => f.image;
  f.responses.set(f.image.src, { data, mimeType: "image/png" });
  const locator = {
    target: f.target,
    framePath: [],
    query: { kind: "selector", selector: "img" },
  };
  const ref = (await f.call("locator.all", { locator }))[0].query.ref;
  for (const [method, args] of [
    ["cua.downloadMedia", { options: { x: 10, y: 20 } }],
    ["dom.downloadMedia", { options: { node_id: ref } }],
    ["locator.downloadMedia", { locator }],
  ]) {
    const before = f.fetches.length,
      plan = await f.call("content.plan", { method, ...args });
    assert.equal(f.fetches.length, before);
    assert.deepEqual(plan.urls, [f.image.src]);
    const file = await f.call(method, { ...args, planId: plan.id });
    assert.deepEqual(file.data, data);
    assert.equal(file.mimeType, "image/png");
  }
  const plan = await f.call("content.plan", {
    method: "locator.downloadMedia",
    locator,
  });
  f.image.src = "https://media.example/replacement.png";
  await assert.rejects(
    f.call("locator.downloadMedia", { locator, planId: plan.id }),
    { code: "STALE_REF" },
  );
});

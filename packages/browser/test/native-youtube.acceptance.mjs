import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { nativeFixture, select } from "./helpers/native.mjs";

test(
  "native public YouTube transcript exports match the actual rendered cues through both SDK entry points",
  { timeout: 240000 },
  async (t) => {
    const source = process.env.NEXUM_BROWSER_PUBLIC_YOUTUBE_URL,
      expected = process.env.NEXUM_BROWSER_PUBLIC_YOUTUBE_TEXT;
    assert.ok(
      source && expected,
      "Select an anonymous public YouTube fixture and an independently specified expected transcript term.",
    );
    const url = new URL(source);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "www.youtube.com");
    assert.equal(url.pathname, "/watch");
    assert.equal(url.username + url.password, "");
    const videoId = url.searchParams.get("v");
    assert.match(videoId, /^[A-Za-z0-9_-]{11}$/);
    const f = await nativeFixture(t);
    const opened = await f.run(
      select +
        `await tab.navigate(context.input.url,{waitUntil:'domcontentloaded',timeoutMs:30000});return {id:tab.id,url:await tab.url(),title:await tab.title()};`,
      { base: f.base, url: source },
    );
    const arrived = new URL(opened.result.data.url);
    assert.equal(
      arrived.searchParams.get("v"),
      videoId,
      JSON.stringify({
        page: arrived.origin + arrived.pathname,
        videoId: arrived.searchParams.get("v"),
        title: opened.result.data.title,
      }),
    );
    const id = opened.result.data.id;
    const facts = `(()=>{const player=document.querySelector('#movie_player')?.getPlayerResponse?.()??globalThis.ytInitialPlayerResponse;return {videoId:document.querySelector('ytd-watch-flexy')?.getAttribute('video-id')??null,playerVideoId:player?.videoDetails?.videoId??null,urlVideoId:new URL(location.href).searchParams.get('v'),readyState:document.readyState,metadata:document.querySelectorAll('ytd-watch-metadata').length,expands:Array.from(document.querySelectorAll('ytd-watch-metadata #description-inline-expander #expand')).map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};}),segments:document.querySelectorAll('transcript-segment-view-model,ytd-transcript-segment-renderer').length};})()`;
    const observed = await f.run(
      `
    const {createBrowserClient}=await import('@nexum-hub/browser');
    const selected=await createBrowserClient(browser).browsers.get(context.input.fixtureBrowserId),tab=await selected.tabs.get(context.input.id);
    let stage='metadata';
    try {
    const metadata=tab.playwright.locator('ytd-watch-metadata');
    await metadata.waitFor({state:'visible',timeoutMs:20000});
    stage='expand visible';
    const expand=metadata.locator('#description-inline-expander #expand');
    await expand.waitFor({state:'visible',timeoutMs:15000});
    stage='expand click';
    await expand.click();
    stage='transcript visible';
    const transcript=metadata.locator('ytd-video-description-transcript-section-renderer').getByRole('button');
    await transcript.waitFor({state:'visible',timeoutMs:15000});
    stage='transcript click';
    await transcript.click();
    stage='rendered cues';
    await tab.playwright.locator('transcript-segment-view-model,ytd-transcript-segment-renderer').first().waitFor({state:'visible',timeoutMs:15000});
    const identity=await tab.evaluate(${JSON.stringify(facts)});
    const cues=await tab.evaluate("(()=>{const modern=Array.from(document.querySelectorAll('transcript-segment-view-model')),nodes=modern.length?modern:Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));return nodes.map(e=>({stamp:e.querySelector(modern.length?'.ytwTranscriptSegmentViewModelTimestamp':'.segment-timestamp')?.textContent.trim()??'',body:e.querySelector(modern.length?'.ytAttributedStringHost[role=text]':'.segment-text')?.textContent.trim()??''})).filter(cue=>cue.body);})()");
    return {identity,cues};
    } catch(error) {
      let identity;try{identity=await tab.evaluate(${JSON.stringify(facts)});}catch(cause){identity={unavailable:true,code:cause.code??null};}
      return {failure:{stage,code:error.code??null,message:String(error.message).slice(0,250)},identity};
    }
  `,
      { id },
    );
    const data = observed.result.data;
    assert.equal(data.failure, undefined, JSON.stringify(data));
    // The actual watch document carries identity even when the site's optional
    // player method is absent. Never substitute the test input for an observed ID.
    assert.equal(data.identity.videoId, videoId, JSON.stringify(data.identity));
    assert.equal(data.identity.urlVideoId, videoId);
    if (data.identity.playerVideoId !== null)
      assert.equal(data.identity.playerVideoId, videoId);
    assert.ok(
      data.cues.length >= 10,
      "The actual page did not render a complete usable transcript.",
    );
    const text = data.cues
      .map((cue) => `${cue.stamp ? `[${cue.stamp}] ` : ""}${cue.body}`)
      .join("\n");
    assert.ok(
      text.toLowerCase().includes(expected.toLowerCase()),
      "The actual transcript is missing the independently specified public source term.",
    );
    const bytes = Buffer.from(text, "utf8"),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.ok(bytes.length > 1000);
    const receipts = [];
    for (const method of [
      "tab.content.exportYouTubeTranscript",
      "tab.exportYouTubeTranscript",
    ]) {
      const result = await f.run(
        `const {createBrowserClient}=await import('@nexum-hub/browser');const selected=await createBrowserClient(browser).browsers.get(context.input.fixtureBrowserId),tab=await selected.tabs.get(context.input.id);return await ${method}();`,
        { id },
      );
      const artifact = result.result.data,
        actual = readFileSync(artifact.path);
      assert.match(artifact.mimeType, /^text\/plain(?:;|$)/);
      assert.equal(artifact.size, bytes.length);
      assert.equal(artifact.sha256, sha256);
      assert.deepEqual(actual, bytes);
      receipts.push({ method, bytes: actual.length, sha256 });
    }
    // The fixture's anonymous page content and signed caption URLs never enter logs.
    t.diagnostic(
      JSON.stringify({ source, segments: data.cues.length, receipts }),
    );
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import { parseTag, releasePlan } from "../scripts/npm-release.mjs";

test("stable release versions come from the pushed vX.Y.Z tag", () => {
  assert.deepEqual(
    releasePlan({ eventName: "push", ref: "refs/tags/v1.4.2" }),
    { mode: "stable", tag: "latest", version: "1.4.2" },
  );
  for (const tag of ["v1.2", "v1.2.3-rc.1", "v01.2.3", "other-1.2.3"])
    assert.throws(() => parseTag(tag), /stable vX.Y.Z/);
});

test("manual release without tags starts from 0.0.1 and uses a unique preview", () => {
  assert.deepEqual(
    releasePlan({
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      runNumber: "42",
    }),
    { mode: "preview", tag: "next", version: "0.0.1-next.42" },
  );
});

test("manual release after tags targets the next patch instead of a published stable version", () => {
  assert.deepEqual(
    releasePlan({
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      runNumber: "43",
      tags: ["v0.0.1", "v0.2.9", "v0.2.10", "v0.2.10-rc.1"],
    }),
    { mode: "preview", tag: "next", version: "0.2.11-next.43" },
  );
});

test("manual publishing from tags or non-main branches is rejected", () => {
  assert.throws(
    () =>
      releasePlan({
        eventName: "workflow_dispatch",
        ref: "refs/tags/v0.0.2",
        runNumber: 44,
      }),
    /main/,
  );
  assert.throws(
    () =>
      releasePlan({
        eventName: "workflow_dispatch",
        ref: "refs/heads/feature",
        runNumber: 44,
      }),
    /main/,
  );
  assert.throws(
    () =>
      releasePlan({
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        runNumber: 0,
      }),
    /run number/,
  );
});

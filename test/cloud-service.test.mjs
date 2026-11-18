import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { servicePlan } from "../scripts/service.mjs";
import { synchronizeCloudService } from "../scripts/cloud-service.mjs";

test("Cloud-managed services fetch current bootstrap and run the native Agent", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const win = platform === "win32", p = win ? path.win32 : path.posix;
    const home = win ? "C:\\Users\\Nexum User" : "/tmp/Nexum User";
    const root = p.join(home, ".nexum-dev");
    const plan = servicePlan({ profile: "development", platform, home,
      cloudManaged: true, serverUrl: "https://nexum-dev.example/",
      userId: 501, windowsSid: "S-1-5-21-1-2-3-1001" });
    assert.equal(plan.native, p.join(root, win ? "nexum-agent.exe" : "nexum-agent"));
    assert.ok(plan.content.includes("nexum-agent"));
    assert.doesNotMatch(plan.content, /program\/app|service-runner\.mjs|@nexum-hub\/agent@/);
    assert.doesNotMatch(plan.content, /--token|private-token|secret=|Bearer /i);
    if (platform === "darwin") {
      assert.match(plan.content, /nexum-agent(?:\.exe)?/);
      assert.doesNotMatch(plan.content, /agent\/install\.sh|\/bin\/sh/);
    } else if (platform === "linux") {
      assert.match(plan.content, /ExecStart=.*nexum-agent/);
      assert.doesNotMatch(plan.content, /agent\/install\.sh|\/bin\/sh -c/);
      assert.match(plan.content, /Restart=on-failure/);
    } else {
      assert.match(plan.content, /<LogonType>InteractiveToken/);
      assert.match(plan.content, /nexum-agent\.exe/);
      assert.doesNotMatch(plan.content, /powershell\.exe|node\.exe/);
    }
  }
});

test("Cloud-managed installation prepares native entry without touching user state", {
  skip: !existsSync(new URL("../native/" + ({win32:"windows",darwin:"darwin",linux:"linux"}[process.platform]) + "-" + process.arch + "/" + (process.platform === "win32" ? "nexum-agent.exe" : "nexum-agent"), import.meta.url)),
}, async (t) => {
  const home = realpathSync.native(await mkdtemp(path.join(tmpdir(), "nexum-cloud-service-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await synchronizeCloudService({ profile: "development",
    serverUrl: "https://nexum-dev.example/", home, mode: "install", register: false });
  const expected = path.join(home, ".nexum-dev",
    process.platform === "win32" ? "nexum-agent.exe" : "nexum-agent");
  assert.equal(result.nativeExecutable, expected);
  assert.ok((await readFile(expected)).length > 10000);
  assert.ok(!result.manifest.includes("private-token"));
});

# 下载与文件上传

需要 Tab 时先按 [初始化与发现](bootstrap.md) 获取目标。

## 下载与资源

先建立下载等待器，再触发本次页面下载操作；等待器就绪不等于文件已保存。不要在未确认前重复下载。

需要下载附件时，等待真实下载完成再使用下载文件；单纯的页面点击或下载开始事件不是文件已写入成功的证据。

如果网页下载没有被当前等待器关联，可以直接查看当前浏览器配置的下载列表。`selected.downloads.list()` 返回原生记录，`filename` 是浏览器报告的本机路径；列表包含其他标签和目录的记录，不能凭同名文件认定是本次请求的下载；只有用户请求的目标与来源证据能够对应时才交付。默认最多 1000 条，可用 `limit` 调整数量，`0` 表示全部。先只读确认用户本次请求对应的实际下载记录 id，在新的 Run 中将它作为 `context.input.downloadRecordId` 传入；仅当记录仍存在且 `state === "complete"` 时才交付，不能按同名文件自动选取：

```javascript
const records = await selected.downloads.list({ limit: 20 });
const id = context.input?.downloadRecordId; // 来自本次已核对的下载记录
if (!Number.isSafeInteger(id)) return { status: "unconfirmed",
  reason: "尚未确认本次请求对应的下载记录 id，不能按同名文件猜测" };
const file = records.find((item) => item.id === id && item.state === "complete");
if (!file) return { status: "unconfirmed",
  reason: "指定下载记录不存在或尚未完成，不能交付文件" };
return { type: "resource_link", path: file.filename };
```

列表中路径可能位于浏览器配置的任意下载目录；实际读取仍使用当前 Agent 的路径授权和大小规则。记录由浏览器提供，文件可能已移动或删除，`exists` 也可能滞后。浏览器记录的数字 `id` 与 `tab.downloads()` 的页面下载 ID 不同，不可用于 `tab.saveDownload`。列表不返回来源 URL，避免将下载内容或凭据放进模型上下文。

当前等待器无法确认下载身份时，`download.path()` 仍返回 `CAPABILITY_NOT_ALLOWED`；可以通过上述列表由 AI 选择文件。浏览器提供文件大小时，等待器路径的实际文件必须与之相符；大小未知时按实际读取结果处理。不会重发原请求。

`tab.downloads()` 对 `data:` 下载省略 URL，因为 URL 本身包含文件内容；完整内容通过文件或资源交付。

下载结果需要交给 AI 时，返回实际已确认文件的受控资源引用：

```javascript
const pending = tab.playwright.waitForDownload();
await tab.playwright.getByRole("link", { name: "下载报表" }).click();
const downloaded = await pending;
let file;
try {
  file = await downloaded.path();
} catch (error) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code : undefined;
  if (code !== "CAPABILITY_NOT_ALLOWED" &&
      code !== "FILE_UNAVAILABLE") throw error;
  return { status: "unconfirmed", code,
    reason: "无法可靠确认该下载对应的本地文件；请按当前下载记录核对" };
}
if (file === null) return { status: "unconfirmed",
  reason: "下载尚无可读取的实际文件路径，未交付文件" };
return { type: "resource_link", path: file };
```

结果层按当前路径授权和大小限制固定实际文件并返回标准 MCP 资源引用。只有收到真实资源引用才能认定文件可供 Host 读取；需要文件正文时使用 Host 支持的资源读取，或按当前 transfer Skill 建立下载通道。通道就绪不代表传输完成。

如果动作已派发后超时、取消或断连，`effect: unknown` 表示不能证明网站副作用。先重新观察，不能自动重发点击、提交、文件选择或整个脚本。用户原生调试取消会使旧控制失效；不通过重新 get 恢复同一已交还的 run 目标。

## 上传文件

上传用户指定的文件时，先确认它在**当前 Agent 的本地文件路径**、本次请求允许上传，且 Browser 与该路径都已获授权。`FileChooserFiles` 支持文件路径或 `BrowserFileSource`；从真实观察中找到页面当前的上传入口，不凭文字猜隐藏的上传控件。

在同一 `agent.run.start.script` 已取得 `tab`，并且 `context.input.filePath` 是用户本次提供、可读取的 Agent 文件路径时：

```javascript
if (typeof context.input?.filePath !== "string") {
  throw new Error("缺少本次要上传的 Agent 本地文件路径");
}
const pendingChooser = tab.playwright.waitForFileChooser();
await tab.playwright.getByRole("button", { name: "上传文件" }).click();
const chooser = await pendingChooser;
await chooser.setFiles([{ path: context.input.filePath }]);
return await tab.observe();
```

页面的实际上传按钮名称须来自本次观察，上面“上传文件”只是示例。`setFiles` 完成不等于网站已收到或保存文件；后续根据页面的文件名、上传完成提示等可观察状态验证。操作已下发但结果未知时先观察，不盲目重复上传；文件访问失败或权限被拒绝时报告准确原因。

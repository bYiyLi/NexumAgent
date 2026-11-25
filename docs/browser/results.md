# Nexum browser 结果、文件与媒体交付

## 数据与传输责任

browser 方法返回普通业务数据、原生 bytes 或公开结果意图；Node 客户端构造的 Tab/Locator 不是结果内容。插件 → 本包通过当前已校验的本机连接返回字节/事件；本包 → Agent 通过公共方法返回值/结果服务；Agent → Cloud → Host 复用平台数据面、标准 MCP 内容与 Resources。浏览器本机路径、resource URI、一次性 HTTPS Offer 是不同身份。

禁止从 browser 包拼接 MCP envelope、直接访问内部产物/传输管理器、建立第二份 Cloud 资源库，或由高层媒体 SDK 把媒体 base64 写入 structuredContent/日志/持久运行结果。旧 QuickJS JSON/base64 及 64 KiB 上传/截图限制不作为本包大文件能力上限。

## 各类结果

| 结果                                    | SDK 实际值与交付                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面结构/文字、WebMCP 数据              | 结构化数据或文本；结构化快照超预算时提供截断标志和实际本机全文产物，脚本显式返回标准 resource_link 路径描述以固定为资源                                                                                                            |
| screenshot、elementScreenshot、AX 图像  | 返回真实 JPEG/PNG bytes（Uint8Array）及必要尺寸/标注；脚本直接 return 真实 bytes，由结果层自动识别并交付                                                                              |
| 图片/音频/视频                          | 按实际 MIME/bytes/尺寸/时长检查；内联或资源按协议/Host/预算；不靠改 MIME 或扩展名冒充转码                                                                                                                 |
| PDF/HTML/Markdown、Gsuite、页面内容导出 | 用当前页面/站点登录态取得实际内容并保存本机产物；提供 file path/name/MIME/size/hash；无 Host 专属文件库依赖                                                                                               |
| 下载/媒体获取、资产 bundle              | 观察到真实下载完成、校验可读后返回产物及逐项失败；部分成功不得冒充全部完成                                                                                                                                |
| 剪贴板                                  | 经目标浏览器原生 API 读写实际文本/多格式 bytes；可能是系统共享剪贴板，不宣称标签隔离；TabClipboardEntry 为 text 或 Uint8Array 的判别输入，不保留 base64，浏览器缺权限明确失败，不用 OS 全局剪贴板静默替代 |
| 历史                                    | 取已保存结果/资源，不重读已变化页面或源文件，不重新触发截图/下载                                                                                                                                          |

```javascript
import { createBrowserClient } from "@nexum-hub/browser";
const client = createBrowserClient(browser);
const selectedBrowser = await client.browsers.get(context.input.browserId);
const tab = await selectedBrowser.tabs.get(context.input.tabId);
const image = await tab.screenshot();
return image;
```

需要正文给模型时交付实际标准内容；只返回路径/URI 不表示模型已读取。原始 Uint8Array 根据真实字节签名识别受支持图片/音频；无法验证时保留为资源链接。混合结果保留顺序和原类型，SDK 不在后台秘密发送额外模型消息。AX write 映射为可 return 的内容意图。

## 上传与文件选择

支持同机绝对路径、准备好的原生 bytes/Blob；公开类型 BrowserFileSource 与 FileChooserFiles 在本包完整定义。工作相对路径在当前 call 的 pwd 解析，再 canonical/实际 I/O 检查；浏览器插件不能以页面参数改写路径或越过受管文件来源授权。

同机可用的 CDP 文件选择使用真实可访问路径；需要经插件传 bytes 时走有界二进制流。多个文件必须全部准备并确认当前 chooser/目标/页面有效后再提交；预检失败不发送文件选择命令，也不把已消费 chooser 自动重用；已派发后取消/断连仍按 effect=unknown 记录，不承诺网站没有接收或提交。文件输入使用上述明确的路径或原生 bytes/Blob 类型；不为旧 QuickJS base64 输入另建兼容层。

默认下载、上传副本、导出和资产包统一使用当前 `context.paths.temp/artifacts`；只申请该 Run 子树的具体读写权限，不申请 profile、`tmp` 或运行元数据目录的写权限。显式保存位置继续按当前项目路径授权。初始或后续聊天附件由 Nexum 在脚本执行/续接前完整准备；browser 使用 context.attachments 中的实际本机路径。不增加浏览器附件模型工具，也不要求 Host 自行构造本机文件路径。

## Google Workspace 原生导出

导出计划只观察当前文档身份、格式与源地址，不发网络请求。实际导出在原标签的主 frame 使用 `Network.loadNetworkResource` 和 `includeCredentials`，取得当前浏览器上下文的真实响应，再通过有界 `IO.read` 读取。该浏览器原生路径支持站点正常的导出重定向，不改页面 CORS、浏览器安全设置或使用 Node 代持登录凭据；不能以普通页面 fetch 成功作为所有站点导出的前提。

原生流使用与 PDF 导出相同的受管句柄登记和 `IO.close` 收尾；每段及总字节都受预算约束。取消、当前文档导航或控制身份失效后，不返回部分文档；迟到的原生句柄也须关闭。非成功 HTTP、登录 HTML、与请求格式不符的实际 bytes 明确失败；Office 格式检查真实 ZIP 文档部件，不能只凭扩展名或 PK 前缀。公开产物保留实际 size/hash，历史读取不重新导出当前站点。

Google Markdown 的文本响应兼容 `text/x-markdown` 等同义 MIME，结果使用 `text/markdown`；该规范化不改变实际字节，也不把 HTML 登录页或二进制响应改名当 Markdown。

## 下载、固定产物和外部领取

`selected.downloads.list({limit?})` 读取当前已连接浏览器配置的正常下载记录，包括其他标签、此前运行及不同目录中的记录；不按 Agent 的工作目录筛选，也不声称每条记录都由当前任务触发。记录沿用浏览器的数字 `id`、`filename` 本机完整路径、状态、时间、大小和 MIME 等字段，按开始时间倒序返回；默认与浏览器 API 一样最多取 1000 条，调用方可用 `limit` 调整数量，`0` 表示全部。记录的文件路径是浏览器报告的状态，读取时仍需实际检查文件及当前路径授权。为避免把下载内容或带凭据的链接塞进列表，不返回来源 URL；`data:` 文件内容通过文件或 Resource 读取。

AI 可以从这份列表选择具体完成的文件，然后使用 `{type:"resource_link",path:record.filename}`；后者沿用平台现有规则登记标准 MCP Resource。浏览器原生记录的数字 `id` 不是 `tab.downloads()` 或 `waitForDownload()` 返回的页面下载身份，不能互换。 等待器门面公开当前页面下载 `id` 和实际事件 `suggestedFilename`；`tab.downloads()` 仅在两端原始事件通过唯一标记确证、归属一致且无冲突时返回可选 `nativeRecordId`，据此可用 `selected.downloads.list({id: nativeRecordId})` 精确读取原生记录。名称可能带唯一标记，不能按原文件名或 URL 推断；记录查询不授予文件读取权限。没有唯一目标时由调用方根据列表判断，不把某条记录自动当作当前任务的结果。

先注册下载等待器，再触发网页操作；记录 downloadId、目标/页面/连接、当前 run/operation 与实际状态。文件实际完成、可读且与已知的浏览器文件大小一致后，复制到本次临时目录或已授权明确目标；原子 no-replace，失败保留已发生下载事实并清理未提交临时文件，不重复点击下载。

用户指定保存路径、浏览器默认下载位置、Nexum 注册资源分别反馈；SDK 返回的 path 指向已经存在的本机文件。网页下载未完成/被取消、文件丢失、权限变化或流失败均明确报错。资源包装时平台固定实际内容再注册 URI，原文件不挪走；读取旧结果不再次访问当前页面或原始可变路径。

需要外部下载时复用 transfer.createDownload({uri})；Offer 只表示受控领取通道准备好，不能据此宣称用户已保存。一次性 URL 不进入日志/历史，不被资源预读消费；新领取重查当前权限和保留期，不延长产物寿命。

## 平台预算与保留

运行期限、结构化数据/媒体预算、资源有效期、Task 承诺和当前授权由平台负责。输入/结果超限明确错误或固定全文资源，绝不截断二进制后仍宣称成功。

当前输入基线：普通文本/JSON 64 KiB；单图 10 MiB/40MP、单音频 32 MiB/2 小时、单次内联媒体合计 64 MiB、最终编码响应 128 MiB；文件上传/下载默认预算按平台 transfer 契约逐项实现，不把内联上限套给可下载文件。预检与流式实际计数/解析均有界，配置以当前平台实际值为准，包不维护第二份隐含默认值。

运行历史终态后 30 天、日志 7 天/单运行最新 50 MiB、自动资源生成后 7 天、临时输入无活动引用且终态后 24 小时；活跃/Task 承诺按平台保护，读取不续期。本段是本次平台输入快照的使用口径，平台变更须同步此适配和验收；不为 browser 另建 Avru SQLite 运行/日志 authority。

## 原始 CDP 的协议保真

raw cdp.send 的返回在当前 Node 脚本内保留浏览器原始 JSON 形态，某些命令的编码媒体字段不在插件桥接时擅自改型；大 JSON 使用 connection.md 定义的有界流。需要实际图片/文件交付时，脚本或本包高层封装显式解码、验证并交给最终结果转换器，不自动复制原始响应作为媒体展示。审计和默认运行摘要只保留方法/目标/结果状态，原始协议正文不自动落日志；显式业务结果仍遵守平台数据预算与当前授权。

## 大快照与资源注册时机

公开 call.output 是意图包装，call.resources 管运行控制；两者都不是给扩展直接注册 ArtifactStore URI 的私有入口。本包只把完整内容写到当前 profile 已授权的本机产物路径，返回 BrowserArtifact（path/name/MIME/size/hash）。PageSnapshot/VisibleDomTree/文本导出的 truncated=true 与 artifact 明确保留全文位置；没有实际全文文件时不填 artifact。纯字符串接口 domSnapshot/AX state/innerText 等不能偷偷拼入不可用 URI 或在类型外加元数据，超出它声明的返回预算则报 OUTPUT_TOO_LARGE，并提示用有范围的结构化观察或导出。

脚本需要将全文交付 Host 时显式 `return {type:"resource_link",path:snapshot.artifact.path}`，或与摘要一起组合结果；平台在最终结果处理时核对权限、固定实际 bytes 并注册可用 URI。返回本机 path 只表示文件已存在；不表示已经注册 Resource 或外部可下载。BrowserUserTabContext 的 resource 分支只用于公开平台已提供且当前可访问的 URI；新提取文档走 document bytes 或 artifact 分支。不再暴露没有 read 方法的 nextCursor，也不在 SDK 返回尚未注册的 resourceUri。

WebMCP/任意页面 JS 返回需符合其 Schema 和本机流预算，巨大业务对象可显式导出文件或报超限，不能无限缓冲。原始 CDP 的协议保真是本机传输例外；原始响应若直接成为运行最终结果，仍按标准平台 JSON/媒体预算验证，不绕过 final response 限额。

## 下载身份与收尾

PlaywrightDownload 门面绑定原始 downloadId/browserSession/generation 与创建事件，不按当前页面 URL 猜文件。页面导航不自动使已开始的下载失效；浏览器重启/连接丢失需要真实状态核对，不能把另一个下载的同名文件套过来。path/saveDownload 受该次 call.signal/deadline 与当前路径授权约束，只有 complete、文件可读且已计算固定产物的实际大小和 SHA-256 才返回；浏览器提供解压后文件大小时，还必须与实际读取字节一致，大小未知时不虚构该校验。失败、取消、未找到或权限不可用明确区分；path 的 null 只用于原生明确没有可用路径的事实，不把等待超时伪装成 null 成功。

对于受控标签明确等待的 HTTP 附件响应，扩展在原始响应的建议文件名中添加唯一编号，建议浏览器将该次下载保存到默认下载目录的 `Nexum` 子目录；保留带编号的名称和浏览器原文件，不更改浏览器全局默认目录。页面下载事件和浏览器下载记录必须确认为同一编号，才能按该记录的真实完成状态和路径读取；若身份不明或冲突，明确失败。其他标签和未匹配的下载不被重命名。Blob、无附件响应头等其他下载方式不因此自动获得文件身份。

对受控标签中直接点击、或由该次点击同步创建并触发的 HTTP/Blob/data 下载链接，在已准备下载等待器的情况下，仅在实际点击周围为该链接暂时设置唯一下载名称，并在点击后恢复原链接属性；由浏览器正常执行原始下载，随后仍按同一编号确认原生记录。部分异步生成、未连接页面、跨 frame 及其他无法确认身份的下载不推断为当前目标。

脚本可将已固定的下载文件通过 `{type:"resource_link",path:...}` 交给平台；结果编码成功时，平台才把完整内容登记到该 Agent 的 `work/resources` 并返回标准 MCP `resource_link`。Host 后续使用 `resources/read` 读取内容。浏览器下载路径、临时产物、平台资源是各自独立的事实；当前授权、大小预算或资源登记失败时不返回伪造的成功链接。

本包控制等待器/run 结束后，浏览器原生下载可能仍继续；不声称已经取消网站下载。下载后的固定产物独立于活跃下载控制器，历史通过平台保存的结果读取，不借读取产物恢复旧控制。artifact 临时文件在平台尚未物化完成前必须可用，不能在单方法 finally 或 RunScope.dispose 中删掉结果源；按平台保留/无活动引用清理，失败清理仅删除未提交的本包临时片段。

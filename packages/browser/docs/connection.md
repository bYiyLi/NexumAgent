# 连接与原生限制

包启用后准备的稳定插件目录为当前 Agent work 下的 `.nexum-browser/extension`。它是本包匹配的解压插件文件，准备文件不会自动安装浏览器扩展。用户通过浏览器原生扩展管理界面加载并确认权限；真实上线来自插件 hello/ready 和完整标签快照。

production 使用 `127.0.0.1:43831`，development 使用 `127.0.0.1:43832`，路径为 `/nexum-browser/v1`。配套插件的实际公钥/ID、版本、profile 和端口必须匹配本包制品。端口冲突明确失败，不抢占进程、不漂移到别的环境。

浏览器 profileId 只是本地路由身份。健康的另一 worker/profile 冲突不会被晚到连接覆盖；重连只重新握手和同步，不重放网页动作。旧 boot、连接代次或浏览器 session 的句柄不能指向新连接。

Chrome/Edge 自身权限、企业策略、受限页面、无痕设置和 debugger 冲突仍生效。普通网页、书签、工具说明和 WebMCP 描述是数据，不能授予连接/Agent 权限。包不持有 Cloud Token，不静默安装插件，也不关闭用户浏览器。

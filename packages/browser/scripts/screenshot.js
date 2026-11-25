/**
{
  "scriptName": "screenshot.js",
  "scriptDesc": "截取授权标签并直接交付原生 JPEG。输入 {browserId,tabId,fullPage?,clip?,quality?,maxEdgePx?}，两 ID 必填，使用当前 browser/discover.js 或 SDK 发现的真实身份。默认视口、quality=75、原始像素密度，不自动缩放；fullPage:true 截整页，clip:{x,y,width,height} 用文档 CSS 坐标（含滚动偏移，x/y≥0、宽高>0），不得同时使用 fullPage:true 和 clip。quality 0–100整数；仅显式传正整数 maxEdgePx 限制实际像素最长边且不放大小图。Browser 不设额外最长边、总像素或 JPEG 字节预算；平台媒体/结果预算仍生效。超限先降 quality，任务允许时缩小尺寸或区域。断连/失效重新发现；权限拒绝不绕过。成功不包装 JSON、Base64 或本机路径，失败不使用旧图替代；不导航、切换或自动重试。",
  "scriptWhenUse": "需要当前视口、整页或区域图像时；仅需标题、URL 或结构时使用发现/观察。",
  "scriptInputSchema": {
    "type": "object",
    "properties": {
      "browserId": {
        "type": "string",
        "minLength": 1
      },
      "tabId": {
        "type": "string",
        "minLength": 1
      },
      "fullPage": {
        "type": "boolean"
      },
      "clip": {
        "type": "object",
        "properties": {
          "x": {
            "type": "number",
            "minimum": 0
          },
          "y": {
            "type": "number",
            "minimum": 0
          },
          "width": {
            "type": "number",
            "exclusiveMinimum": 0
          },
          "height": {
            "type": "number",
            "exclusiveMinimum": 0
          }
        },
        "required": [
          "x",
          "y",
          "width",
          "height"
        ],
        "additionalProperties": false
      },
      "quality": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "maxEdgePx": {
        "type": "integer",
        "minimum": 1
      }
    },
    "required": [
      "browserId",
      "tabId"
    ],
    "additionalProperties": false,
    "not": {
      "type": "object",
      "properties": {
        "fullPage": {
          "const": true
        },
        "clip": {}
      },
      "required": [
        "fullPage",
        "clip"
      ]
    }
  },
  "scriptOpenDefault": false
}
*/
const { browserId, tabId, ...options } = context.input;
const { createBrowserClient } = await import("@nexum-hub/browser");
const client = createBrowserClient(browser);
const selected = await client.browsers.get(browserId);
const tab = await selected.tabs.get(tabId);
return await tab.screenshot(options);

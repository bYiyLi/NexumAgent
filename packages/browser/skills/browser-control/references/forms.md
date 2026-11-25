# 表单与元素交互

## 正确选择方法

| 当前真实元素 | 操作 | 读回 |
| --- | --- | --- |
| `input` 文本、`textarea` | `locator.fill(value)` / `pressSequentially(value)` | `tab.evaluate` 读取对应 `value` 或页面确认信息 |
| `input[type=checkbox]` | `check()`、`uncheck()`、`setChecked(boolean)` | 核对 `checked` |
| `input[type=radio]` | `check()` 目标项 | 核对该项 `checked`，更换选择则 `check()` 同组另一项 |
| `select` | `selectOption(value)` | 核对 `value`、`selectedOptions` |
| 按钮、链接等可交互元素 | `click()`、必要时 `dblclick()` | 核对导航、业务结果或页面状态 |

不要以文字 `medium` 推断它是下拉选项。先从 `observe`、DOM 或属性确认元素类型。已选中的 radio 通常不能用 `uncheck()` 取消；需要选其他选项时定位同组另一项。若类型与所选方法不符，应修正方法或目标，而非刷新页面或重试。

## 可复制的最小表单示例

在同一个 `agent.run.start.script` 中，先根据 [操作与交付](bootstrap.md) 取得 `tab`，下列片段才能执行：

```javascript
const checkbox = tab.playwright.locator('input[type="checkbox"][name="consent"]');
await checkbox.check();
const checkboxState = await tab.evaluate(
  "document.querySelector('input[name=consent]')?.checked"
);
return { checked: checkboxState };
```

`locator.check()` 成功后再读回结果，若值不符，报告页面实际状态，不盲目重复点击。页面可能在事件回调内更改 DOM。

```javascript
const size = tab.playwright.locator('select[name="size"]');
await size.selectOption("medium");
return await tab.evaluate(
  "document.querySelector('select[name=size]')?.value"
);
```

代码是示例，选择器只在真实页面存在相应元素时使用，不能当作所有网页的固定结构。提交表单、付款或发送前应具备用户当前授权及实际完成判据。

## 键盘输入与快捷键

- `tab.cua.keypress({keys:["Backspace"]})`、`tab.dom.keypress({keys:["Backspace"]})` 使用区分大小写的原生键名。Enter、Tab、Escape、Delete、ArrowLeft、ArrowRight、ArrowUp、ArrowDown、Home、End、PageUp、PageDown、Space、F1–F24 或单个字符均按当前键盘合同解析；不得将键名全部转成大写。
- 组合键按键名数组提供，例如 `{keys:["ControlOrMeta","a"]}`；ControlOrMeta 在 macOS 表示 Meta，在其他系统表示 Control。长文本用 fill、type 或 pressSequentially，不要把长文本当作单个键名。
- INVALID_ARGUMENT 且 reason: invalid_key 时先修正键名，不重复执行原来的输入。其他入口的参数形状以实际 SDK 方法签名为准。

## 不可猜测的公开方法

- `tab.playwright.elementInfo({x, y})` 返回**数组**，可为空；单元素也用 `result[0].boundingBox`。
- 当前 Locator 不提供 `hover()`；使用当前观察得到的 ref 走 `tab.hover(ref)`。不能调用猜测的 Playwright 原生全集。
- 不得把 `locator.setChecked(false)` 施加在已经选中的 radio 上，期望像 checkbox 一样取消其选择。
- 需要具体 Options、timeout 或重载时读取 [API 类型索引](api-index.md) 的相应声明与当前注册路由参数。

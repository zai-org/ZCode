# 插件界面首帧主题

## 背景

插件界面（MCP App、扩展视图）运行在沙箱 iframe 里，主题通过握手后的 `hostContext.theme` 下发，
插件按 [UI_PLUGIN.md](../../UI_PLUGIN.md) 的约定写入 `document.documentElement.dataset.theme`。

## 问题（已修复）

深色主题下打开应用插件面板（PDF、演示文稿等）会白闪一下：

- 插件样式默认浅色，只在 `:root[data-theme="dark"]` 下切换深色。
- 握手完成前文档上没有 `data-theme`，这段时间内的绘制按浅色进行。
- 握手完成后插件写入 `data-theme="dark"`，画面才变回深色。

浅色主题下默认值与目标一致，不出现闪烁。

## 规则

- main 下发插件文档时，在 `<html>` 标签上预置 `data-theme="light" | "dark"`，取当前生效的应用主题
  （应用主题已同步到 `nativeTheme`；跟随系统时即系统外观）。
- 只预置属性，不写 `color-scheme`，不注入样式。没有按 `data-theme` 写样式的插件表现不变。
- 只认文档开头的根 `<html>` 标签：前面只允许 BOM、空白、注释和 doctype。注释或脚本字符串里出现的
  `<html` 文本不算。判断基于插件的原始文档，在注入 `window.zcode` 别名脚本之前进行，没有 `<head>` 的
  文档同样生效。
- 文档来自第三方插件并在 main 同步处理，前导区和根标签的识别必须是线性耗时，不能使用有回溯歧义的
  正则。
- 根标签已带 `data-theme`，或文档不以 `<html>` 标签开头（片段式 HTML）时，不做改动。
- Gen UI 文档由自带 runtime 处理主题，不在此规则内。
- 握手之后主题仍以 `hostContext.theme` 为准，应用内切换主题由插件响应 `onhostcontextchanged` 更新。

## 已知边界

- 写了 `[data-theme="dark"]` 样式但没有接 `hostContext.theme` / `onhostcontextchanged` 的插件，以前恒为
  浅色，现在按打开时的应用主题显示，应用内切换主题后要重新打开才更新。
- 应用主题在进入主界面后才同步到 `nativeTheme`。在此之前下发的文档按系统外观预置；应用主题与系统
  外观相反时首帧可能相反，握手后由插件纠正，表现与修复前一致。

## 对插件作者的含义

按 `data-theme` 写主题样式即可在首帧得到正确主题，不需要等握手，也不需要自行猜测初始主题。

## 验收场景

1. 应用主题设为深色，打开侧边面板，点击应用插件「PDF」。
2. 从点击到面板内容出现的过程中，面板区域不出现浅色画面。
3. 应用主题设为浅色时重复上述步骤，面板区域不出现深色画面。

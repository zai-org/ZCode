# 01 — pdf 插件：convert.html 与 convert.blueprint 找不到渲染脚本

Status: needs-triage

## 现象

`pdf.py` 的 `convert.html`（`convert_html`）和 `convert.blueprint`（`convert_blueprint`）都要求 `scripts/html2pdf.js`：

- `apps/zcode-cli/packages/pdf-plugin/skills/pdf/scripts/pdf.py:1838`：找不到时报 `DependencyMissing`。
- `apps/zcode-cli/packages/pdf-plugin/skills/pdf/scripts/pdf.py:2044`：同样使用 `html2pdf.js`。

`scripts/` 中只有 `html2pdf-next.js` 和 `html2poster.js`，没有 `html2pdf.js`。所以这两个命令一定失败。

证据来自读代码和列目录，没有实际运行命令。

## 背景

在梳理预装依赖时发现，见 [预装工具](../../preinstalled-tools/README.md)。按约定不在预装改造中修复，修复时机另定。

## 待确认

- 这两个命令应改用 `html2pdf-next.js`，还是已经废弃、应从 SKILL.md 和命令表中删除。

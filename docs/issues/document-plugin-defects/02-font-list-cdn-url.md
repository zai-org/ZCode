# 02 — 文档插件：字体列表是绝对路径，CDN 下载地址可能拼错

Status: needs-triage

## 现象

- `apps/zcode-cli/packages/documents-plugin/skills/docx/env_setup/font_list.txt` 中每行是绝对路径，例如 `/usr/share/fonts/truetype/chinese/SarasaMonoSC-Regular.ttf`。
- `apps/zcode-cli/packages/documents-plugin/skills/docx/env_setup/setup_mac_linux.sh:186` 设置 CDN 根地址，`:221` 把每行直接拼到根地址后面。拼出的地址形如 `<CDN 根>//usr/share/fonts/...`。
- setup.md 的示例地址是 `<CDN 根>/chinese/...`，两者不一致。

推断：按当前脚本，字体下载可能全部失败。没有联网验证。pdf 插件与 xlsx 插件的字体列表和脚本需要一并核对。

## 相关问题

- setup.md 写的是 78 个字体，并列出 emoji、Calibri、Japanese Gothic；列表实际为 80 行、77 个不同文件名，没有这三个字体。pdf 插件的列表为 82 行，有 2 条重复。

## 背景

在梳理预装依赖时发现。预装本期不预装独立字体资源，插件的字体安装流程不变，所以这里的问题仍会影响用户。修复时机另定。

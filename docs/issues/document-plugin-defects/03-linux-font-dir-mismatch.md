# 03 — 文档插件：Linux 上 FONT_DIR 与实际安装目录不一致

Status: needs-triage

## 现象

- `apps/zcode-cli/packages/documents-plugin/skills/docx/env_setup/env_check.sh:25-29`：非 macOS 系统把 `FONT_DIR` 设为 `/usr/share/fonts`。
- `apps/zcode-cli/packages/documents-plugin/skills/docx/env_setup/setup_mac_linux.sh:192`：Linux 上字体实际安装到 `~/.local/share/fonts`。

两个目录不一致。另外，没有插件代码读取 `FONT_DIR`；代码通过写死的绝对路径、`fc-list` 或字体名查找字体。

## 待确认

- `FONT_DIR` 是否还有用途；没有用途时是否删除，有用途时改为与安装目录一致。
- pdf 与 xlsx 插件的 env_check 需要一并核对。

## 背景

在梳理预装依赖时发现。修复时机另定。

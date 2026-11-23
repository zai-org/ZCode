# 01 — 法务确认：预装资源的分发义务

Status: needs-info

## Parent

[预装工具](../../preinstalled-tools/README.md)

## 需要确认的事项

预装资源由 ZCode 的 CDN 分发，并由 App 下载到用户电脑。下列事项要在资源进入正式 catalog 之前得到法务结论。开发和测试使用本地 loopback 资源服务，不受本票阻塞。

1. **GPL 组件**：Poppler（GPL-2.0-or-later）、poppler-data（含 GPL 部分）、Pandoc（GPL-2.0-or-later）以二进制形式分发。
   - 拟定做法：资源包内附 `LICENSES/`（许可证全文与 NOTICE）和 `SOURCES.json`（每个组件的上游源码地址与摘要）；对应版本的源码压缩包同时上传到 ZCode CDN 存档。
   - GPL-2.0 第 3 条要求随二进制提供完整对应源码，或提供至少 3 年有效的书面要约。请确认拟定做法是否满足，是否还需要书面要约或其他材料。
2. **其他第三方组件**：Python 解释器内置的 OpenSSL、SQLite、libffi、Tcl/Tk 等；conda-forge 依赖中的 cairo（LGPL-2.1 或 MPL-1.1）、nss（MPL-2.0）、freetype（FTL 或 GPL-2.0）等；LibreOffice 及 Windows VC++ 运行库；随包 Noto CJK 字体（OFL-1.1）。请确认汇总许可文本的方式是否足够。
3. **用户自行安装的包**：PyMuPDF（AGPL-3.0）不预装。用户需要时，Agent 按插件流程用预装 Python 从 PyPI 安装它，包写进 ZCode 管理的本机目录（预装 Python 的附加区 `tools/python/versions/<resourceId>/overlay/`），ZCode 不分发它。这与插件原来让用户装进自己的 Python 相比，只是安装位置不同。请确认这样做没有分发责任。
4. **GPL 的约束范围**：ZCode 的 Agent 和插件以独立进程调用 Poppler、Pandoc 的命令行程序，不与它们链接，也不修改它们。请确认 GPL 的义务只针对这些程序本身，不延伸到 ZCode 自己的代码。

## 已有结论

- 2026-10-29：PyMuPDF 预装未通过法务，不进入 Python 资源。

## Acceptance criteria

- [ ] 第 1～4 项各有书面结论，并记录在本票 Comments 中。
- [ ] 结论要求的材料已写进 [预装工具](../../preinstalled-tools/README.md) 的“资源制作与发布”和相关工具规格。
- [ ] 任何一项不通过时，对应资源不进入正式 catalog，并在工具规格中记录替代做法。

## Blocked by

None (can start immediately)

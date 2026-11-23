# 14 — 正式发布：CDN 部署与内置 catalog

Status: in-progress

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

资源发布方把验证过的资源部署到 CDN，内置 catalog 填入相对路径。2026-11-06 用户确认接入已经上传的 15 个资源，默认只使用 `https://cdn-zcode.z.ai/zcode/preinstalled-tools`；环境变量覆盖仍保留有序候选。完成后，用户可以下载对应平台的预装工具。

本票接手旧票 [文档工具预装 11](../document-tool-preinstall/11-real-resources-and-local-full-chain.md) 中真实 CDN 的部分。第一步由发布方完成（人工）；部署完成后，再由 Agent 写入 catalog 并做验证。

- 交给发布方的内容：
  - 每个资源的归档和资源描述；
  - `LICENSES/` 和 `SOURCES.json`；
  - GPL 组件的源码包，用于存档。
- 发布方把归档上传到每个基址下的 `archive.path`，再用发布命令生成带 `archive.path` 的 catalog 条目，写进内置 catalog。基址与路径规则见规格的“下载地址”。
- 写入条件：
  - macOS arm64 的条目在 12 通过后就可以写入。
  - 其他平台的条目，要等 13 中对应平台通过后才写入。
  - 法务（[01](01-license-review.md)）未通过的资源，不写入。

## Acceptance criteria

- [ ] 正式构建能从真实 CDN 下载并安装 macOS arm64 的五个资源。
- [ ] 默认只请求 `cdn-zcode.z.ai`；显式配置多个基址时，失败后按配置顺序尝试下一候选（PT-10）。
- [x] catalog 中每个条目的大小和 SHA-256，与交付的资源一致。
- [ ] GPL 组件的源码包已在 CDN 存档，`SOURCES.json` 中的地址可以访问。
- [ ] 01 的结论要求的材料都已落实。

## Blocked by

- [01 — 法务确认：预装资源的分发义务](01-license-review.md)
- [12 — 本机 macOS arm64 真实资源全链路验收](12-macos-arm64-full-chain.md)
- 各平台的条目另外需要 [13](13-other-platform-verification.md) 中对应平台通过

## 本次接入

- 资源范围与版本见 [内置资源清单](../../preinstalled-tools/README.md#内置资源清单2026-11-06)。本次只使用已上传的字节，不重新打包、不改写资源身份。
- 上传核对已完成：30 个文件、1835783848 bytes，全部对象的大小、CRC64 和 CDN 访问通过；归档 SHA-256 与资源描述一致。
- 法务和其他平台原生验收仍按关联票记录，不因 CDN 上传或本次代码接入自动标记完成。

- 2026-11-06 技术接入验证：macOS 26.5.2 arm64 开发构建使用内置清单、无 CDN 覆盖，五工具真实下载安装和 7 项公开入口检查通过；与空清单回归合批 2/2 PASS，记录 `desktop-e2e-20261106070932810-p22478-6662e2670f4e28ce`。本轮未触发重试分支；不代替正式发版构建、其他平台原生验收或法务结论。

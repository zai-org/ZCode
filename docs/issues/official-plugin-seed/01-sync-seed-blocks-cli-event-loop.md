# 官方插件首次 seed 同步阻塞 CLI 事件循环

Status: needs-triage

## 现象

全新 HOME（首次安装、CLI 升级后官方插件版本变化、E2E 每个 spec）中，CLI 第一次解析插件时会
seed 全部官方插件缓存（约 1100 个文件、100MB）。2026-10-30 在 Windows 本机实测：

| 场景                                           | 耗时   |
| ---------------------------------------------- | ------ |
| 冷 HOME 首次 `workspace/readPresentation`      | 8–15 s |
| 同进程第二次 `listProtocolSlashCommands`       | ~0.8 s |
| `zcode plugin list`（冷 HOME，含 CLI 启动）    | 13.5 s |
| `zcode plugin list`（缓存已就绪，含 CLI 启动） | 4.2 s  |

## 根因证据

- CPU profile 调用链：`listProtocolSlashCommands` → `resolveZCodePlugins` → `resolveOfficialPluginRoots`
  → `seedBundledOfficialPlugins` → `withOfficialPluginSeedLock`，其中 `writeFileSync`/`close` 占约 6.9 s。
- seed 全程在 CLI 事件循环上同步执行（`apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`）。
  同时到达的 `session/create` 在 seed 结束后约 50 ms 才开始，用户首条消息因此等待 8–15 s。
- mac/linux 未实测。CI 中相关首发用例只在 Windows 失败，推测与 Windows 小文件写入较慢有关（未证实）。

## 待决定

seed 是否移出请求路径（例如异步写入、启动后后台 seed、或按需 seed 单个插件），需要 CLI 负责人
设计。E2E 侧已用模板缓存预热隔离该开销，见
[conversation-session-automatic-e2e-ci.md「官方插件缓存预热」](../../testing/conversation-session-automatic-e2e-ci.md#官方插件缓存预热)。

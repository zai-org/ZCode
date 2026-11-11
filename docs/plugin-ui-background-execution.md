# MCP 页面保留与后台执行

## 问题与边界

此前所有 MCP 页面都拒绝回收并维持后台帧，普通插件也长期占用内存和 CPU。
现在只有资源显式声明才保留后台执行，未声明恢复原回收策略。声明页也受窗口预算与闲置期限约束。
协议握手完成、session 停止不代表编辑器内部工作完成；真实业务活动与空轮询必须区分。

## 生命周期

### 首次打开与会话恢复的连接屏障

插件面板可与历史投影同时冷打开，订阅已建立不代表 session runtime 已就绪。
`mcp/uiOpenInstance` 先等待该 session 的 `SessionLifecycleController.ensureReady()`：
未加载时恢复已有会话，正在恢复时共享同一在途结果，并发打开不得重复恢复。
初始化失败、会话不存在或资源释放失败时传播原错误，不签发页面凭证。

会话恢复完成不等于目标 MCP 已连接。随后必须等待该 server 已有的
连接任务完成，再读取连接身份并签发页面凭证。等待由 MCP adapter / pool 持有，不等待
其它 server，不重新连接，不在 UI 增加轮询、延迟或自动重试计数。

```text
打开 App → session owner.ensureReady → 等待目标 MCP 现有 connecting
                            ├─ connected → 校验 session / lease / 连接身份 → 创建页面
                            └─ failed / owner 已释放或替换 → 拒绝创建
```

已有页面的同步身份校验不等待、不重连。连接失败仍显示错误并保留重新加载入口。
等待期间关闭或替换会话、释放 lease 或更换连接时，旧请求不得给新 owner 签发凭证。
Web / 手机 / remote 的不支持回退与 continuous / replayable 边界不变。

回归 `PLM-UI-SESSION-READY`：持久会话释放后，真实 Electron 面板与历史订阅同时重开；
用反向 runtime preferences 请求的响应闸门暂停恢复，断言页面保持 preparing、无 guest；
放行后无需重新加载即 running，只有一次恢复、一次资源读取和一个实例。CLI 回归另覆盖
并发打开共享恢复结果、恢复失败不创建实例，以及既有失效凭证仍立即拒绝。

该场景于 2026-10-30 经人工确认转正。正式入口为
`packages/desktop/test/e2e/plugins/runtime/plugin-ui-session-ready.test.ts`，复用受控 Electron
夹具的同一组断言，通过 `--session-ready-only` 单独运行；默认插件 glob 和现有桌面 CI
均能收集。Provider 使用本例合成响应和隔离数据目录，不访问真实账号或上游。
正式入口复用 WDIO 已构建的 Agent，避免重复构建耗尽用例预算；独立脚本默认仍从源码构建。
退出码与 `session-ready-results.json` 必须同时证明该场景执行成功，不能把只构建、零收集
或其它模式通过当成成功。Linux Docker 单例通过后，才能加入 `plugins-verified` preset。

回归 `PLM-UI-CONNECTION-READY`：真实 Electron 页面在 MCP initialize 被控制闸门阻塞时
保持准备中；放行后无需点击重新加载即可运行，且只创建一个实例。adapter / pool / 协议
单测覆盖失败、并发等待和 owner 失效。入口沿用 `--managed-only`。

## 页面声明与回收（2026-10-22）

仅 MCP UI 页面使用本策略；普通 Browser 和 Gen UI 不变。页面资源通过
`resources/read` HTML 内容项的 `_meta.ui.backgroundRetention: true` 申请后台保留；
未声明、false 或非法值均不申请。沿用资源 metadata 的读取规则，工具 metadata 不能授予保留。
声明随 Host 登记和 Main 句柄回到 renderer，不依赖插件名称或会话执行状态。

```text
成功 UI 结果 / 手动打开 → 唯一 page owner → 读取页面资源声明 → 创建 guest
                                                ├─ 未声明：隐藏并节流 → 离屏 5 分钟且不忙 → 回收
                                                └─ 声明 true：后台可执行 → 超过 4 个且闲置 30 分钟 → 回收
任务删除 / 重载 / runtime 失效 / 窗口关闭 ───────────────────────────────→ 强制释放
```

- 未声明页面恢复连续离屏五分钟与既有容量回收，隐藏容器使用 `display:none`，不申请
  capturer 活动。能力握手前临时提供不可交互的非零承载面，让 Electron 首次挂载 guest；
  握手后立即按可见锚点/隐藏策略布局，不保证离屏后依赖 rAF 的内部工作继续运行。
- 声明页面在保留期间使用非零尺寸 inert 后台表面和目标 guest capturer；只维持该页面，
  不设置全窗口 `backgroundThrottling:false`。隐藏/最小化窗口也按后台计算。
- 每窗口只统计已创建、声明保留且当前不可见的 MCP 页面。超过 4 个时，按最久未活跃优先，
  回收至少 30 分钟未活跃且不忙的页面，直到剩 4 个或没有合格候选。4 是软阈值；
  最近活跃、可见或正在工作的页面不因该阈值强制关闭。30 任务 / 64 活页面准入上限保持。
  容量压力不能跳过声明页面的 30 分钟保护；无合格候选时拒绝新建。
- `PluginUiBackgroundRetention` 是 MCP 保留时间与定时器的唯一 owner；窗口级容量仍归
  `PluginUiPageManager`。Gen UI 不加入保留队列，也不改变其五分钟/容量行为。
- 可见期间不回收，离开可见状态刷新活跃时间。新的模型工具调用/结果、App-provided tool
  执行与 sampling 刷新活跃时间；同一结果重复投影不刷新。页面自主 resources/read、
  tools/call（可能是长轮询）、心跳、绘制和大小通知不刷新活跃时间；在途调用仍按原 busy
  和 Agent 原子 `onlyIfIdle` 裁决保护。用户在页面内的交互由可见期保护覆盖。
  长轮询实际交付业务任务时，结果可声明 `_meta["zcode/activity"]: true`；宿主在清除调用 busy
  之前续期。空轮询不声明。Craft 单次业务操作已有 120 秒上限，交付时续期覆盖其执行期，
  避免轮询刚结束、页面尚未开始计算的间隙被当作过期空闲。
- 期限到达、可见性/业务活动/忙闲变化或页面增减时重新评估。使用一个最早到期定时器，
  不用固定轮询。串行回收，每次异步完成后重新读取当前数量与候选；删除的实例不得复活。
- 回收沿用 `tryRecycle → dispose → guest / feed / lease 释放`，不是冻结内存。保留宿主已接收
  的 widgetState，重新打开时创建新 guest 并重新握手；未提交的内存编辑状态会丢失。
  任务删除/任务容量淘汰仍按原规则清除整个任务 owner 与 widgetState。
  Agent 拒绝回收时保留原页面；等待裁决期间重新打开，完成释放后由同一 owner 重建。
  恢复意图读取现有展示锚点，不依赖旧 guest 的可见状态。
  窗口恢复时同样按锚点重建被回收的当前页面。
- 成功结果仍可在无卡片挂载时创建；相同逻辑键共用准入 Promise，后台结果不抢展示焦点。
  已回收页面遇到新的实际工具结果可以重建，重复结果不重建。历史 hydration 不批量创建。
- Web / 手机 / remote 仍不创建本地沙箱；声明不会改变 continuous / replayable 边界。

## 回归契约

使用真实 Electron、生产 page owner、Agent 和显式声明保留的受控 MCP 页面验证：

| 场景                     | 必须断言                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------- |
| 工具结果到达前切离会话   | 无工具卡片、无 conversation 订阅时由真实 Agent 结果创建；后台完成工作，返回复用 guest |
| 无锚点 / 隐藏 tab 冷启动 | session 空闲时完成握手后多帧初始化，页面尺寸非零                                      |
| session 空闲 / 停止回合  | 页面内部 rAF 工作仍能完成，无需新模型回合或宿主工具调用                               |
| 窗口最小化               | 后台操作完成；恢复展示后 guest 身份和编辑状态不变                                     |
| 离屏期限 / 容量压力      | 声明页受 4/30 规则保护，未声明页五分钟回收                                            |
| 原生隔离                 | 不唤醒未申请活动的旁路 guest；错 owner / 旧 initId 被拒绝                             |
| 隐藏与恢复               | 后台表面不接收鼠标，内联滚动不漂移，恢复后可正常显示                                  |
| 删除 / runtime 失效      | 活动、guest 和租约释放，迟到事件不复活                                                |
| Web / remote             | 不创建本地沙箱，不产生额外订阅                                                        |

入口：`node packages/desktop/scripts/mcp-apps-host-e2e.mjs --background-only`；
既有生命周期与回退使用 `--managed-only`。真实插件验证直接使用声明后台保留的 PhotoCraft：
`ZCODE_PHOTOCRAFT_SERVER=/path/to/photocraft/dist/server.mjs node packages/desktop/scripts/mcp-apps-host-e2e.mjs --photocraft-background-only`。
macOS Electron 已验证：宿主先最小化再首次创建插件、后台初始化与编辑、跨离屏期限保留和恢复截图 `photocraft-restored.png`。
测试外壳的白底不是插件成功证据，必须结合实际命令结果和恢复截图；该夹具不覆盖商店安装路径。

回归 `PLM-UI-RETENTION`：默认/false/非法声明、五分钟销毁与 widgetState 重建；声明页
不满/等于 4 个超时仍保留，第 5 个加入后的 30 分钟边界、最旧优先、忙碌保护、活动延期、
轮询不续期、异步回收中删除/重新可见。纯时钟测试覆盖策略，`--managed-only` 真实
Electron 验证声明传递、默认销毁、重新打开与五页超额回收。普通 Browser / Gen UI 不改。

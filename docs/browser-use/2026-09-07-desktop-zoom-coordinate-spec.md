# Desktop 缩放下的 Browser Use 坐标契约

工单：ZCT-2096856609784438784。补充 responsive-browser-viewport spec 的缩放边界，不涉及模型视觉识别。

## 行为

- 自由尺寸模式中，viewport、截图像素、模型坐标与 DOM 坐标保持同一 CSS 像素单位。
- 固定 viewport 的 guest 布局补偿只在 renderer 完成，放大和缩小用同一公式：webview 布局按 `1 / desktopZoom` 缩放，再用 `scale(desktopZoom)` 合成回 frame。guest 的自然 viewport 因此在 CDP 是否 attach 时都等于目标 viewport。CDP metrics 只固定 CSS viewport 与截图 DPR，不带 `scale`；鼠标事件按 CSS 坐标原样下发（2026-10-16 起，见下文「CDP idle detach 后页面变大变小」）。
- 设置或重放固定 viewport 时，Main 将 guest page zoom 归一为 1，避免依赖 renderer 回调与 Electron zoom 传播的先后顺序。Desktop zoom 变化时 renderer 仍重发一次当前 viewport，让 Main 在同一串行边界再次归一 guest zoom。
- CDP idle detach 后，下一次截图即使已处于 viewport 队列内，也必须先恢复 metrics。截图临界区本身不等价于已经恢复 viewport；不得在重入时再次排队并等待自己。
- 固定 viewport 的普通截图在预览缩小或 Desktop 放大时读取 Main 的 `guest.capturePage()`，再归一到 CSS 尺寸。renderer 上报 `surfaceScale=1` 只表示预览布局比例，不能证明 CDP raster 覆盖完整 viewport；clip / fullPage 仍由 CDP 执行。
- 普通截图准备层的尺寸不能超过宿主可见窗口，并临时派生 Fit 预览；用户选择 100% / 200% 时也必须如此。否则 Windows 高 DPI 下 Chromium 的 guest raster 裁剪会造成图片缺边，随后归一化会把缺边误当成完整画面拉伸。临时准备层不修改用户的 viewport 或预览缩放偏好，释放后恢复原比例。录制的 `unscaled` 请求保留原有布局与 100% surface 契约。
- 保持现有 idle detach、guest 生命周期、workspace/session 隔离以及 desktop-continuous / web-remote-replayable 路由边界。修改只发生在共用 guest 执行端。

```text
Desktop zoom -> renderer: webview 布局 ×1/zoom + scale(zoom)   (自然布局 = viewport)
             -> viewport mutation -> CDP metrics(无 scale) + guest zoom=1
                                         |
CSS 输入 (x,y,delta) ----------------------v
                                  原样下发
                                         |
                                         v
                           Chromium -> 原 CSS 坐标事件

CDP idle detach -> 下一条截图 -> 恢复 Page / metrics / guest zoom
                                         |
                                         v
                     窗口内临时 Fit（保留用户偏好）
                                         |
                                         v
                      Fit < 1 或 Desktop zoom > 1
                            /                 \
                          是                   否
                          |                    |
                  native capturePage       CDP capture
                          |                    |
                          +--- CSS 尺寸归一 ---+
```

## 回归

### CDP idle detach 后页面变大变小（2026-10-16）

现象：应用放大一档、内置浏览器处于自由尺寸（含 Agent `newTab` 带出的 1280×720）时，Browser Use 每次操作期间页面变大，命令空闲约 1.5s 后变回。普通模式不受影响。

根因：放大档的布局补偿原先只放在 CDP metrics 的 `scale` 里，而 metrics 是 per-session 状态。为防 UAF 加入的命令空闲 detach 会让 Chromium 清掉它，空闲时 guest 退回 webview 的自然布局（renderer 不做放大补偿，guest zoom=1），innerWidth 变成 `viewport × desktopZoom`。缩小档早就在 renderer 做 `1 / zoom` 布局补偿，所以两态一致。

```text
修复前（zoom=1.1，viewport=1280）
  命令期  CDP attach -> metrics(1280, scale 1.1) -> innerWidth 1280
  空闲    idle detach -> metrics 清空 -> 自然布局 -> innerWidth 1408   <- 来回跳
修复后
  renderer: webview 布局 ×1/zoom + scale(zoom) -> 自然布局 innerWidth 1280
  命令期 / 空闲都是 1280；metrics 只固定 CSS viewport 与 DPR，不再带 scale
```

独立 Electron 41.0.3 实验（macOS，Retina）：布局 `vw / z` + `scale(z)` 时，z=1.1 / 1.21 / 0.9 的 guest innerWidth 都等于 vw，右、下边缘色块完整，没有留白；原放大档布局分别得到 `vw × z`。2026-07-22「放大时 transform 只扩大 webview DOM 而 raster 留白」的结论只对“不缩布局、只加 transform”成立，不适用于本方案。

保持不变：idle detach、CDP 恢复屏障、guest zoom 归一、截图 prepare/release 与 `natural | emulated` 区分。Desktop 放大时普通 viewport 截图仍走 native capture + CSS 归一（Windows 平铺缺边的既有防护）。`appliedViewportScale` 与鼠标输入倍率随 metrics scale 一起删除。

回归：缩放坐标 E2E 每轮在 idle detach 后、首条命令前读取 guest innerWidth/innerHeight，必须等于 1280×720；manager 单测断言放大档 metrics 不带 `scale`、输入坐标不乘倍率；UI 单测断言放大档 webview 布局为 `1 / zoom`、transform 为 `zoom`。

### Guest 换代后的倍率清理（CR-01）

> 2026-10-16 起 metrics 不再带 scale，本节描述的倍率状态已删除，保留作历史。

`appliedViewportScale` 是当前 guest 已安装 CDP metrics 的镜像，不能随逻辑 tab 跨 guest 换代保留。普通后台 fallback 在应用放大时安装倍率；旧 guest 销毁或被替换后，新 guest 若使用自然 viewport，不会重放 metrics，残留倍率会把 (300,200) 错发为 (330,220)。

在 `detachGuest` 与 fallback 状态一起清除已应用倍率。旧异步 mutation 的 guest 不匹配分支继续只返回，不得清除新 guest 的有效倍率。普通 CDP idle 重连沿用已有 metrics 重放屏障，不增加新的状态或恢复机制。

```text
旧 guest + fallback scale=1.1 -> detachGuest 清理倍率 -> 新 guest 自然 viewport -> 输入原坐标
```

manager 回归覆盖 fallback 安装后直接替换、destroyed 回调及再次 CDP 重连，修复前两条测试都将 (300,200) 错发为 (330,220)，修复后通过。真实 Electron 沿用缩放 E2E，增加普通模式 guest 崩溃重建、恢复前台并点击的回归。macOS 隐藏 guest 仍可能保留自然尺寸，已安装的 fallback 也可能被前台恢复清除，因此原生 E2E 仅证明真实重建和点击链路不回退，不声称完整复现旧倍率残留；后者由 manager 定向测试证明。固定 viewport、自然截图及 Windows fallback 原有回归继续保留。

2026-09-08 验证：129 条 manager 单测通过；macOS arm64 / Electron 41.0.3 原生 E2E 4 case 通过（run `desktop-e2e-20260908-055435-369`，8 PNG / 20 次 trusted click）。新增场景 guest 2 → 3，viewport 保持 368×573 / DPR≈2.2，点击 (100,200) 实际落点也是 (100,200)。产物在该 run 的 `zoom-coordinates/guest-recovery.{json,png}`。typecheck、lint（43 个既有 warning）、E2E 类型与 fixture 检查通过；本次未重跑 Windows/Linux、手机远控，E2E 仍待人工 review。

### 普通前台自然 viewport 截图（2026-09-08 macOS 复现）

在 `4b9c4d51a0` 的真实 ZCode dev / macOS 上，退出自由尺寸并将应用缩小两档（zoom≈0.826446），通过产品 Node REPL 的 `tab.screenshot()` 复现：截图前 viewport 为 508×855，prepare 期间变成 614×1034，release 后恢复 508×855。页面 media query 因此把按钮中心从 (100,200) 移到 (200,200)；截图后的 trusted click (200,200) 未命中，而 (100,200) 命中。

根因：自然 viewport 没有 CDP metrics 固定逻辑尺寸，却复用了仿真 viewport 的 `1 / desktopZoom` guest 布局扩张。ready 再除以 layout scale 后看似匹配，页面实际已经发生 reflow。

Main 在截图临界区按实际 viewport 状态显式传递 `viewportMode: natural | emulated`。普通前台自然 viewport 仍按请求尺寸临时 Fit，但 guest 不扩张、不做反向 transform；自由尺寸和后台 fallback 保留仿真布局补偿。旧 payload 缺失该字段时保持 emulated 行为，录制 unscaled 契约不变。不同 viewport mode 不共用准备 lease，ready 必须回传匹配的 mode。

```text
Main viewport 状态 -> prepare(request.viewport, viewportMode)
  natural  -> 临时 Fit frame -> guest 原布局 -> capture -> release
  emulated -> 临时 Fit frame -> guest 缩放补偿 + CDP metrics -> capture -> release
```

回归必须经过真实 Browser Use 链路，记录截图前、resize 事件及释放后的 viewport / DPR / media query 目标位置，检查 PNG 中目标的实际位置和随后的 trusted click。自然模式保持原 guest、原 zoom 与用户偏好。已有自由尺寸五轮缩放、普通后台 fallback、录制 unscaled 回归继续执行。此改动只增加 Main/renderer 瞬时布局元数据，不改变 Agent 协议、Host 路由、手机远控 attachment 或 continuous/replayable 边界。

本次 macOS arm64 / Electron 41.0.3 验证通过（run `desktop-e2e-20260908-042444-192`）：新增自然模式场景 viewport 始终为 531×815，没有截图引起的 resize，按钮保持 (100,200)，PNG 色块与 trusted click 一致；既有自由尺寸五轮和普通后台 fallback 一并通过，共 3 个 case、7 次截图、19 次 trusted click。244 个相关单测、typecheck、E2E 类型检查、lint（43 个既有 warning）和 fixture check 通过。证据与平台边界见 [macOS 验证记录](../testing/browser-natural-viewport-macos-regression-2026-09-08.json)。Windows/Linux、手机远控和原生录制未重跑；E2E 继续保留 pending。

### 普通模式后台 fallback 截图（2026-09-08 P2）

后台普通模式可能保留大于当前窗口的 fallback viewport。仅限制准备层尺寸并传入 Fit 不足以启用 responsive 布局；webview 仍随容器缩小，ready 无法匹配请求尺寸。所有截图 prepare 都必须临时启用 responsive 布局并采用 `request.viewport`：普通截图用 Fit，录制仍为 100%。释放后恢复原模式、逻辑尺寸和预览偏好，保持同一 webview / guest，不写入用户设置。

```text
普通后台 tab + 缓存 viewport -> 小窗口 prepare
  -> 临时 responsive(request.viewport) -> Fit -> ready -> capture
  -> release -> 原普通模式 / 原偏好 / 同一 guest
```

回归覆盖宽度受限和高度受限的组件布局探针、真实 Electron 的后台普通 tab 缩窗截图及 release；既有自由尺寸缩放 E2E 和录制 unscaled 单测继续执行。

临时 responsive 布局不等同于用户进入自由尺寸模式：普通后台 fallback 的 guest zoom 继续由 main 的 metrics 生命周期管理，release 不得恢复成 desktop zoom。组件回归检查非 100% 应用缩放下 prepare/release 不修改 guest zoom；原生回归在 110% 应用缩放下保持 CDP attach，释放后不重装 metrics，检查 viewport、guest zoom 与连续三次 trusted click。

原生复现还表明：普通 fallback 未带应用放大补偿时，ready 虽然通过，PNG 色块仍缩至坐标的 `1 / desktopZoom`。fallback metrics 必须从 guest 所属 renderer 读取应用 zoom，复用自由尺寸的 CDP scale 与输入边界换算；初次安装、idle 重连和再次截图均保持一致。应用缩小不增加 metrics scale，guest zoom 保持 1，回到前台仍清除 fallback 恢复自然布局。

1. 同一 guest 在 100% -> 110% -> 100% -> 缩小 -> 放大之间切换，Fit / 100% / 200% / 50% 预览都覆盖；固定按钮中心 (300,200)、(600,400)、(1000,600) 的真实 trusted click 均命中，PNG 色块中心与事件坐标误差都不超过 1 CSS px。
2. 每轮先等待 CDP idle detach，以截图作为重连后的首个命令：PNG 必须为 1280×720，页面 viewport 为 1280×720，guest zoom=1；截图内容位置与点击位置一致。
3. 单测覆盖鼠标路径、wheel delta、tab 隔离、缩放重置与 detached 截图恢复顺序；真实 Electron E2E 验证 Chromium 的实际事件与图片像素。
4. 运行 pnpm typecheck、pnpm lint、受影响单测；各平台验证必须注明版本、DPI 和实际执行范围，不把历史验证当作当前补丁已验证。
5. Windows 原生回归必须同时核验 PNG 内容与 trusted click，不能仅凭图片尺寸和 DOM 命中判通过；每轮在断言前保存 PNG、页面坐标、颜色采样以及 Electron/系统/display scale 信息，失败轮也保留证据。
6. 截图结束后 `preparing` 层必须消失，实际 `responsiveScale` 必须恢复为用户选择的 1 / 2 / 0.5；只检查下拉框文字不能证明 release 链路已完成。录制 unscaled 布局与偏好恢复继续由对应单测约束。

## Windows 补充回归

2026-09-07 在 Windows 11 x64 / Electron 41.0.3、系统显示缩放 125% 上复现：100% 通过，110% 时 PNG 尺寸和点击断言通过，但 CDP 将较小 native raster 周期平铺，第三个按钮中心为白色。修复沿用已有 native capture + CSS 归一化路径，把 Desktop 放大也纳入选择条件，不增加截图重试或放宽像素断言。

红灯证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20260907150411437-p10372-00512ee1039753cb/zoom-coordinates/round-1.png`；新增 `surfaceScale=1` 单测在修复前返回 CDP 的 PNG，修复后读取 native PNG。每轮证据保存在 run artifact 的 `zoom-coordinates/`，包括 PNG、页面 viewport/DPR/trusted events 和 native 颜色、平台、Electron/Chromium、display scale 元数据。

200% DPI + Desktop 110% 另复现原生 PNG 为 2747×1584（完整尺寸应为 2816×1584），归一后按钮 x=1000 变为约 1025。Chromium 根据宿主 viewport 逆变换并扩展 30% 计算 guest compositing rect，超出范围的内容不会进入 raster。独立 Electron 实验只将窗口宽度 960 DIP 改为 1000 DIP，PNG 宽即由 2721 恢复至 2816，高度不变，确认是可见范围裁剪。准备层宽高以 `100vw` / `100vh` 为上限，使 Fit 使用可见窗口内的画布；不通过改用户窗口大小、延时重试或非等比拉伸补偿坐标。

影响边界：Main 的普通 viewport 截图选择和 renderer 的临时截图准备层；没有新增协议、host、runtime 或持久化状态。手机 Web 在没有 native prepare 请求时沿用原预览；远控请求仍由已有 attachment 路由到同一桌面 guest，不改变 continuous / replayable 语义。本次没有补做手机远控或原生录制 E2E；录制 `unscaled` 保持原分支行为并有单测保护。

## Windows P2 修复验证（2026-09-08）

基于 `28f297339ad2126fdd92e0e69277e432be9ae95a` 的本次增量：普通模式后台截图临时布局、guest zoom 释放边界，以及 fallback metrics 的放大补偿。旧构建原生红灯 run `desktop-e2e-20260908-024203-610`：请求 1280×720，960×600 窗口中实际 webview 为 960×552、模式 inactive，3000ms prepare 超时。

| Windows 显示缩放 | 最终构建结果       | Artifact run ID                   |
| ---------------- | ------------------ | --------------------------------- |
| 系统原生 125%    | 两个 case 全部通过 | `desktop-e2e-20260908-025710-354` |
| forced 200%      | 两个 case 全部通过 | `desktop-e2e-20260908-031302-774` |

每档保留原有五轮应用/预览缩放截图与点击，增加一轮普通后台 960×600 窗口、应用 110% 的 prepare/capture/release，合计 12 次截图、36 次 trusted click。新增场景 ready 保持 1280×720，截图三个目标色块正确；release 后保持同一 guest、普通模式、guest zoom=1 和 1280×720 viewport，连续三次点击最大误差 1px。

新增原生场景直接使用生产 prepare/ready/release IPC，注入 fallback metrics，再执行真实 native capture 和 CDP 输入；没有模拟 DOM 尺寸或 ready，但不代表 manager fallback 缓存建立的全链路 E2E。manager 单测另外验证初次 fallback、热态放大、idle 重连、reset/缩小、native 路径选择及输入补偿。机器可读证据见 [本次验证记录](../testing/browser-normal-fallback-windows-regression-2026-09-08.json)。

340 个相关单测、`pnpm typecheck`、`pnpm lint`（43 个既有 warning、0 error）、E2E 类型与 fixture 检查通过。100%/150% 显示缩放仅有下述前一提交记录；本次未重跑 macOS/Linux、手机远控或原生录制。Web 无 native prepare 时不改变布局；远控仍路由同一桌面 guest，continuous/replayable 边界不变。录制 unscaled 行为由既有单测保护。此 case 仍处于 manual-review/pending，合并/发布时须保留以上覆盖限制。

## Windows 验证矩阵（2026-09-07，前一提交）

Windows 11 x64（10.0.26200）/ Electron 41.0.3 / Chromium 146.0.7680.80。以下均为最终补丁与加强后的同一 case；每档 5 轮、15 次 trusted click、5 张 PNG，合计 20 轮 / 60 次点击。所有 PNG 和 guest viewport 均为 1280×720，页面 DPR=1、guest zoom=1，同一 guest 保持不变；图片色块中心最大误差 0 px，真实点击最大误差 1 px，截图 release 和预览恢复均通过。

| Windows 显示缩放 | 执行方式                                | 结果 | Artifact run ID                   |
| ---------------- | --------------------------------------- | ---- | --------------------------------- |
| 125%             | 系统原生显示缩放                        | PASS | `desktop-e2e-20260907-153516-455` |
| 100%             | Chromium forced device scale factor 1   | PASS | `desktop-e2e-20260907-153630-178` |
| 150%             | Chromium forced device scale factor 1.5 | PASS | `desktop-e2e-20260907-153744-604` |
| 200%             | Chromium forced device scale factor 2   | PASS | `desktop-e2e-20260907-153901-372` |

逐轮平台信息、viewport、DPR、坐标误差和 PNG SHA-256 已提交至 [机器可读验证记录](../testing/browser-zoom-windows-regression-2026-09-07.json)。原始 PNG / JSON 在 `packages/desktop/.e2e-artifacts/<run ID>/zoom-coordinates/`。

本补丁验证：336 个相关单测、全量 `pnpm typecheck`、`pnpm lint`（43 个已有 warning、0 error）、E2E 类型检查和 case-local fixture check 通过。类型检查在临时隔离原有、无关的工作区改动后执行；这些改动不属于本次提交。

覆盖限制与合并/发布检查：本次解决 SG-01 的 Windows 缺口，Linux 按本次任务范围未执行；macOS 只有下述历史基线结果，不能据此把当前补丁标为三平台通过。E2E 继续保留在 `manual-review/pending`，尚未纳入自动 CI gate；合并/发布记录须保留以上平台限制，宣称 macOS/Linux 验证通过前须在对应平台重跑。单机 forced DPI 不等于多显示器跨屏实测。

## 历史基线验证（2026-09-07）

原分支 `8a669c3b9279bf3bf55d2ae7adbe5239c7644b94` 的 macOS arm64 / Electron 41.0.3 记录：case-local 模型回放驱动真实 Node REPL -> Host/Main -> Chromium，单 guest 连续 5 轮 0/+1/0/-2/+2，Fit/50% 下 15 次 trusted click 全命中，最大误差 1 px；PNG 均为 1280×720，按钮像素坐标一致，guest zoom=1。206 个相关单测、typecheck、lint（43 个已有 warning）、E2E 类型检查和 fixture check 通过。本次 Windows 补丁尚未在 macOS 重跑。

## Windows 执行方式

在仓库根目录的 PowerShell 中设置 case-local replay；仅模型决策回放，Electron / guest / compositor / CDP / trusted input 均为真实执行：

```powershell
$env:ZCODE_E2E_MANUAL_REVIEW = '1'
$env:E2E_PROVIDER_HTTP_MODE = 'replay'
$fixtures = Join-Path (Get-Location).Path 'packages/desktop/test/e2e/fixtures/deepseek'
$env:E2E_PROVIDER_REPLAY_FIXTURE_PATH = "$fixtures/common.json,$fixtures/conversation-session/conversation-session-browser-zoom-coordinates.json"
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/browser-use/conversation-session-browser-zoom-coordinates.test.ts'
```

DPI 扩展运行在同一 Windows 原生 Electron 上使用 `--force-device-scale-factor=1/1.5/2`，不代表三台不同物理 DPI 的机器。可在 `packages/desktop/.e2e-artifacts/browser-zoom-dpi.wdio.ts` 放置以下临时配置，再用 `pnpm --filter @zcode/desktop exec wdio run ./.e2e-artifacts/browser-zoom-dpi.wdio.ts --spec <上述 spec>` 执行：

```typescript
import { config } from "../wdio.conf.js";
const scale = Number(process.env.ZCODE_ZOOM_TEST_DPR);
if (![1, 1.25, 1.5, 2].includes(scale)) throw new Error("Expected DPI scale 1/1.25/1.5/2");
for (const capability of config.capabilities as Array<Record<string, any>>) {
  capability["wdio:electronServiceOptions"].appArgs.push(`--force-device-scale-factor=${scale}`);
}
export { config };
```

已有本分支构建时可设置 `ZCODE_E2E_SKIP_BUILD=1`、`ZCODE_E2E_SKIP_AGENT_BUILD=1`；renderer 必须使用 `VITE_ZCODE_E2E_STORE_BRIDGE=1` 构建。`pnpm typecheck` 的 host 输出与 tsup bundle 共用 `out/host`，必须与原生 E2E 串行；typecheck 后若再跑 E2E，应重建 tsup，不能复用被 tsc 覆盖的 host bundle。

# macOS 字体平滑

设置 → 外观 → 界面字号下方显示「字体平滑」开关，仅 macOS 桌面端可见，设置搜索使用相同可见条件。默认开启（未保存及无效值均视为开启，已保存的关闭选择保持关闭）。关闭不设置字体平滑属性，由系统决定；开启应用 `-webkit-font-smoothing: antialiased`。不是关闭所有抗锯齿，不使用 `none`。

说明：开启后使用灰度平滑，文字可能显得更细。效果因显示器而异。

不添加独立字体预览行。切换立即生效，无须重启，主题切换不改变偏好。仅改变当前应用 DOM 文字的平滑，不承诺影响 Canvas、终端、PDF 或嵌入网页自身的渲染。

## 状态与平台边界

```text
开关 → 本机 UI Store → 本机 localStorage
                  ├→ 根元素展示标记 → 仅 macOS desktop CSS 生效
                  └→ state: 广播 → 本机其他窗口 Store（防回环）
重载 → 读取同一本机偏好 → 恢复展示标记
```

复用既有 Store 的偏好持久化与 BroadcastService，不写 Host 设置、不同步账号、不通过远控协议投递。非 macOS 桌面（含 Web/手机）即使存在该存储值或收到相同广播也不应用字体平滑，不显示入口。CSS 以本机 renderer 的 `platform-mac-desktop` 标记作为生效边界，不使用远端 Host 的 OS。

## 验收

- macOS 桌面：默认开启、开启/关闭即时改变计算样式、重载保留、设置搜索可定位。
- 本机多个窗口：变化跟随同一偏好，收到广播不再次发送。
- Windows/Linux/Web：入口隐藏，遗留偏好不影响计算样式。
- 中英文、深浅主题、窄布局均可操作，说明文字不横向溢出。
- 桌面候选用例 `settings/appearance/manual-review/pending/macos-font-smoothing.test.ts`；浏览器验收只证明组件及平台标记隔离，不等同其他操作系统 GUI 或实机手机。

已验证：macOS 桌面运行 `desktop-e2e-20261111-082725-093` 1/1 通过，覆盖默认开启、设置搜索定位、关闭及重载。浏览器验收覆盖真实 Store 和外观组件的开关、多窗口广播防回环、主题/语言/宽度以及非 macOS 平台标记隔离；未测试其他操作系统 GUI 和实机手机。

可重复命令（本场景不调用模型）：

```bash
node --test packages/ui/test/browser/manual-review/pending/font-smoothing.test.mjs
E2E_PROVIDER_HTTP_MODE=replay E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/settings/appearance/manual-review/pending/macos-font-smoothing.test.ts
```

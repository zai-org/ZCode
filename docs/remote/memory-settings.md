# 按设备设置工作区记忆

## 行为

- 桌面「设置 → 记忆」复用其他设置页的设备分组 Scope 菜单、图标、选中态与键盘交互。
- 记忆开关是设备级设置，只列各设备的「用户」，不列项目。默认选择当前项目所在设备；本机始终可选，远端仅列已连接设备。不要求在该设备打开项目。
- 选择本机读写 base Local Host 的 `settingService`；选择远端读写既有 source-settings attachment 的 `settingService`。不新增 Server RPC，不同步两端开关。
- 加载时不显示上一个设备的开关。保存期间禁用开关，以服务端确认的结果更新；失败显示错误，不显示保存成功。每次请求绑定发起时的服务，迟到结果不得覆盖新设备。
- 选中的远端断开时，保留目标名称并显示共用离线提示，隐藏开关；不回退本机。用户可手动选本机，远端重连后可重新选择。
- 本机手动修改仍回写本机 onboarding record；远端不修改本机引导记录。
- `memoryEnabled` 缺省为 false。新建根会话及真正 cold resume 读取最新值，已有 Runtime、fork 和子智能体保持原有继承规则。
- 记忆文件查看仍限本机桌面；选择远端只显示开关及远端详情暂不可用的说明，不读取本机 catalog 冒充远端。文件同步不在本次范围。
- Web / 手机沿用当前 Host 的开关与本地桌面查看提示，不申请新的 source-settings attachment。

```text
共用 Scope owner → 选中设备 → 本机 base / 远端 source-settings
                                  │
                                  ├─ setting.get → 开关
                                  └─ setting.update → 该设备 setting.json
                                                       └─ 新建 Runtime 读取
设备离线 → 共用 blocked notice（无读写）
```

## 验收

`MEM-DEVICE-01`：真实 SSH Docker 目标；菜单与其他设置页一致、只有设备用户选项；远端默认值、启停与本机值隔离；切换和重进页面正确读回；本机记忆文件仍可查看，远端不混入本机文件。

`MEM-DEVICE-02`：远端选中时断线，隐藏开关、保留远端目标、允许切到本机；恢复连接后读回远端已保存值。

`MEM-DEVICE-03`：本机/远端切换期间不得展示前一设备值；保存失败时原值不变、允许重试；桌面宽窄窗口、浅深主题下菜单及开关可达。

用例位于 `packages/desktop/test/e2e/conversation-session/remote/configuration/manual-review/pending/conversation-session-remote-memory-settings.test.ts`，按 `remote-docker-verify` 运行，另回归 SSH P0、既有 R3 设置 Scope 和本机 Memory 用例。候选保持 pending，执行证据见覆盖矩阵。

手机浏览器验收：`pnpm exec tsx packages/desktop/test/e2e/settings/agent/manual-review/pending/memory-settings-mobile.mjs`。真实记忆组件通过 WebSocket RPC 写入两套隔离的 SettingService；覆盖 390 / 768 宽度及 Zai Light / Dark，断言当前 Host 写入、另一端不变、不显示桌面设备菜单、不读 catalog。此项不冒充实体手机或真实 relay 配对验证。

## 验证记录（2026-11-04）

- 路径 A：本机 macOS arm64，Docker SSH 容器 `uname -m = aarch64`。
- 基线 UI（`cbde5bb2ed710532f37dd9cce275539bb1a343ea`）：`local-docker-20261104095919-36f094`，首例在缺少 `settings-memory-device-trigger` 处失败，确认能检出原问题。
- 首轮实现：`local-docker-20261104100532-71e0fd`。MEM-DEVICE-01/02 与本机 Memory 会话回归通过。其余用例暴露测试菜单打开操作、旧记忆页无 Scope 等待条件、P0 以显示名查项目的问题；后续使用既有 pointerdown 菜单操作，更新 Scope 预期，P0 改按稳定 workspace identity 校验归属。
- 复跑：`local-docker-20261104101204-57bef5`，3 个 spec、5 个用例全部通过；包含 MEM-DEVICE-01/02/03、SSH P0 和 R3 Scope。命令如下：

```sh
ZCODE_E2E_MANUAL_REVIEW=1 node harness/remote/run-local-docker.mjs \
  packages/desktop/test/e2e/conversation-session/remote/configuration/manual-review/pending/conversation-session-remote-memory-settings.test.ts \
  packages/desktop/test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-p0.test.ts \
  packages/desktop/test/e2e/conversation-session/remote/configuration/conversation-session-r3-settings-scopes.test.ts
```

菜单展开视觉复核：`local-docker-20261104101729-fe23eb`，新增 3 例再次全部通过。截图前明确断言菜单处于展开状态，已复核中英文、宽窄窗口及深浅主题；截图位于该 run 的 `memory-devices/`。

各 run 的报告位于 `packages/desktop/.e2e-artifacts/<runId>/summary.json`。手机浏览器截图位于 `packages/desktop/.e2e-artifacts/memory-settings-mobile/`。

类型检查、E2E 类型检查、Lint、架构检查、夹具检查、coverage audit 和远程目标清单检查通过；Lint 的存量告警不在本次范围，本次记忆组件没有 Hooks 告警。远程目标清单工程测试 8/8 通过；手机浏览器两端隔离场景均通过。

同机 Docker 不覆盖真实跨机网络、Windows 开发机、VPN 或 live 账号。用例保持 pending，不做人工转正或 CI 准入声明。

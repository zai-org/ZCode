# v3.17.2 → 85f44599309 远程改动 E2E 验证记录（2026-11-04）

## 范围与结论

- 范围：`v3.17.2..85f44599309` 中远程、手机远控、数据同步、server-cli 与设置页的 36 个提交。
- 结论：
  - 本次改动全部在真实链路上生效：新增或修改的用例全部通过。
  - 没有发现本次改动引入的回归。SSH p0、连接、重连、更新、安装与手机等已有远程用例全部通过。
  - 没有确认任何业务代码 bug。
  - 跑测时发现的失败都属于测试环境或用例问题，已修复 5 项，见“测试环境与用例修复”。
  - MP-UI-06 在 v3.17.2 基线上同样偶发失败，不是本次引入，根因未确认，见“未决项”。

## 环境

- 开发机：macOS arm64，Docker 29.4（OrbStack）。
- 路径 A：`node harness/remote/run-local-docker.mjs <spec...>`。容器镜像 `zcode-remote-ssh:test`，`uname -m` 为 `aarch64`。
  old-glibc 用例使用 `zcode-remote-ssh:glibc227`（ubuntu 18.04，glibc 2.27）。
- 本地 UI 与 AUTH 用例使用 `node scripts/run-windows-e2e-shards.mjs --spec <spec>`，即 `pnpm test:e2e` 的入口。
- 工件：`packages/desktop/.e2e-artifacts/<runId>/summary.json`。
- 改动生效的证据中，“改动前失败”部分沿用各提交记录的复现 runId，本轮只重跑改动后的版本。
  release 清理是例外，本轮对旧包和新包做了对照。

## 新改动生效

| 提交 | 场景 | 结果（runId） |
| --- | --- | --- |
| `d05431d3fa7` `202c85eb886` | R3-UPDATE-INFLIGHT-01/02/03/04 | 4/4 通过（`local-docker-20261104155833-28af99`） |
| `93b8662c5a6` `9a623c32416` `3a05c2e31e4` | R3-UPDATE-CANCEL-01/02/03/04 | 4/4 通过（`local-docker-20261104154835-5f2a60`） |
| `196b85d0fca` `34434f5e7df` `9f22d500daa` `fec20b2df2a` `f7e76d6f0f2` | RPN-18a/b、DRS-RR-11、RPN-19～24b | 11/11 通过（`local-docker-20261104154837-fcccf7`） |
| `e9ff0eda947` | 僵尸持锁接管（Docker transport） | 通过（`local-docker-20261104155948-129fb7`） |
| `5ba3a06761c` | crash-loop 详情、Supervisor 取锁失败原因 | 2/2 通过（同上） |
| `1b79b2d9c6d` | SSH-P0-LIFE-04 symlink 重连 | 通过（同上） |
| `6661d0c6d8b` `c62185bb1c4` | R3A-BLD-09 old-glibc-runtime（glibc 2.27 实机） | 通过（`local-docker-20261104161606-913bc0`） |
| `0bab7b0298f` | release 清理，手动容器探针（路径 B），见下 | 修复后保留 2 个，修复前增长到 4 个 |
| `a47355f234b` `3ac993b1a6b` | RDUX-13 / RDUX-13-02（含 `::1` profile） | 通过（`local-docker-20261104155834-d9d5a1`） |
| `2f406c1978e` | MEM-DEVICE-01/02/03 | 3/3 通过（同上） |
| `2f406c1978e` | 手机浏览器 MEM-DEVICE-MOBILE local/remote，390/768px，深浅主题 | 通过（`memory-settings-mobile.mjs`） |
| `09a44a38e14` `76b5538e4d5` `aa8136c1cfa` | DSYNC-09-01～05 | 5/5 通过（`local-docker-20261104160910-361164`） |
| `7cd54617545` | AUTH-09 | 通过（`desktop-e2e-20261104162730712-p89168-8767adab241ff745`） |
| `d8ffd0558c8` `7e61900cab3` | AUTH-09-R（离线 SSH 目标、手机、第 6 步弹窗） | 通过（`local-docker-20261104160911-648172`） |
| `142faf84612` `754f846c4e9` `06850cdb772` `bdf273ccd19` | MRO04 远端终端（`ZCODE_E2E_MRO04_REMOTE=1`） | 2/2 通过（`local-docker-20261104172748-c238d7`） |
| `b9ab416d23d` | status panel、v4 scroll、held queue | 通过（`desktop-e2e-20261104-160020-550`） |
| `8237935aa07` `ab66f1db2a3` `351e5a523a2` | 设置页窄屏、usage 图表、供应商标题 | US-AU-01～05、UP-00～02、MP-UI-01～05 通过（同上）；390px 截图正常 |
| `613750fb786` | `e2eConversationPreparation.test.ts` | 8/8 通过 |

### release 清理探针（`0bab7b0298f`）

在手动容器里以 `dev` 运行 `zcode update --from-archive`：A→B→C 离线更新，在 C 上启动 daemon，再在线更新到 D，最后重装 D。

- 修复后（3.17.1 包）：每次更新后 `releases/` 只剩 current 和 previous。重装同一 release 不清理。在线 handoff 后 daemon 仍为 `ready`。
- 修复前（3.16.3 包）：同样流程，`releases/` 增长到 4 个。

## 回归（已有功能）

| spec | 结果（runId） |
| --- | --- |
| ssh-remote-p0、ssh-remote-connection-p0 | 2/2（`local-docker-20261104154633-0b391c`） |
| ssh-remote-connection-management、banner-reconnect、ssh-disconnect-experience | 4/4（`local-docker-20261104162750-787898`） |
| ssh-remote-cold-reconnect（SSH-P0-LIFE-01） | 通过（`local-docker-20261104164223-0ab0ff`） |
| ssh-remote-three-screen（RDUX-10） | 通过（`local-docker-20261104165019-00c9b6`） |
| background-connection（RDUX15-19/20） | 通过（`local-docker-20261104170731-ca7dfe`） |
| r3-server-update cancel（R3A-UPG-03/04） | 通过（`local-docker-20261104165016-742545`） |
| r3-restart-remote-service（R3A-BLD-11） | 通过（`local-docker-20261104165017-8e20b9`） |
| r3-reinstall-damaged-release（R3A-BLD-12）、connection-log-contract | 通过（`local-docker-20261104162752-e107a4`） |
| remote-install-progress（RDUX-16） | 通过（`local-docker-20261104165021-e094c5`） |
| r3-settings-scopes（R3A-DEV-06） | 通过（`local-docker-20261104155834-d9d5a1`） |
| data-sync scope-by-device、device-connect | 6/6（`local-docker-20261104161916-ec041b`、`local-docker-20261104160910-361164`） |
| r3-mobile + r3-mobile-permission（同一次运行） | 3/3（`local-docker-20261104171310-6ad6ec`） |
| AUTH-08 session events | 2/2，另在高负载下重复 2 次均通过（`desktop-e2e-20261104171031422-p5045-c7a00e65e70ae741` 等） |
| 工程测试 r3LocalDockerRunner、remoteAssetHttpProxy、authGateFixture、sourceServerUpdateFixture | 全部通过 |

## 测试环境与用例修复

每项都先按失败工件查清原因再修改。修改不放宽断言。

1. **测试 CDN 环境串到其他 spec**（`harness/remote/remote-wdio-env.mjs`）
   - 现象：update-cancel 与 update-inflight 同一次运行时，INFLIGHT-01 首装报“资源下载失败”，02～04 连带失败。
   - 原因：测试 CDN 环境变量作用于整次 wdio。
   - 修改：测试 CDN 用例与其他 spec 混跑时，runner 直接报错。先补回归测试，确认失败后再改实现。单独运行 INFLIGHT 4/4 通过。
2. **并发 runner 共用模型回放抓包目录**（`harness/remote/local-docker.mjs`）
   - 现象：R3A-UPG-03/04 与 R3A-BLD-11 报“首发没有到达 provider”。抓包记录里出现了其他运行的 fixture（`ssh-cold-reconnect-*`、`r3-restart-remote-service-*`）。
   - 原因：wdio 默认把 `upstream-runtime.json`、`upstream-provider.json` 写到固定的 `.e2e-network-capture`，并发运行会互相覆盖。
   - 修改：按 runId 设置 `ZCODE_E2E_NETWORK_CAPTURE_DIR`。先补回归测试（red 后 green），再并发重跑两个用例，均通过。
3. **两份手机 fixture 互相抢匹配**（`conversation-session-r3-mobile.json`）
   - 原因：r3-mobile 的宽匹配 `E2E_R3_MOBILE_` 也会命中 `E2E_R3_MOBILE_PERMISSION_*` 请求，同一次运行时 R3A-MOB-01 与 R3A-MOB-04 都失败。
   - 修改：在 title/main 两条宽匹配中排除 permission 标记。修改后两份 spec 同一次运行 3/3 通过。
4. **RDUX-16 不认本机 runner 的容器名**（`conversation-session-remote-install-progress.test.ts`）
   - 原因：容器名正则漏掉了 `zcode-local-remote-`，用例第一行断言就失败。
   - 修改：补上这个前缀。修改后通过。
5. **RDUX15 三处不稳定**（`conversation-session-background-connection.test.ts`、`wdio.conf.ts`）
   - 原因一：点项目行“新建任务”后，鼠标停留触发项目悬停卡片，卡片盖住 composer 的项目选择器，导致点击被拦截。
   - 原因二：本机 `docker ps` 超过默认 5 秒才返回，找不到容器条目。
   - 原因三：Mocha 外层固定 120 秒，覆盖了用例内声明的 20 分钟预算，负载高时在 Docker 段被截断。
   - 修改：点击后移开鼠标并等卡片关闭；等待容器条目出现；外层超时设为 20 分钟。修改后通过。

文档：`harness/remote/README.md` 写明测试 CDN 用例必须单独运行。

另外两类失败是本轮运行方式造成的，不改代码：

- 直接调用 `wdio` 时没有建立隔离 HOME，AUTH-08 失败。按正式入口运行则通过。
- 两个手机 spec 并发运行时争用 5173 端口。

## 未决项

### MP-UI-06（settings-ui-polish）偶发失败：基线原有问题，根因未确认

- 现象：同一个用例在 4 个不同的断言上失败。共同点是点击或打开模型编辑弹窗后，立即读取，读到的是旧状态：
  - 跟随推荐开关点击后，Mapping 没有清空（第 1110 行）。
  - 关闭跟随并保存后重新打开，开关仍是 `true`（第 1104 行）。
  - 视觉能力按钮点击后不是 pressed。
  - 打开后推理档位编辑器不可见（第 784 行）。
- 频率：HEAD 低负载 1/3；v3.17.2 基线 1/5（runId `desktop-e2e-20261104173103390-p7730-f384bd2659eed5dc`）。
- 与本次范围的关系：本范围对 `model-provider-section/` 只改了 `ProviderFamilyHeader` 的 `h-8 → min-h-8`，加上基线也会失败，所以不是本次引入的。
- 已排除：Host 侧 `savePersonalModelDraft` / `resolveModelConfig` 的顺序和耗时在通过与失败两次运行中一致。外部 View 刷新不会重置编辑草稿（`editingModel` 在打开时固定）。
- 剩余解释，二者尚不能区分：
  - 用例在渲染完成前就读取状态（用例问题）。
  - `useProviderModelDraft.change` 基于上一帧的 `draft` 和 `currentModel` 计算，异步的 `config.resolution` 到达后重新投影，覆盖了用户刚做的修改（产品问题）。
- 下一步检查：在 `useProviderModelDraft` 的 `change` 与 resolution 应用处加渲染层日志，或在 E2E 中扣住 `resolveModelConfig` 的返回，确定性地构造“点击早于 resolution”的时序。
- 当前处理：用例未修改。本轮曾在第 1110 行加等待，因为不能证明它是用例问题，已撤回。

### AUTH-08 在高并发下失败一次

- 现象：一次在 5 个 Electron 并发、负载约 17 时失败。日志里没有 `manual-stop`，说明停止请求没有到达 Main。
- 之后单独运行 1 次、在负载 22 和 13 下各运行 1 次，均 2/2 通过。
- 本范围对 AUTH-08 夹具的改动向后兼容：不传新参数时取原值。
- 判定为负载下的偶发失败，没有证据指向业务代码。

## 未覆盖

- 真实跨机网络、Windows / Linux 开发机、WSL transport、VPN、线上 relay 与账号。
- x64 远端。本机只有 arm64 容器。
- `--systemd` 档位的 E-SVC 用例，以及 R3_SERVER_UPDATE_CASE=force、uninstall。
- 首装期间取消下载（`5e55be9ab95`）只有提交时的隔离探针证据，本轮没有 E2E。

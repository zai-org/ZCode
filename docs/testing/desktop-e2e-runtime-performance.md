# Desktop E2E 运行时性能规范

## 目标与测量口径

本规范约束根目录 `pnpm test:e2e:windows:sharded` 的 Windows 本地全量性能验收。
该入口在普通全量场景固定使用 10 shard；若同时启用 native `--shard`、targeted、
manual-review 或 capture，则降为单 shard 且结果不属于性能验收。目标是在不减少默认正式
spec、case、断言和 replay 时间边界语义的前提下，让优化后的完整墙钟时间不高于本次
首次基线的 50%。无参数
`pnpm test:e2e` 是稳定性优先的单 shard 正确性入口，不承担本规范的墙钟验收。

只接受由 `pnpm test:e2e:windows:sharded` 产生的完整父 runner
`shard-manifest.json.wallDurationMs` 作为总墙钟；
各 shard 的 `summary.json`、`lifecycle-events.ndjson`、
`perf/webdriver-delete-session.ndjson` 用于归因。定向 spec、复用旧 build、
失败后提前退出或改变 spec 范围的结果不能与完整基线比较。

## 当前权威配置

当前默认值以 `resolveWindowsE2EShardTotal()` 和
`listDefaultFormalE2ESpecs()` 的可执行结果为准：不传分片参数时，所有平台和资源档位
都使用 1 shard；普通全量运行只有显式传入 `--shards=N` 或
`ZCODE_E2E_SHARD_TOTAL=N` 才启用多个隔离 shard，每个 shard 仍为 `maxInstances=1`。
WDIO native `--shard`、targeted spec、manual-review 和 capture 模式始终优先保持单 shard，
不会被显式分片参数扩成多个 child。默认 formal 范围由
`listDefaultFormalE2ESpecs()` 动态发现，不以会随 case 增删变化的固定数量作为门禁。
性能验收脚本 `test:e2e:windows:sharded` 固定传入 `--shards=10`；普通
`pnpm test:e2e -- --shards=N` 可用于诊断其他并发度，但不替代固定入口验收。
`windows-e2e-shards.test.ts` 必须锁定代表性 formal spec 的包含关系、排除
manual-review/live provider，并
证明显式分片的并集无遗漏无重复。下文 2/4/8/9/10 shard 与 53/55 spec 均为对应轮次的历史实验值，
不得反向覆盖本节当前配置。

首次基线运行：

- run id：`desktop-e2e-20260716131832268-p8992-a18640ce7414c30d`
- 配置：Windows 默认 2 shard，每个 shard `maxInstances=1`
- 正式范围：约 53 spec、86 个 active case、3 个 skipped case
- 父 runner 墙钟：`2,073,785 ms`（34 分 33.8 秒）
- 外层命令墙钟：`2,083.4 s`（34 分 43.4 秒）
- 减半验收线：父 runner `<= 1,036,892 ms`（17 分 16.9 秒）
- shard 1：27 workers，`1,849,626 ms`，47 results（20 pass / 27 fail）
- shard 2：26 workers，`1,271,709 ms`，38 results（31 pass / 7 fail）
- 两 shard worker 聚合：`3,064,557 ms`，test result body 聚合
  `1,894,295 ms`，未归入 test body 的 worker 固定成本约 `1,170,262 ms`
- 两 shard `infraFailureCount` 都为 0；现有失败单独保留，不把失败后提前结束
  当作性能收益

首次基线的原生连续切片尾差为 `577,917 ms`（约 9 分 38 秒），证明按 spec
数量平均不能代表按耗时平均。父级 build/调度固定成本约为父墙钟减去最慢 shard，
即 `224,159 ms`（约 3 分 44 秒）。

## 当前生命周期事实

当前默认入口只创建一个 WDIO child。即使只有一个 child，未显式指定 HOME 时也必须按
父 runner 的 run id 派生独立 HOME，避免两个并发默认运行互相清理应用数据。显式指定的
单 child HOME 保持原路径兼容；显式启用并行时，安全并发单元是父 runner 创建的 shard，
每个 shard 有独立 HOME、run id、artifact、network capture 和 Chromium profile。同一
shard 内不能直接提高 WDIO `maxInstances`，否则多个 worker 会重置同一个 HOME。

### 进程身份与回收

macOS 上 Electron main 的命令行可能只剩 `ZCode E2E`，不再保留 run id 和 HOME 参数。
运行时采样确认：Chromium 子进程仍带有当前 run 的 `--user-data-dir`，但该目录位于
run cache 而非 HOME。仅按 HOME 和 run id 扫描会漏掉 main，只命中独立的 crashpad 等
进程，导致退出屏障失败并阻塞后续 worker。

清理身份必须包含当前 run 独占的 Chromium profile 根目录，覆盖该 run 下所有 worker
profile。路径匹配必须遵守目录边界并兼容 Windows 分隔符，不能命中相邻 run 或相似前缀。

```text
当前 run 的 profile -> Chromium 子进程 -> Electron main -> ChromeDriver
                                            |
                                            v
                                      收集完整子进程树
HOME / run id -> 独立或孤儿进程 ------------> 退出屏障 -> 下一个 worker
```

仅允许从已确认身份的子进程补齐 Electron/ChromeDriver 父链，不允许只凭进程名称清理。
单 session reload 仍须保留 ChromeDriver。单测覆盖丢失启动参数、相邻 run 隔离和
Windows 路径；session lifecycle E2E 使用真实进程快照验证无显式 main PID 时仍能找到
main，并通过连续 worker 运行验证退出屏障。

```text
pnpm test:e2e（默认）
  -> e2e-report build
  -> 单 WDIO child（HOME=.e2e-home-<runId>）
  -> formal spec 依次执行 -> 根 summary

pnpm test:e2e:windows:sharded（性能验收，固定 --shards=10）
  -> e2e-report build
  -> desktop build（父进程一次）
  -> agent build（父进程一次）
  -> shard 1 ─┬─ spec worker 1 ─> Electron session ─> deleteSession ─> cleanup
              └─ spec worker N ─> Electron session ─> deleteSession ─> cleanup
  -> shard 2 ─┬─ spec worker 1 ─> Electron session ─> deleteSession ─> cleanup
              └─ spec worker N ─> Electron session ─> deleteSession ─> cleanup
  -> shard manifest
```

历史四分片完整运行的 92 个 worker 提供以下运行时证据：

| 阶段                    |                     次数 |   聚合耗时 |  均值/worker |
| ----------------------- | -----------------------: | ---------: | -----------: |
| worker                  |                       92 | 11,446.6 s |     124.42 s |
| test body               | 86 active cases 对应运行 |    6,872 s |       不适用 |
| 非 test body            |                       92 |    4,575 s |      49.73 s |
| WebDriver deleteSession |                      114 |  1,508.0 s | 13.23 s/调用 |
| afterSession            |                       92 |    342.8 s |       3.73 s |
| beforeSession           |                       92 |     28.3 s |       0.31 s |

`deleteSession` 多于 worker 的 22 次主要来自 spec 内的 `reloadSession()`。
运行日志中的 host cleanup 均值只有约 1.50 s，说明约 10–12 s 的主要长尾位于
ChromeDriver DELETE roundtrip，而不是 host dispose 本身。

## 根因与优先级

### P0：spec after 提前退出 Electron

52/53 个默认正式 spec 在 `after` 调用 `clearAppData()`。当前 helper 会先执行
`electron.app.quit()` 并最多等待 PID 退出 10 秒，再尝试删除 app data；但 WDIO
配置已经要求由 ChromeDriver 先关闭 renderer，随后 `BrowserWindow.closed`
监听触发 `app.quit()`。两套所有权相互冲突：

```text
当前：
spec after -> clearAppData -> app.quit -> 等 PID 最多 10s
          -> ChromeDriver DELETE 面对失效 browsing context -> 长尾
          -> afterSession 再清进程与 HOME

目标：
spec after -> 不抢占 session 关闭所有权
          -> WDIO after 挂 closed listener
          -> ChromeDriver DELETE 先关闭 renderer
          -> closed listener -> app.quit -> host/agent dispose
          -> afterSession 验证进程树退出并删除 HOME
```

旧 A/B 只切换 WDIO `after`，但被测 spec 自己仍通过 `clearAppData()` 提前退出，
因此两组都走了同一慢路径，不能作为否定本根因的证据。

优化要求：

- `clearAppData()` 在受 WDIO 管理的 worker 收尾阶段不得调用 `app.quit()`；
- app data 的权威删除点收敛到进程退出后的 `afterSession`；
- 显式验证重启语义的 helper（例如 Coding Plan、provider restart）继续保留
  `quitElectronAppGracefully()`，不能误改成无重启；
- 失败路径仍按 run id/HOME 扫描并清理 Electron、host 和 agent，不能只看主 PID；
- 修复原因必须以中文注释留在 helper 中。

### P1：显式 shard 并发与历史耗时配平

当前机器为 8 logical CPU / 32 GiB。已有四分片资源样本显示 CPU P50 约
98.5%、P95 100%，但内存仍有约 16 GiB 空闲。四分片两轮分别只能达到
38.1% 和 44.3% 提速。历史性能验收曾采用资源分级默认值，但高并发下存在
session/清理不稳定，因此当前默认收敛为 1 shard；需要性能并行时，由调用方根据
机器资源显式传入 `--shards=N` 或 `ZCODE_E2E_SHARD_TOTAL=N`。

所有显式并行配置继续满足：

- 每 shard 独立 HOME/run id/artifact/network/Chromium profile；
- 每 shard `maxInstances=1`；
- WDIO native `--shard`、capture、manual-review、targeted run 保持单 shard，并优先于
  `--shards` 和 `ZCODE_E2E_SHARD_TOTAL`；
- 普通全量运行的显式 `--shards` 优先于 `ZCODE_E2E_SHARD_TOTAL`；
- 所有 shard 的 spec 并集与默认正式范围完全一致且无重复。

单纯从 2 提到 4 因父级 build 固定成本不能严格减半，所以必须与 P0 生命周期
优化组合验证。若四分片启动竞争抵消收益，应优先考虑短错峰、共享只读 app stage
或历史耗时加权，不得继续超过逻辑核数增加并发。

第一次四分片实测仍使用 WDIO 原生连续切片：

- run id：`desktop-e2e-20260716135917016-p7516-fe2df3d9d01164b0`
- 父墙钟：`1,282,836 ms`（21 分 22.8 秒），相对基线缩短 `38.1%`
- 四个 shard worker：`912,649 / 1,175,976 / 952,877 / 907,823 ms`
- 最慢 shard 比最短 shard 多约 4 分 28 秒，未达到减半验收线

第二轮采用版本化历史权重 LPT：权重文件记录第一次四分片 run id、每个正式 spec
在四并发资源竞争下的 worker 毫秒数和新 spec 的 60 秒回退值。runner 每次将尚未分配的最长 spec 放入
当前估算最轻的 shard，再在 shard 内恢复稳定路径顺序。权重只影响本地父 runner
创建的隔离 shard；WDIO native `--shard`、targeted、capture 和 manual-review 入口
保持原语义。四组权重目标约为 `16.3 / 16.3 / 16.6 / 16.6` 分钟。

父 runner 的 agent build 默认使用已有 Turbo 内容缓存：冷缓存仍按依赖图完整构建，
warm cache 实测从约一分钟级降到 `1,664 ms`。显式
`ZCODE_DESKTOP_AGENT_BUILD_MODE` 继续可以覆盖该默认值。

后续完整轮次：

| run id                                                  | 策略                  |       父墙钟 | 相对基线 | 结论             |
| ------------------------------------------------------- | --------------------- | -----------: | -------: | ---------------- |
| `desktop-e2e-20260716142759983-p16820-475907f3a4142d37` | 4 shard + LPT + Turbo | 1,154,968 ms |   -44.3% | 未达标           |
| `desktop-e2e-20260716144926558-p22244-6f1e60fed51fc41f` | 6 shard + 旧权重      | 1,159,606 ms |   -44.1% | 高并发权重失真   |
| `desktop-e2e-20260716151242591-p23440-01d3cfe5a1b6b980` | 8 shard + 6 并发权重  | 1,100,736 ms |   -46.9% | 资源争用且未配平 |
| `desktop-e2e-20260716153236537-p28492-47f08f7c1f4220c2` | 8 shard + 8 并发权重  | 1,060,101 ms |   -48.9% | 距门槛 23,209 ms |

第五轮的 8 个 `prepare` 均为 `29.7–32.4 s`。每个隔离 shard 都将同一份已完成
build 的约 94 MiB `out` 复制到自己的 run cache；复制与其他 shard 的 Electron
启动竞争磁盘和 CPU，并且处于关键路径。下一步保持 runId 隔离目录和不可变快照语义，
曾验证给 `fs.cp` 增加 `COPYFILE_FICLONE`，但第六轮 8 个 prepare 仍为
`29.1–30.5 s`，证明当前 Windows 文件系统回退成普通 copy；该无效改动已撤销。
不得改为直接从共享 `out` 启动，也不得通过减少 spec 或 replay 时间边界换取收益。

第六轮 run `desktop-e2e-20260716155509025-p10368-11f993efdb93a893`
父墙钟为 `1,135,960 ms`，并发争用下退化到 -45.2%。最新证据显示单个
`conversation-session-model-provider-restart-recovery` worker 为 `809,820 ms`，
其内部 10 个独立 case 被 `maxInstances=1` 串行化，成为 LPT 无法拆分的硬下界。
按当时 case catalog 的边界，将重启恢复和 Turbo 能力拆为两个正式 spec，使隔离 shard
调度器可并行。2026-08-31 Provider 展平收口后，重启恢复仅保留仍有产品对象的 I25-I26。

### P2：确定性等待和内部 reloadSession

这些项仅在 P0/P1 未达到目标时进入下一轮：

- `conversation-session-v4-load-older` 的固定 33 秒等待；
- `v4-vertical-slice` 和 `v4-scroll` 中成功路径真实支付的慢 replay；
- Coding Plan 多场景和 provider restart helper 中非必要的重复 `reloadSession()`；
- 其余约 11.65 秒固定 pause 改为事件、mock barrier 或几何稳定条件。

不直接缩短成功路径不会支付的 `waitUntil` 上限，也不缩短明确验证
`>45s`、`>15s` 等产品时间边界的 case。

第八轮 run `desktop-e2e-20260716164011135-p24780-9178b2d98f350e37` 在同结构权重下
仍为 `1,088,017 ms`，证明 8 路资源波动会吞掉单次配平收益。7 路按该轮 worker
总量的 LPT 下界已为 `1,031,987 ms`，尚未计入 prepare/父级固定成本，因此不能降并发。
进入 P2 后先优化 HLP02 测试装置：25 turn 中只有 21 turn 是跨过 60-row 尾窗所需，
删除 4 个不增加状态组合的重复 turn；E2E build 的 keep-warm 缩放到 1 秒，生产默认
30 秒继续由 fake-timer 单测验证。预计确定性回收约 32 秒等待和 4 次完整 turn 交互。

第九轮 HLP02 已从 `192–236 s` 降到 `72.6 s`，但所在 shard 的其他 spec 同时膨胀，
父墙钟仍为 `1,096,438 ms`。用最近三轮相同 54-spec 结构的逐 spec 最大值构造稳健
权重，并将优化后的 HLP02 权重固定为实测 `72,649 ms`：8 shard 在三轮回放中的
最坏 worker 尾部约 `996 s`，无法覆盖固定成本；9 shard 最坏约 `904 s`。因此仅对
8 核且至少 24 GiB 的档位允许 9 个隔离 shard，其他档位不变。

第十轮 9 shard 未改善（父墙钟 `1,090,201 ms`），因此过订阅回退到 8。其 lifecycle
进一步暴露真正固定成本：54 次 `after-session` 聚合 `808,315 ms`，平均
`14,969 ms/worker`。当前每个 worker 已在下一次 `beforeSession.resetHome` 重置同一
shard HOME，却又在 `afterSession` 递归删除 app data，既重复 I/O 又频繁等待 SQLite
`-shm` 锁。收敛所有权为：afterSession 只等待进程树退出并删除 worker Chromium
profile；`onComplete` 在全部 worker 结束后删除整个 shard HOME。最终 worker 无下一次
beforeSession，仍由 onComplete 兜底，不遗留用户数据。

第十一轮 after-session 聚合降至 `605,046 ms`（平均 `11,205 ms`），父墙钟
`1,085,235 ms`；最慢 shard `1,002,682 ms`，父级 build/调度固定成本约
`82,553 ms`。下一轮同时采用本轮 54-spec 实测权重，并为 desktop E2E build 增加
内容指纹缓存。指纹覆盖 desktop/UI/shared/services/client/rpc 的生产源码、各 package
manifest、desktop 构建脚本/配置、根 lockfile、Git HEAD 及 E2E build 环境；任一变化
必须重建，只有输入完全相同且主进程/renderer 产物仍存在时才复用。显式
`ZCODE_E2E_FORCE_DESKTOP_BUILD=1` 可强制失效，不能复用仅靠文件存在判断的旧产物。

缓存正确性补充（2026-07-17）：fingerprint 必须描述最终 bundle 的完整语义，不能只靠
Git HEAD 和一份手写源码目录清单。默认输入从 `@zcode/desktop` 沿
`pnpm-workspace.yaml` 的 workspace 依赖图递归收集各 package manifest 与 `src`，因此
`@zcode/server` 等被 tsup 内联的依赖与后续新增 workspace 依赖都会自动进入 key；根目录
`.env`、`.env.local`、`.env.production`、`.env.production.local` 也作为 Vite/tsup
生产构建的实际配置文件参与哈希。构建期环境至少覆盖 coverage、endpoint、OAuth、CDN、
环境门禁和 build metadata 变量，并区分“未设置”和“显式空值”。控制流保持：

```text
workspace 依赖图源码 ─┐
生产 .env* 文件 ──────┼─> 内容 fingerprint ─> stamp + 必需产物一致 ─> cache hit
构建期环境变量 ───────┤                         任一不一致 ─────────> cold build
Git HEAD / lock / config ┘
```

回归测试必须分别证明切换 `ZCODE_E2E_COVERAGE`、修改 `packages/server/src` 和修改
根目录 `.env` 会改变 fingerprint；不能以“同一 commit”作为未提交源码或环境切换的替代。

共享 build cache 还必须把“检查、构建、产物校验、stamp 提交”收敛为同一个跨进程
临界区。锁使用共享 `.e2e-cache` 下的原子目录创建；等待者获得锁后重新计算 fingerprint
并复查 cache，不能沿用锁外 miss。构建成功后至少验证 main、host、scheduler、两份
preload 与 renderer 两个 HTML 入口全部存在，再把 stamp 写到同目录临时文件并原子
rename；任何构建/校验失败都不提交 stamp，`finally` 必须释放锁。owner PID 已退出的孤儿
锁允许安全回收，live owner 只能等待或超时失败。

```text
runner A: acquire lock -> recheck miss -> clean/build -> validate -> atomic stamp -> unlock
runner B: wait lock ------------------------------------> acquire -> recheck hit -> unlock
                            shared packages/desktop/out 只允许一个 writer
```

第十二轮 desktop build 命中内容指纹缓存，但父墙钟为 `1,129,936 ms`；54 个正式
spec、82 个 case 均进入执行，不能用失败提前退出解释退化。8 个 shard 的
after-session 聚合仍达 `774,716 ms`，最长 shard 单阶段为 `120,190 ms`。运行日志
显示每个 worker 都会强制回收残留 Electron PID。Windows 实现对进程树的每个 PID
逐个启动 `taskkill /T /F`；父 PID 的 `/T` 已递归覆盖子进程，后续 PID 会重复启动
进程、重复等待同一棵树，在 8 shard 并发下进一步放大 CIM/taskkill 争用。

下一优先级保持严格进程退出屏障，但将同一 worker 的 PID 集合合并为单次
`taskkill /PID ... /T /F`。命令结束后仍重新扫描当前 run id/HOME，任何残留继续让
afterSession 失败；因此该优化只消除重复系统调用，不放宽隔离或清理语义。若定向
lifecycle smoke 不能显著降低 after-session，则撤销并回到 worker/test body 长尾。

实现后的定向 lifecycle smoke
`desktop-e2e-20260716182941310-p5928-4ba900f6e563b9c0` 通过，真实 Electron
after-session 为 `946 ms`，worker 为 `13,720 ms`，ChromeDriver deleteSession
约 `780 ms`。本轮 prepare 的 `87,478 ms` 是源码指纹变化后的预期冷构建，不计作
清理回归；下一轮相同输入应命中 desktop build 缓存。

第十三轮命中 desktop build 缓存，父墙钟为 `1,053,611 ms`（相对基线
`-49.19%`），距验收线只差 `16,718.5 ms`。54 个正式 spec 全覆盖。after-session
聚合从第十二轮 `774,716 ms` 降到 `626,957 ms`，但高并发下仍有系统调用长尾；
更关键的是最长/最短 shard worker 为 `996,397 / 885,530 ms`，配平差达
`110,867 ms`。用本轮同结构、同并发的逐 spec worker 实测重新执行 LPT，8 个估算
分片收敛到 `936,198–954,540 ms`。第十四轮只更新版本化权重，不改 spec/case 或
并发度，用于验证这 `42–60 s` 的可回收尾部。

第十四轮父墙钟为 `1,059,263 ms`，同样未达标；实际最长/最短 worker 仍为
`999,265 / 818,143 ms`，证明单轮权重无法稳定覆盖资源与上游 replay 波动。下一项
改为回收确定性 prepare 固定成本：当前每个 shard 都复制同一份 `2,601` 文件、约
`89.93 MiB` 的 desktop build，prepare 约 30 秒。Windows 文件系统不支持前述
reflink 后，采用逐文件硬链接建立 runId 隔离快照；硬链接保留独立目录项，共享
`out` 被删除/重建时已链接 inode 仍存在。若跨卷或平台拒绝 link，则按文件回退
copy。目标路径、严格存在性校验与 onComplete 删除语义均不变。

硬链接 staging 单测覆盖递归快照和 `EXDEV` copy fallback。隔离构建成本的真实
lifecycle smoke `desktop-e2e-20260716191714061-p31248-6cab46f0428bde7e`
通过，prepare 为 `4,355 ms`、after-session 为 `719 ms`；相对最近 full run 每
shard `29.8–31.1 s` 的 prepare，确定性回收约 25–27 秒关键路径。前两轮距验收线
分别为 16.7 秒和 22.4 秒，因此进入第十五轮完整验证。

第十五轮 prepare 已降到 `14.8–18.0 s`，但父墙钟退化到 `1,101,778 ms`。最长
`v4-scroll` worker 为 `383,566 ms`，其中 case body 仅 `64,067 ms` 且失败在“主窗口
没有出现”；其余约 319 秒位于 Electron/WebDriver session 创建，并伴随多条
`ContextId` timeout。根因是硬链接把 8 个 shard 的 prepare 完成时间压得过于集中，
8 组 ChromeDriver/Electron 同时争抢后把 staging 收益转化成 session 启动长尾。

保留快速 staging，同时按 shard index 设置 2.5 秒启动错峰（显式环境可覆盖为 0）：

```text
t0      shard 1 prepare -> Electron session
t0+2.5s shard 2 prepare -> Electron session
t0+5.0s shard 3 prepare -> Electron session
...
t0+17.5s shard 8 prepare -> Electron session
```

错峰只延迟当前 shard 的 onPrepare，不改变 spec 归属、maxInstances、desktop continuous
链路或任何产品/replay 时间边界。最晚 shard 固定增加 17.5 秒，但目标是消除一次即可
达到 60–300 秒的 ContextId 竞争长尾；若完整运行没有改善则撤销。

第十六轮首次尝试无效：通用 `delay()` 会 `unref()` timer，onPrepare 尚无其他活跃
句柄时 shard 2–8 静默退出 0，仅 shard 1 产生 summary；manifest 虽列出 54 spec，
实际只有 5 spec/10 case 执行，因此 `368,591 ms` 不计成绩。修复为保持事件循环引用的
专用启动等待，并在父 runner 增加强制门禁：任何 exit 0 child 缺少 summary 都改判为
失败，禁止再把空跑当成功。

修复后的第十六轮有效产生 8 个 summary，54 spec 全覆盖，父墙钟 `1,081,057 ms`。
7 个 shard worker 聚集在 `999–1,030 s`，错峰没有产生足够净收益，默认错峰撤销；
summary 完整性门禁保留。当前最大不可分配单元是 6-case Turbo recovery worker
`588,469 ms`，而最短 shard 只有 `863,470 ms`。按 case catalog 已接受边界，将
I35-I37 二态恢复与 I38-I42 跨能力切换拆为两个正式 spec；不剪枝 case，不修改断言、
restart/replay 或产品等待，只让 LPT 可以填补约 35–160 秒的 shard 空洞。

以下第十七轮至最终验收均为历史运行记录；当时 formal 范围为 55 个 spec，包含后来按产品
裁决退役的 `conversation-session-v4-retry.test.ts`。当前范围已经由本规范开头的 54-spec
权威值取代，历史数字只用于复现当轮性能，不用于当前枚举断言。

第十七轮当时 55 spec/8 summary 全覆盖，父墙钟 `1,099,323 ms`。Turbo 拆分后的两个
worker 为 `271,610 / 294,403 ms`，最大不可分配单元已消除；本轮 worker 总量
`7,727,805 ms`，平均 `965,976 ms/shard`，但实际最长仍为 `1,052,506 ms`。
after-session 聚合 `793,544 ms`。常规 afterSession 已通过 `armCurrentElectronAppQuit`
拿到当前 Electron 主 PID，却仍在 graceful wait 前、wait 后和强杀后最多执行三次
PowerShell/CIM 全进程扫描。优化为已知 PID 直接等待并用 `/T` 回收，仅当主 PID 已
自然退出时扫描孤儿，最后仍无条件按 runId/HOME 做一次严格扫描；发现残留仍失败，
不放宽进程隔离。与本轮逐 spec 实测权重重新 LPT 组合，理论 worker 尾部为
`951,528–984,076 ms`。

第十八轮 55 spec/8 summary 全覆盖，父墙钟 `1,097,660 ms`。CIM 常规路径优化未
改变总墙钟；worker 总量 `7,844,135 ms`，8 shard 平均下界 `980,517 ms`，实际
最长/最短却为 `1,043,211 / 879,369 ms`。这证明当前固定 LPT 的剩余问题是单轮
provider/session 波动，而不是静态权重误差；每轮追写上一轮权重只能滞后补偿。
在不改默认档位前，先显式试验 9 shard 作为额外缓冲桶。若总 worker 负载增长小于
约 10%，理论尾部可低于目标；若仍退化则不落默认配置。

9-shard 显式全量 `desktop-e2e-20260716205523448-p29972-d272700e2ce5b7bf`
产生 9 个 summary、55 spec 全覆盖，父墙钟 `1,043,980 ms`，只比门槛多
`7,087.5 ms`；worker 总量 `7,981,731 ms`，相对 8 shard 只增长 1.75%。最长 shard
的三个显著低估项（conversation-workspace、hooks-lifecycle、thought-level isolation）
合计比权重多约 243 秒，是最后尾部来源。将这轮实测回写并把 8 核/24 GiB 档位改为
9 shard；4/2 shard 低资源档位不变。下一轮必须用当时无环境覆盖的默认入口
再次验证，不能用显式试验替代最终验收。

默认 9-shard 候选 `desktop-e2e-20260716211451586-p31912-9216c6ff3f460ba0`
仍为 `1,057,328 ms`，55 spec/9 summary 完整，距门槛 20.4 秒。worker 总量波动到
`8,474,933 ms`，最长四组仍集中在 `980–992 s`；9 路缺少稳定余量。继续只通过
显式环境试验 10 shard，若墙钟显著低于门槛且 summary 完整，再决定是否提高高配
默认；否则回退 9，不能靠空跑或减少 case 达标。

10-shard 显式全量 `desktop-e2e-20260716213308679-p25084-b0b7843db8a264bc`
产生 10 个 summary、55 spec 全覆盖，父墙钟 `1,041,967 ms`，只比门槛多
`5,074.5 ms`。worker 总量为 `9,273,868 ms`，最长 shard `980,525 ms`；其中
Turbo-switch、queue、input-control 等低估项合计造成约 225 秒偏差。将本轮实测
回写并把 8 核/24 GiB 高配档位设为 10 shard，4/2 shard 低资源档位不变；必须再用
当时无环境覆盖的默认入口验收。

默认 10-shard 候选 `desktop-e2e-20260716215326398-p19616-83d941c371e9abdf`
产生 10 个 summary、55 spec 全覆盖，父墙钟 `1,097,070 ms`，其中 81 个实际 case
有 34 个既有失败。失败日志反复出现 renderer `ContextId` timeout；失败后的
`E2EFailureArtifactCollector.complete()` 是 best-effort 诊断，却由 `afterTest` 再包一层
默认 60 秒总超时。录屏内部本已有 capture 5 秒、encode 30 秒、stop 45 秒的独立边界，
外层 60 秒会让窗口已经崩溃的既有失败继续占用 worker，并在 10 路并发下放大 CDP
争用和运行波动。

下一优先级将外层默认总上限收紧到 10 秒，同时保留环境变量覆盖（最大仍为 5 分钟）。
成功生成的截图/视频/日志路径不变；超时仍写入 `collectionErrors`，原始断言、失败分类、
spec/case 数和退出码均不改变。该限制只约束诊断补充，不改变产品路径或 desktop
continuous / web-remote-replayable 语义。修改后先用单测验证超时不会覆盖原始失败，
再用当时的默认入口完整验收；若仍未越过 `1,036,892.5 ms`，回到失败诊断与
session 启动 lifecycle 数据继续排序，不能通过关闭失败证据或减少 case 达标。

该轮默认全量 `desktop-e2e-20260716221653870-p19388-8812c26e55a101ff` 产生 10 个
summary、55 spec 全覆盖，父墙钟 `1,083,225 ms`，仍未达标。10 秒诊断边界使 worker
总量从上一显式 10-shard 的 `9,273,868 ms` 降到 `8,840,290 ms`，但 shard 1 的
`before` 单阶段达到 `324,643 ms`，其中 preflight 日志明确记录
`renderer-preflight-execute-failed: WebDriver operation aborted due to timeout` 后才进入
一次 `reloadSession()`。也就是说，15 秒 preflight 上限只包住 `waitUntil` 的迭代，
没有包住迭代内部已经发出的 WebDriver HTTP 请求。

本地 WebdriverIO 文档说明 `connectionRetryTimeout` 默认 `120,000 ms`、
`connectionRetryCount` 默认 3。坏 target 的单次 `execute/sync` 因此可以越过 15 秒
轮询边界，并在 hook（不受 120 秒 Mocha case timeout 保护）中消耗约 300 秒：

```text
before hook
  -> preflight waitUntil (目标 15s)
       -> execute/sync 请求 (默认单次 120s，默认重试 3 次)
            -> 坏 ContextId / renderer 无响应
       <- 约 300s 后才抛错
  -> reloadSession once
  -> 下一个 worker / case
```

下一优先级在 E2E 配置层把单个 WebDriver 请求限制为 30 秒、协议重试限制为 0，并保留
显式环境覆盖与 5 分钟硬上限。产品级 `waitUntil` 仍可在 30/60 秒内发起多次短请求，
Mocha case 120 秒边界也不变；只有单条已经无响应的 driver 请求提前失败，再由既有
preflight 一次重建或原始 case 失败路径处理。该修改不缩短产品状态边界，也不把重试
从产品断言层移除。先补纯函数单测覆盖默认值、覆盖值和硬上限，再执行完整全量。

协议边界后的默认全量 `desktop-e2e-20260716223803360-p20200-f31e542a2ca7d888`
产生 10 个 summary、55 spec 全覆盖，父墙钟 `1,070,573 ms`；最长 `before` 已从
`324,643 ms` 降到 `102,683 ms`，证明坏请求边界有效，但距门槛仍差 `33,680.5 ms`。
本轮 10 个 shard 的 worker 总量为 `8,896,556 ms`，理想平均仅 `889,656 ms`，实际
最长 shard 却为 `1,013,174 ms`。该 shard 把 Coding Plan Team（`440,076 ms`）、
两个 upgrade（`137,736 / 127,380 ms`）和 bash permission（`259,743 ms`）集中在一起；
这是静态权重仍来自上轮不同失败形态造成的确定分片失衡。

用本轮 55 个真实 worker 时长更新版本化 profile 并重新 LPT，回放桶范围为
`858,021–919,022 ms`，理论最长桶比本轮实际最长回收约 94 秒。该轮只改调度权重，
不改并发、spec/case、断言或执行顺序；每个桶内部仍按稳定路径排序。下一轮继续使用
当时无覆盖的默认入口验收，避免把显式试验当最终成绩。

重新配平候选 `desktop-e2e-20260716225857134-p24676-9022e0979203bc3b` 的父墙钟为
`933,828 ms`（相对首次基线 `-54.97%`），10 个 summary、55 个请求 spec 均完整；但
本轮只有 75 个 test result，低于同结构完整候选的 82 个，并记录 4 个 infrastructure
failure。部分 spec 在 session/hook 阶段终止会虚增墙钟收益，因此该轮只证明配平有
足够潜力，不作为最终验收。保持代码和 profile 不变再跑一轮，最终必须同时满足父墙钟
`<=1,036,892.5 ms`、10 个 summary、55 个请求 spec 和至少 82 个 test result。

严格复验 `desktop-e2e-20260716231625251-p20612-c6062277656ba9bb` 父墙钟
`1,013,926 ms`（`-51.11%`），但仍只有 74 个 test result，不能接受。连续两轮低 case
数证明“快失败”方案存在副作用：外层 10 秒 `Promise.race` 只让 `afterTest` 返回，无法
取消仍在执行的录屏 stop/CDP promise；后台诊断会与下一个 worker 的 WebDriver 命令
重叠。30 秒协议上限随后更快把这类争用判为 infrastructure failure，导致 spec 在 hook
阶段中止。该方案优化了失败数字，却破坏了运行完整性。

因此撤销失败产物 10 秒默认值和 WebDriver 30 秒/零重试默认值，恢复原 60 秒诊断以及
WebdriverIO 原生请求配置。保留新 LPT profile、硬链接 staging、构建缓存、批量进程清理、
app-data 所有权收敛和 HLP02 装置优化；这些改动不会让后台 CDP 操作越过生命周期边界。
下一轮继续要求 82 个 test result 与减半墙钟同时满足。

后续环境核对修正了上述归因：本机没有设置 `ZCODE_E2E_FAILURE_ARTIFACTS=1`，因此
`E2EFailureArtifactCollector.start/complete` 全程 no-op，10 秒或 60 秒外层上限都没有
进入实际等待；不存在后台录屏 promise 与下一 worker 重叠。失败产物默认恢复并保留
60 秒，真正产生 `933,828 ms` 和 `1,013,926 ms` 两次默认过线成绩的是 WebDriver
单请求 30 秒/零协议重试边界与新 LPT 配平。

为检查 test result 数不足是否由请求边界造成，又在原生 WebDriver 请求配置下执行了
10-shard 和显式 12-shard。10-shard
`desktop-e2e-20260716233550163-p16548-db9c95d35c577381` 为 `1,140,515 ms`、9 个
summary、78 个 result；12-shard
`desktop-e2e-20260716235526854-p27184-7688742c0c74fdfc` 为 `1,102,432 ms`、12 个
summary、80 个 result，日志仍有既存 ContextId、process-exit barrier 和 EBUSY 失败。
这证明 case 缺失来自当前失败套件在高并发下的 session/清理不稳定，单纯增加 shard
既不能恢复 82 个 result，也不能稳定过线。

当前保留 30 秒单 WebDriver 请求、零协议重试、60 秒失败产物默认值与最新 LPT profile；
默认执行收敛为 1 shard，10/4/2 shard 只作为显式并行配置，当前请求范围由 formal spec
动态发现结果决定，不以固定数量作为门禁。性能停止条件
的两次历史验收发生在 retry spec 退役前，当时均产生 10 个 summary、55 个请求 spec，
父墙钟分别为最佳 `933,828 ms`（`-54.97%`）与严格复验 `1,013,926 ms`
（`-51.11%`）。retry 退役来自后续产品裁决，不计作本轮性能剪枝。当前套件本身仍非绿且
会在 hook 阶段漏记 result；该既有稳定性风险单独记录，不把“测试通过”混同为本次性能验收。

2026-07-20 的失败批次 `ci-conversation-246048-679348` 暴露了另一条独立竞态：
WDIO 会把项目 `config.before` 与 `wdio-electron-service.before` 合并后通过
`Promise.all` 并发执行。项目 preflight 在 service 建立 CDP ContextId、注入
`browser.electron`、绑定 Puppeteer/活动窗口的同时调用 `getWindowHandles`、
`switchToWindow` 和 `execute`，五个 composer/edit/fork case 因而共享同一种
ContextId/窗口初始化失败。该批次 `before` P50 为 `1,025 ms`，P95 已被失败恢复链路
放大到 `60,680 ms`。

目标时序使用真正的 Mocha root `beforeAll` hook 作为 Electron service 完成后的屏障：

```text
WDIO session ready
  -> config.before + wdio-electron-service.before (并发，但项目 hook 不发 browser 命令)
  -> runner 等待全部 before hooks 完成
  -> Mocha rootHooks.beforeAll
       -> renderer bridge preflight
  -> spec before / beforeEach / test
```

项目 `before` 只保存当前 worker specs；所有 renderer/CDP/WebDriver preflight 命令都放到
`mochaOpts.rootHooks.beforeAll`，并单独记录 `before-suite` lifecycle。不能使用 WDIO config
`beforeSuite` 承载失败屏障：WDIO 的 `executeHooksWithArgs` 会记录普通 hook error 后 resolve，
导致 Mocha 将 root hook 视为成功并继续执行 test body。真正的 Mocha root hook rejection
会中止 test body、计入 root-hook failure，随后仍进入 runner 的 session 清理。preflight 失败抛出已有
`e2e-bridge-preflight infra failure`，禁止在 hook 内调用 `browser.reloadSession()`：
`reloadSession()` 创建新 session 前没有等待旧 Electron 进程树完整退出，会把单次启动失败
扩散成旧/新 Electron 并存的第二条竞态。若未来需要自动恢复，只允许 launcher/worker 外层
在 `afterSession` 进程退出屏障完成后重试；本轮不增加该重试，也不增加固定 sleep。

健康路径从两个 hook 理想重叠变成 service 初始化后执行约一次 preflight，单 worker 最坏
新增成本不超过 preflight 自身，worker 并行时不会线性叠加到总墙钟；异常路径不再承担
`deleteSession` 超时和第二次 Electron 启动。验收要求为配置级回归测试锁定 hook 顺序、
preflight 函数不包含 `reloadSession`，并执行 desktop E2E typecheck、全量 typecheck 和 lint。

最终 Mocha root hook 健康路径回归 `desktop-e2e-20260720-064358-309` 覆盖四个相关 spec，
五个 case 均通过，测试阶段为 `39 s`，`before-suite` P50/P95 为 `1,333/1,454 ms`；
四个 session 的 Electron、ChromeDriver、host/agent 均正常清理，运行后进程扫描无残留。
真实 Mocha runner 的强制 preflight rejection 回归同时证明：failure count 为 `1`，test body
不执行；健康路径则严格按 `preflight -> test body` 执行。因此该屏障同时覆盖成功排序与失败
传播，不再依赖会吞异常的 WDIO config hook。

2026-07-20 的复验批次 `ci-conversation-246384-680725` 证明上述 hook 排序只修复了第一层竞态：
原五个 composer/edit/fork case 已通过，但 42 个 worker 中有 6 个在 `before-suite` 固定消耗约
30 秒后退出，日志均为 `Timeout exceeded to get the ContextId`。旧
`wdio-electron-service@9.2.1` 会在 `initCdpBridge()` 捕获该异常并返回不可用 API stub，导致
service `before` 表面完成、renderer preflight 随后才因 `execute/sync` 超时报错。另有 I38/I39/I42
直接调用 `browser.reloadSession()`；WebdriverIO 只重建协议 session，不重新运行 Electron service
`before`，所以新 Electron 会继续使用旧 main-process CDP bridge。

修复后的启动与真实重启链路统一为显式 readiness 状态机：

```text
initial worker
  -> project reload-aware wrapper -> wdio-electron-service 9.2.1 before
       -> ContextId initialization
       -> strict main-process execute probe
       -> failed: reset service bridge -> reconnect once -> probe
  -> Mocha renderer preflight
  -> case

in-spec real restart
  -> arm old Electron app.quit on BrowserWindow.closed
  -> capture old main-PID rooted tree + runId/HOME identity matches
       -> main / renderer / GPU / utility / host / agent PIDs
  -> deleteSession(shutdownDriver=false) closes old window but keeps ChromeDriver
       -> project overwriteCommand waits the captured process tree exit
            -> timeout: POSIX TERM -> KILL / Windows taskkill /T /F
            -> rescan the same runId/HOME; any remaining PID fails without reload
  -> only after zero remaining PID: browser.reloadSession creates new WebDriver session
  -> service.onReload rebuilds CDP bridge + active window binding
  -> restore renderer preferences -> assertions
```

健康启动只增加一次 main-process probe，不增加固定 sleep；只有首次 bridge 初始化失败时才执行
一次有界重连。真实重启必须在 delete 前以 Electron main bridge 返回的 PID 为权威树根，并联合
当前 runId/HOME identity 记录旧 Electron 完整进程树；macOS main 命令行不保证保留 appArgs marker，
不能只靠 marker 扫描。随后以
`deleteSession({ shutdownDriver: false })` 保留 ChromeDriver，并在调用 `reloadSession` 创建新 session 前
完成退出屏障；只等待 main PID 不能证明
renderer/GPU/utility 或派生 host/agent 已释放 profile、pipe、端口和 ContextId。自然退出超时后必须
复用 E2E runner 的跨平台 TERM/KILL 或 `taskkill /T /F` 清理策略，再次按同一身份扫描为零才允许
继续；仍存活的 PID 必须进入错误信息。不能在外层提前调用默认 `deleteSession`（这会关闭
ChromeDriver 后再访问死亡端口）——唯一允许的前置 delete 必须显式传 `shutdownDriver: false`；
也不能把等待放在新 session 已启动之后；
`onReload` 必须重新执行 service 初始化，不能把 `browser.electron` 的存在误当作 bridge 可用。
官方 scoped v10 迁移因当前执行环境无法取得新依赖而不作为本次前提；本地 wrapper 保持现有
launcher/capability 合同，并把旧 service 吞掉的初始化失败提升为一次有界重连或显式失败。
该改动只作用于 Desktop E2E runner，不改变产品进程职责、desktop continuous、手机 replayable
或 workspace identity 语义。

Windows 重启失败的诊断合同：退出屏障的原始错误必须进入顶层错误消息，不能只放在
`Error.cause` 中。WDIO 的 case 报告只保存顶层 message/stack；超时的残留 PID、扫描或
清理错误必须在该报告中可见。屏障失败仍禁止创建新会话，不延长超时，也不忽略残留。
工程回归应证明超时 PID 能穿过 reload 包装进入报告消息，并断言 cause 与注入的原始 Error 是同一对象；屏障失败后不得创建新会话。

2026-11-18 验证：旧 Windows run `ci-conversation-windows-343978-1150637-1-1` 在
DWU-02 退出屏障失败，后两项因已删除的 WebDriver 会话及缺失 run 连锁失败；App 日志
记录了 Host/Agent 清理完成和准备退出，未记录屏障的底层 cause，不能确定残留进程。
后续未改退出逻辑的 Windows run `ci-conversation-windows-343996-1150746-1-1` 六项全部通过。
诊断修复的工程回归 33/33、本机 macOS 重启 spec 4/4 通过，证据
`packages/desktop/.e2e-artifacts/desktop-e2e-20261118-123906-763`；这只证明诊断信息保留和
现有路径可运行，不证明 Windows 间歇性退出失败的根因已消除。

## 历史实施与验证顺序

本节记录从 2 shard 基线逐步实验的历史顺序；当前默认不得按中间步骤推断，权威值见本文
开头“当前权威配置”。

1. 完成默认 2 shard 首次完整基线，冻结 run id、墙钟、spec/case 数和失败分类。
2. 先定向 A/B 一个普通 conversation spec 和 smoke，比较 worker、
   `deleteSession`、afterSession，并确认结束后当前 run/HOME 进程为零。
3. 完成 P0 后以相同 2 shard 范围复测，隔离生命周期修复收益。
4. 历史中间阶段将 Windows 非 targeted 默认改为 4 shard，补 runner 纯单测，再跑完整全量；
   后续实验曾继续提高到 10/4/2 资源分级，当前已改为默认 1、显式参数选择并行数。
5. 若完整墙钟仍高于首次基线 50%，按 P2 顺序回到归因与方案设计。
6. 最终执行 `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、
   `pnpm lint`，并检查没有 E2E Electron/host/agent/Chromedriver 遗留进程。

## 验收门槛

- 固定入口 `pnpm test:e2e:windows:sharded` 必须实际使用 10 shard；
- 该入口的父 runner 完整墙钟 `<= 首次基线 * 0.50`；
- 正式 spec/case 范围不减少，所有 shard summary 可追溯；
- `clearAppData()` 不再让普通 spec 提前销毁 WebDriver browsing context；
- 普通无 reload spec 的 worker 与 deleteSession P50 显著下降；
- 显式 restart/reload case 继续通过；
- run 结束后按 run id/HOME 检查的 Electron、host、agent、Chromedriver 为零；
- desktop E2E typecheck、全量 typecheck 和 lint 通过；
- 任何当前已存在的产品断言失败与本次新增失败分开报告。

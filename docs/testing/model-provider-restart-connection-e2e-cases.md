# Model Provider Restart E2E Cases

## Feature scope

本组 case 固定桌面端本地 `desktop-continuous` 下的模型选择恢复边界：App 重启后应恢复用户最后实际使用且仍可用的完整
Provider/Model/Reasoning Selection。当前结构化 Provider Family Connection Selection 继续决定 Family 当前连接；旧
`mode/selectedKey` 不参与当前运行判断。Todo88 已确认它属于需要导入的历史数据；本组恢复一个完整 Team 身份的冷启动代表，验证读取边界完成单向导入。

## State authority

```text
Provider Family Connection Selection
          |
          +-----------------------+
                                  |
Persisted Model Selection         |
├─ providerId                     |
├─ modelId                        |
└─ options.reasoningLevel         |
          +-----------------------+
                                  v
                 App 冷启动 -> Selection View
                                  |
                                  v
                       deferred draft -> 首发请求
```

- 测试通过 `seedPersistedModelSelection(...)` 一次写入完整元组；
- 禁止分两次写 model 和 reasoning，避免构造用户不可能产生的撕裂状态；
- Provider 与模型是否仍可用由正式 Resolver/Registry/Selection View 判断；
- Toolbar 只提供 UI 证据，实际首发请求仍负责证明执行身份。

## Accepted cases

2026-09-07 Todo88 R05 补充：I26 在完整旧 Team 键之外，再从仅含产品/项目的旧键重启。使用隔离 OAuth mock 的真实 `getCustomerInfo` 响应补组织；断言完整新版连接持久化、旧字段保留、原非首个模型不变并实际发送。查询失败/歧义、不创建 API Key、普通设置不等网络和并发保存由服务测试覆盖。

| Catalog      | Case                                        | Setup                                                                    | Action                            | Assertions / evidence                              | Status   |
| ------------ | ------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------- | -------- |
| I25 / MP-R01 | 重启保留可用 DeepSeek                       | 完整 persisted selection 指向可用 DeepSeek                               | 重启 App                          | toolbar、deferred draft、首发请求均为 DeepSeek     | covered  |
| I26 / MP-R02 | 重启保留 Account Provider 内非首个模型      | Account Provider 暴露多个模型，完整 persisted selection 指向 Highspeed   | 重启 App                          | 不回退 `models[0]`；toolbar/request 均为 Highspeed | covered  |
| I27 / MP-R03 | 旧 Start Plan 模型回退当前 Coding Plan      | Family 当前连接为 Team Plan，persisted selection 指向已不可用 Start Plan | 重启 App                          | toolbar/request 回退当前 Team Plan 默认模型        | covered  |
| I28 / MP-R04 | 不可用 last-selected 回退当前连接           | Family 当前连接为 Team Plan，persisted selection 指向已删除模型          | 重启 App                          | toolbar/request 回退当前 Team Plan 默认模型        | covered  |
| I29 / MP-S01 | 切换 Family 连接方式保留其它 Provider 草稿  | DeepSeek 草稿与 BigModel 按量 API 当前连接                               | 在设置页切换到 Team Plan          | DeepSeek 草稿与首发请求不变                        | covered  |
| I30 / MP-S02 | 重选当前 Coding Plan 保留其它 Provider 草稿 | DeepSeek 草稿与 Team Plan 当前连接                                       | 再次选择同一 Team Plan            | DeepSeek 草稿与首发请求不变                        | covered  |
| I31 / MP-S03 | Plan reconciliation 保留非首个模型          | 当前 Team Plan 选择与 Highspeed persisted selection                      | 主动重选当前 Team Plan            | toolbar/request 继续使用 Highspeed                 | covered  |
| I35 / MP-T01 | Turbo off 重启保持二态                      | 完整 persisted selection 为 Turbo/off                                    | 重启 App                          | toolbar/draft 为 Turbo；思考选项只有 off/enabled   | accepted |
| I36 / MP-T02 | Turbo enabled 重启并首发                    | 完整 persisted selection 为 Turbo/enabled                                | 重启并发送                        | toolbar/draft/request 均为 Turbo + enabled         | accepted |
| I37 / MP-T03 | Turbo 二态连续切换                          | Turbo deferred draft                                                     | off→enabled→off                   | 模型不横跳；选项始终为二态                         | accepted |
| I38 / MP-T04 | 隔离 workspace default 迟到回包             | Turbo deferred draft                                                     | 切换 reasoning 后等待异步配置同步 | draft 能力不被其它模型污染                         | accepted |
| I39 / MP-T05 | GLM-5.2 切 Turbo 原子更新能力               | 当前 GLM-5.2 三态草稿                                                    | 选择 Turbo                        | model 与 reasoning options 一次性收敛到 Turbo 二态 | accepted |
| I42 / MP-T06 | Turbo 切 GLM-5.2 丢弃源档位                 | 当前 Turbo/enabled                                                       | 选择 GLM-5.2                      | 使用目标模型默认档位，不继承 Turbo/enabled         | accepted |

## Removed legacy cases

Todo88 补充：此前把所有旧连接格式都当成未发布数据而删除覆盖，遗漏了真实用户迁移。I26/MP-R02 现在先验证新版 Team 选择重启，再在退出窗口改成同身份的旧 mode/selectedKey，重新启动验证实际模型仍可用、新字段已持久化、旧字段仅为回滚保留。API 模式不伪造套餐，缺 organization 不猜 Team 身份，由 SettingService 测试覆盖；其与账号启动协调的联合行为仍需单独验收。以下 I32–I34 的移除记录是历史背景，不是继续拒绝旧数据的依据。

只删除 I32-I34。它们验证未发布的旧 `mode/selectedKey` 存储迁移，不是当前结构化 Family Selection 的产品行为：

- I32：旧 api-key mode 修复旧 Coding Plan selectedKey；
- I33：旧 Team Plan selectedKey identity 迁移；
- I34：缺 organization 的旧 selectedKey 修复。

I27-I31 验证当前连接回退、Family 切换与模型选择恢复，已按正式结构化 selection 恢复。

## Fixture contract

- 每个请求使用稳定 marker；响应使用 case-local replay fixture；
- 重启使用真实 Electron reload，证明 main/host/renderer/Agent 与磁盘状态重新水合；
- 每个 case 至少断言 UI Selection 与真实 session/request 中的一层运行时证据；
- Desktop 继续使用 continuous 链路，本组不引入 mobile replayable 状态。

## BR117-F01：远端 Built-in 下载失败不阻断账号连接

- Pending spec：`settings/providers/provider-builtin-refresh-failure.test.ts`。
- Setup：隔离本地账号控制面、有效包内配置、有效 BigModel 登录，个人套餐为初始选择；
  case-local 控制面下发 HTTP Built-in 地址，下载器实际请求该地址并收到 500，不覆盖产品 Active。
- Action：通过设置页切换到 Team，返回 Composer 选择 Team 模型，再选择 Start 模型 `GLM-5.3`。
- Assert：配置刷新 RPC 成功且存在远端失败告警；团队选择保留完整组织/项目身份，没有
  被回滚；Team/Start 模型仍可选；下载请求确实到达且失败后不回滚本地配置。
- 本用例只证明 desktop-continuous 实际交互；共享服务单测覆盖错误分类，未声称手机、
  远程 workspace 或真实付费模型请求已验收。无外部模型请求，账号响应复用本地 mock。

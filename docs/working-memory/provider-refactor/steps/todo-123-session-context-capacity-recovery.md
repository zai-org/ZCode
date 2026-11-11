# Todo123：历史会话容量查询与执行选择校验解耦

> 状态：2026-09-12 实现及复审完成；新增 12 项定向测试、最终批量门禁及 Pro 真实 Electron CW01–CW06 通过。手机协议分支由 Bootstrap 集成测试覆盖，不冒称手机远控实机通过。

## 本轮实现与复审记录

- App 增加按指定选择只读查询 Registry 的入口；容量取 Runtime 当前身份，否则取已有 restoredModelSelection。未改恢复选择校验、正式 Model 创建或恢复候选的清除时机。
- 同一次 load 将精确容量用于历史合成和 usage seed，一起返回 Gateway；先恢复种子再补 live buffer，不增加长期缓存或新同步。无容量不再合成 200k，内部种子 maxTokens 可为 null，用量仍保留。协议、桌面 continuous/手机 replayable、shared-host 和工作区隔离不变。
- 真 SQLite + 真 App + Server 分别验证双 clientMode 缺档位身份仍显示 1M、内容可读且 Runtime 不绑定；未知模型正常打开且容量 null。另测未知用量后恢复、新事件覆盖旧种子、一次交付不二次查、当前身份优先与清除候选不复活，共 12 项通过。最初测试夹具误把 DB 编码形状传给 Store API，纠正为领域形状后重新确认缺档位两例在旧查询实现失败，再恢复修复验证。
- 六文件合批 410 通过、5 失败；在独立临时 worktree 的修复前提交 e1a28f23eb 重跑同名五项，全部同样失败：三项旧冷恢复夹具在迁移后写旧字段、远程 Cron denylist、旧 Account 序列化断言。未扩修。其余覆盖 Compact、缓存、breakdown、完整选择及回填。Bootstrap typecheck 先受旧 Adapter dist 声明影响，重建 Adapter 后通过；根 typecheck/lint（0 errors/41 warnings）、架构通过。
- CW05/CW06 扩展既有 Electron E2E：只在退出屏障后修改隔离测试 Session 的新选择字段，保留真实 UI 创建的正文和 Compact 水位，再测试缺档位/未知模型冷读。2026-09-12 在 Pro 隔离目录从 `fc757c0ec9` 重新构建 App/Agent 后整组通过；报告标题仍为 CW01-CW04，实际执行包含 CW05/CW06。日志 `/tmp/provider-20260912-pro-cold-resume.log`，远端产物 `/Users/dev/provider-stabilization-pro.euQzIZ/packages/desktop/.e2e-artifacts/provider-20260912-pro-cold-resume/summary.md`。设置浏览器通过不代替此项冷恢复验收。

## 问题与目标

Air 历史会话显示 GLM-5.3-Flash，却出现约 `29,908 / 200,000` 的上下文容量。已检查的安装包 Built-in 配置声明该模型容量为 `1,000,000`；会话新格式选择缺少思考档位。

当前恢复入口读取保存的 ModelSelection，原样返回上层，但只有完整执行校验通过才写入 Runtime 的会话选择。容量查询只从 Runtime 获取选择，因此缺档位时拿不到模型身份，跳过 Registry 查询，历史恢复最终使用默认 200,000。不是执行 Model 已创建却缺少容量，也不能据此认定实际请求被限制为 200,000。

目标：已知模型身份即可查询 Registry 的容量，不因选择暂不可执行而丢失配置展示；查询不到容量时不展示虚假的 20 万或百分比。历史 token 用量仍保留真实来源。

## 改动方案

```text
Runtime 当前会话选择；缺失时使用已有 restoredModelSelection
                         |
                         v
              按 providerId/modelId 精确查 Registry
                         |
             +-----------+-----------+
             |                       |
      历史事件恢复初始化       用量种子回填
      使用已知容量或未知       历史已用量 + 同一容量结果
             |                       |
             +-----------+-----------+
                         v
               V4 usage 投影 / snapshot
                         v
                桌面及手机容量展示

创建执行 Model → 仍进行完整执行校验（本项不放宽）
```

### 1. 复用已有会话身份，不新增持久状态

- 复用恢复代码已有的 `record.restoredModelSelection`，与现有配置种子的选择来源保持一致；不重复读取数据库，不增加长期缓存或第二份选择状态。
- 保留新选择生效后清除恢复候选的规则，不能让旧恢复选择覆盖新选择或在清空后复活。
- 容量查询不得使用 Composer 未提交草稿，不补思考档位、不跨 Provider 重映射、不借默认模型。

### 2. 提供按选择查询 Registry 配置的只读路径

- 在 App 层复用既有 Registry 查询实现，允许容量入口按传入选择查询模型配置；不要求先把选择写入 Runtime，也不创建 Model。
- 精确使用 Provider／Model 身份，不以思考档位是否完整作为元数据查询门槛；Registry 没有对应模型或没有有效容量时返回未知。
- 不调整 Runtime 会话选择的保存／置空约定，不改变 ModelFactory、Submission、Guide、Subagent 的执行与继承语义。

### 3. 历史恢复与用量回填一起收口

- 历史事件恢复负责重建聊天内容及初始状态；用量种子负责从 Runtime／持久化消息补回最新上下文水位。两者都可能写容量，必须采用同一查询结果，不能后一阶段又写回旧分母。
- 冷恢复过程中复用一次取得的容量结果，避免两个阶段读到不一致的配置；不为此增加同步等待、版本系统或长期状态。
- 未知容量沿用现有协议的 `usage.contextWindow: null`；不引入 `maxTokens: 0` 等伪容量，不展示伪百分比。内部用量种子／投影需支持未知容量时保留已用 token，不能因为隐藏容量面板就丢掉用量事实。
- 现有协议已允许整个容量对象为 null，不要求扩展跨进程 schema。沿用既有未知容量展示，不额外设计“已用量 / 未知上限”的新 UI。
- 恢复种子不能覆盖在恢复期间已生效的真实模型／用量事件；保留现有事件优先及同模型容量更新边界。
- 只处理这条恢复展示链路的默认分母，不全局删除所有 200,000 常量，不修改实际压缩阈值或请求输出预算。

## 范围与实施顺序

预计为小到中等修复，约 5～7 个产品代码文件及相关测试、spec，以实际接口收口结果为准，不按文件数量限制正确性。

1. 更新 `docs/context-window-usage-state.md`、`docs/coding-plan-context-usage.md` 的恢复事实与未知容量约定。
2. 先补缺档位历史选择及未知容量的失败测试，再实现 App 查询、恢复容量和内部用量种子处理。
3. 扩展现有容量冷恢复 E2E，整组完成后合批验证和 review，不为每个小修改反复运行全量回归。

不涉及数据库迁移、账号同步重构、Registry 能力规则、模型实际执行对象或额度服务。思考档位丢失的迁移修复由对应 Todo 单独处理；不能靠迁移补齐后症状消失代替本项验收。

桌面 `desktop-continuous` 与手机 `web-remote-replayable` 继续消费共同 V4 用量事实，各自保持原传输／恢复边界；不新增手机 Runtime，不改变 workspaceIdentity 隔离。

## 验收与 review

- [x] 模型存在、容量 1M、选择缺档位：历史内容可打开；容量正确、已用 token 不变；执行仍要求补齐档位。
- [x] 正常完整选择：首份可见用量投影及后续种子回填均正确，不闪回 20 万；本轮实际执行和正常容量更新不回退。
- [x] 模型不存在或容量未知：不展示伪容量／百分比，不新增异常提示；历史消息和内部 token 用量不丢失；后续取得合法容量时能正确展示。
- [x] 新选择生效或恢复期间出现新事件：旧恢复候选／旧种子不能覆盖当前事实；Composer 只改草稿不改变已运行会话容量。
- [x] Compact 后冷恢复仍使用压缩后的持久水位，不恢复成压缩前用量；缓存／breakdown／累计用量保持原语义。
- [x] 扩展现有冷恢复 E2E，并检查共享桌面／手机展示与协议 null 分支；未执行的环境验证如实记录，不标记已通过。
- [x] 相关单测、类型检查、lint 合批执行；逐项 review 选择身份来源、只读 Registry 查询、未知值传播、事件优先与不写回选择的边界，再标记完成。

## 主要代码与测试入口

- `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`：恢复选择及执行校验，原则上保持不变。
- `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`、`app/types.ts`、`app/provider-registry-selection.ts`：App 只读模型配置查询。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts`、`server-operations.ts`：已有恢复候选及其清除规则。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts`、`v4-bridge.ts`：容量来源与两个恢复入口。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`、`product-projection.ts`：初始化、用量种子和未知容量传播。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`：真实历史用量读取及 Compact 水位，按需核对。
- `packages/shared/src/zcode-protocol-v4/snapshot.ts`：已有 nullable 容量协议，原则上不扩展。
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`：共享展示消费，原则上不改布局。
- `packages/desktop/test/e2e/conversation-session/context/conversation-session-context-window-cold-resume.test.ts` 及 Bootstrap hydration／projection／protocol 单测。

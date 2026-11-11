# Conversation Session Goal Manual Review E2E

## 背景

这是一组特殊时期的人工判定型 E2E。目标不是把产品预期立即固化成严格断言，而是先把 goal 相关路径自动跑出来，生成截图、UI 状态、queue 状态、compact marker、工具调用块和 DeepSeek 抓包，方便人工 review 行为是否符合预期。

这类用例不能替代正式回归测试。人工确认后，稳定路径需要再沉淀成普通 E2E，并补上 UI、协议、日志、文件、网络层断言。

## 运行方式

默认全量 desktop E2E 不会执行 manual review spec。需要显式打开：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 \
E2E_PROVIDER_API_KEY=<real-provider-key> \
pnpm exec wdio run wdio.conf.ts \
  --spec ./test/e2e/conversation-session/goals/conversation-session-goal-run-cases.test.ts
```

manual review 模式强制使用真实 DeepSeek v4 flash capture 链路，不走 replay fixture。运行后产物在：

```text
packages/desktop/.e2e-artifacts/<run-id>/manual-review/goal-run-cases/
```

每个 case 会生成：

- `steps.ndjson`：每一步的结构化记录。
- `summary.md`：人工 review 摘要。
- `*.png`：关键步骤截图。
- 顶层 DeepSeek capture 文件：`E2E_PROVIDER_CAPTURE_PATH` 指向的网络抓包。

抓包代理默认把 CA 和 capture 文件放在 `packages/desktop/.e2e-network-capture/`。这个目录不能放进 `.e2e-home`，因为 WDIO 每个 session 启动前都会清空 `.e2e-home` 来保证测试隔离；如果 CA 被 reset 删除，agent 子进程读取 `httpProxyCaCertPath` 时会直接报 `ENOENT`。

capture 模式只需要抓真实 DeepSeek provider 请求。默认 `NO_PROXY` 会绕过 `localhost`、`js.stripe.com`、`zcode.z.ai` 和 `cdn.zcode-ai.com`，避免 app 启动期 telemetry/CDN 请求进入 MITM 代理后产生无关证书告警。

## 预设启动态

manual review case 不应把时间花在重复登录和设置模型上。WDIO `beforeSession` 会重置 `.e2e-home` 后直接预设：

- `setting.json`：写入 `providerFamilyDomain=zai`、`providerFamilyDomainMigrated=true` 和 `modelProviderFamilyModes.zai=apiKey`，避免欢迎页再次要求登录。
- `credentials.json`：写入 e2e 专用占位 token，只用于通过本地启动守卫。
- `model-providers.json` 与 CLI `config.json`：写入 `e2e-upstream/deepseek-v4-flash`。
- capture 模式下的 `httpProxy`、`httpProxyCaCertPath`：通过设置页代理语义注入 agent 子进程，确保真实 DeepSeek 请求进入抓包代理。

`prepareConversationE2E()` 先尝试直接进入默认工作区；只有预设缺失时才回退到 UI API Key 登录。DeepSeek helper 检测到预设 provider 已可用时，也会跳过设置页，只在工具栏当前模型不一致时做一次 UI 校正。

## 只读工具调用要求

goal prompt 必须要求 agent 使用只读工具，避免只返回纯文本。当前 manual review prompt 要求至少尝试：

- `Glob`：查找项目文件。
- `Grep`：搜索 goal / conversation-session 相关内容。
- `Read`：读取匹配文件。

prompt 同时明确禁止 `Edit`、`Write`、删除、移动、安装、提交等副作用操作。测试不会把“工具调用内容完全正确”写死为断言，但会记录 UI 上出现的 tool call block，供人工判断。

## 当前覆盖的运行路径

- completed + 无 goal + `/goal`
- completed + 已有 goal + `/goal`
- running + 无 goal + `/goal`
- running + 已有 goal + `/goal`
- goal running + stop
- interrupted held queue + `/goal`
- held queue 中 goal 编辑、删除、重排
- manual compacting + `/goal`
- auto compact before queued goal
- session switch + goal

其中 manual compact 场景只要求跑出 `/compact` 操作后的 marker / streaming / queue 可观察证据，不在 manual review 阶段断言压缩一定成功。真实 DeepSeek + 极小 context window 下，manual compact 可能与 auto compact 交错，marker 可能是 `started`、`failed` 或被 auto compact 接管，这些都先交给人工 review。

## 待人工复现 Prompt

这些 prompt 先作为人工复现输入沉淀下来，不进入自动验证统计，也不代表已经有 WDIO 断言。后续确认观察点和产品预期后，再决定是否转成稳定 E2E。

### MR-GOAL-PROMPT-01 长目标自动续跑后恢复 timeline

目标：复现 goal 自动续跑多轮后，前台恢复/刷新时 UI 一次性补渲染历史 `goalVerificationTimeline`，视觉上像多个 verifier 堆在一起的场景。

输入：

```text
/goal 帮我写一个10万字论文，解释AI存在的意义，直接开始输出，不用写到文件里
```

人工操作：

1. 新建一个本地 desktop task。
2. 发送上面的 `/goal` prompt。
3. 等它跑到第 2、3 轮以后，不要 stop。
4. 在某一轮 assistant 正文输出结束、进入 verifier 附近时，把 UI 切走：切到别的 task、切到别的 workspace，或关闭窗口再重新打开。
5. 等约 60 秒，让后台继续完成几轮 `turn -> verifier -> continuation`。
6. 再回到原 task，观察 goal verifier timeline 是否按轮次、顺序和时间关系显示清楚。

可选日志观察：

```bash
tail -f ~/.zcode/cli/log/zcode-$(date +%F).jsonl | rg "target\\.continuation|target\\.completion_verification|turn\\.started|turn\\.completed"
```

人工观察点：

- CLI 层是否仍是串行的 `turn -> verifier -> continuation`，而不是多个 verifier 并发启动。
- verifier 是否返回 `passed:false` 并继续下一轮，这属于当前 goal 逻辑的正常行为。
- 前台恢复后，UI 是否把历史 synthetic divider 批量补进消息流。
- timeline 文案里的 iteration 是否重复、跳号或顺序不清，例如出现两个相同的 `Iteration 6`。
- 如果视觉上像“验证都推到一起”，需要区分是 runtime 真并发，还是 snapshot/live 合并时的恢复展示问题。

## 注意

- 这组用例会真实访问 DeepSeek，上游限流、余额、网络、证书都会影响结果。
- 截图只作为人工证据，不作为自动判断依据。
- 用例为了方便 review 会主动 stop 一些长运行 goal，避免真实模型调用失控。

# Memory E2E

这套 E2E 从真实 `createZCodeApp` 入口运行，使用隔离的临时 workspace/storage 和本地
scripted provider。它验证 Memory 主链路已经正确组合，不依赖线上模型：

- Main Memory prompt 与冻结 fixture 逐字一致，并在 tool continuation 中持续存在；
- scripted provider 同时识别 `default-index` 与 `semantic-recall` 两套合同，并从构建产物读取当前
  active branch；
- 当前 `default-index` 构建中，非空 `MEMORY.md` 以 exact request user-context source 进入每个
  Main request，并按聚合字段语义使该段只渲染一次 `# agentsMd`；不发 Selector 请求、
  不注入 `relevant_memory`；
- 若唯一生产常量切换为 `semantic-recall`，同一 runner 验证无 pointer/index，并在完整 tool
  continuation 后消费一次 `relevant_memory`；
- project root 已有事实不会被 dormant Recall 自动修改；
- 成功 Main turn 后的后台 Extraction、`MEMORY.md` pointer 更新、显式 drain 和文件落盘；
- Extraction provider request 在飞时关闭 session 会立即 abort；close 不等待其自然返回，迟到
  tool-use 不写文件也不触发下一轮；
- Extraction 完成后新建 session，从默认分支的 request user-context source 消费新 pointer，且仍
  不发 Selector 请求；
- custom agent persistent Memory prompt、tool projection、独立 root 和写入；
- Memory disabled 时无 Memory prompt、selector、Extraction 或 root 创建；默认 prompt 的
  `# Memory, notes and feedback` 段照常发送，不算 Memory 注入。
- `memory.extractionEnabled=false` 的 headless Runtime 仍保留 Main Memory prompt 与当前 retrieval
  branch，但显式 drain 后没有 Extraction request，已有 `MEMORY.md` 与事实文件保持不变；该断言按
  Main/Extraction 类别判断，不把 semantic direct-answer 时允许异步启动或取消的 Selector 当成
  Extraction gate 的证据。

运行：

`--memory-bench` 另外从 CLI `run` 入口启动真实子进程，注入隔离配置和 scripted provider，验证
阻塞 Extraction 时进程仍存活、写入后才退出，以及默认 headless、Memory 关闭与 SIGTERM 取消。
该 fixture 使用非流式 provider；CLI text/JSON/stream-json 的最终输出顺序由 `memory-bench.test.ts`
覆盖。独立运行 `pnpm --dir apps/zcode-cli/e2e/memory run e2e:bench`，产物路径打印在控制台，
包含各场景的 provider capture、生命周期顺序、stdout/stderr、最终 Memory 文件与结果。

```bash
pnpm --dir apps/zcode-cli run test:e2e:memory
```

复用已构建产物：

```bash
pnpm --dir apps/zcode-cli/e2e/memory run e2e -- --artifacts /tmp/zcode-memory-e2e
```

输出：

```text
provider-capture.json
trajectory.jsonl
trajectory-summary.json
memory-files.json
result.json
```

`trajectory.jsonl` 按 `main | selector | extraction | custom_agent` 分类保存真实 provider request；
证据校验根据构建产物中的 active branch 拒绝任何 pointer/index 与 Selector/Recall 混合组合。
冻结 fixture 另由 `memory-provider-body.test.ts` 直接校验请求体合同；Desktop WDIO 从真实抓包提取同一 `# Memory` 段和
`MEMORY.md` user-context source 复用该合同。
Dream 当前没有产品触发入口，因此不在这里增加测试入口；gate、lock、tool loop 和
`memory_update` 由 core runtime integration tests 覆盖，最终 Anthropic Messages 请求体由
`memory-provider-body.test.ts` 覆盖。

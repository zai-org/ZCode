import type { ZCodeCopy } from "../types.js";

export const zhCN: ZCodeCopy = {
  locale: "zh-CN",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `不支持的 --locale 值：${value}。支持的语言：en-US、zh-CN、auto。`,
    },
    help: (version) => `zcode ${version}

用法:
  zcode [command] [options]

不传 command 时，zcode 会打开全屏 TUI。

命令:
  app-server 运行 ZCode Protocol stdio app server
  commands   列出自定义 slash commands（\`commands list\`）
  doctor     检查运行时和打包假设
  login [zai|bigmodel]  通过浏览器授权登录
  logout     删除共享的 Z.AI 登录凭据
  plugins    管理插件与市场（\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`；别名 plugin）
  skills     列出本地 skills（\`skills list\`）
  tui        打开终端 UI
  version    打印 CLI 版本

选项:
  -h, --help       显示帮助
  -v, --version    显示版本
  -p, --prompt <text>  单次运行 prompt，不打开 TUI
  --memory-bench   配合 --prompt 开启自动 Memory 提取并等待后退出（需已开启 Memory）
  --browser-use <mode> 启用 Browser Use backend（当前支持：headless）
  --surface <surface>  设置无头 prompt/app-server 的呈现面：terminal 或 desktop
  --browser-executable <path> headless Browser Use 使用的 Chrome/Chromium 路径
  --attach <path>  给 --prompt 附加本地文件；可重复传入
  --cwd <path>     从指定目录运行命令
  --disallowed-tools, --disallowedTools <tools...>
    从本次 prompt/TUI 的可用工具集中移除整个工具，不修改持久化配置。
    工具名用逗号或空格分隔，例如 "Bash Edit"。
    "Bash(git *)" 也会移除整个 Bash，不支持按命令内容匹配。
  --toolsearch-mode <auto|native|local|off> ToolSearch 模式（默认 off，仅本次启动）
  --force-mcs      对 Anthropic provider 强制启用 mid-conversation system 投影
  --locale <locale>  UI 语言：en-US、zh-CN 或 auto
  --mode <mode>    prompt 权限模式：build、edit、plan、yolo 或 guarded（--prompt 默认 yolo）
  --resume <sessionId>  按 sessionId 恢复持久化 session（sess_...）
  --target <text>  在 headless 模式运行或设置 session goal
  --target-replace 替换 --target 已存在的 goal
  --workflow-mode <mode>  prompt/TUI 的动态工作流：disabled、onDemand 或 alwaysOn（默认 disabled）
  -c, --continue        恢复当前目录最近的 session
  --json           在支持的命令中输出机器可读 JSON
  --no-browser     不打开浏览器，只打印 OAuth URL
  --no-color       禁用 ANSI 颜色
  --verbose        打印更多诊断信息

Slash Commands:
  /help [command]       显示 slash command 帮助
  /login                使用 Z.AI OAuth 登录
  /logout               删除共享的 Z.AI 登录凭据
  /compact [instructions]  压缩当前对话
  /expert [status|resume|stop|<task>]  运行或管理 expert workflow
  /dwf [list|cancel|resume]  列出、取消或恢复 dynamic workflow run
  /fork [latest|checkpointId]  从 workspace checkpoint 派生新 session
  /mcp [list|status|connect|disconnect]  查看或管理 MCP servers
  /mode [mode]          查看或切换权限模式：build、edit、plan、yolo 或 guarded
  /model [id]           查看或切换当前 session 模型
  /new                  在 TUI 中开始新 session
  /resume [sessionId]   按 sessionId 恢复 session；省略时恢复当前 cwd 最新 session
  /rewind [latest|checkpointId]  查看最新 checkpoint 或恢复 workspace 文件
  /skill [name] [task]  列出 skills，或强制下一次 prompt 加载某个 skill
  /goal [action]        查看或设置当前 session goal
`,
  },
  tui: {
    approval: {
      fromSession: (sessionId) => `来自后台会话 ${sessionId}`,
    },
    copy: {
      copied: "已复制选中文本到剪贴板。",
      failed: "无法复制选中文本。",
      unavailable: "当前终端不可用文本剪贴板复制。",
    },
    effort: {
      disabled: "关闭",
      enabled: "开启",
    },
    input: {
      activeStatusHint: "esc to interrupt",
      busyPlaceholder: "输入内容会排队",
      placeholder: "输入提示词",
      queuedMore: (count) => `还有 ${count} 条排队中`,
      queuedSubmitHint: "下一次工具调用后提交。",
      queuedTitle: (count) => ` 队列（${count}） `,
      title: "输入",
      noHistorySource: "未配置输入历史来源。",
      noPreviousInput: "当前项目没有更早的输入。",
      restoredPreviousInput: "已恢复上一条输入。",
      restoredPreviousInputWithAttachments: (count) => `已恢复上一条输入，包含 ${count} 个附件。`,
      restorePreviousInputFailed: "无法恢复上一条输入。",
      typePrompt: "输入问题后按 Enter。",
    },
    loginRequired: {
      help: "输入 /model 查看模型，或输入 /login 连接 Coding Plan 账号。",
      message: "没有可用模型，请配置 Provider 或输入 /login 登录。",
      status: "没有可用模型，请配置 Provider 或输入 /login 登录。",
      title: "需要配置模型",
    },
    loginSetup: {
      emptyMessage: "没有可用的登录选项。",
      help: "使用 Up/Down 选择，Enter 确认。",
      options: {
        bigmodelApiKey: {
          inputPrimary: "输入 BigModel Coding Plan API Key",
          inputSecondary: "在这里粘贴 key，输入时会隐藏显示。",
          primary: "BigModel Coding Plan API Key",
          secondary: "手动粘贴 Coding Plan API key。",
        },
        bigmodelOauth: {
          pendingPrimary: "等待 BigModel 授权",
          pendingSecondary: "请在浏览器里完成登录，授权成功后会自动继续配置。",
          primary: "BigModel Coding Plan",
          secondary: "打开浏览器登录，CLI 会自动查询授权结果。",
        },
        zaiApiKey: {
          inputPrimary: "输入 Z.AI Coding Plan API Key",
          inputSecondary: "在这里粘贴 key，输入时会隐藏显示。",
          primary: "Z.AI Coding Plan API Key",
          secondary: "手动粘贴 Coding Plan API key。",
        },
        zaiOauth: {
          pendingPrimary: "等待 Z.AI 授权",
          pendingSecondary: "请在浏览器里完成登录。授权完成后会继续配置。",
          primary: "Z.AI Coding Plan",
          secondary: "打开浏览器登录，并创建 Coding Plan API key。",
        },
      },
      pending: {
        cancelStatus: "已取消登录。请选择配置方式。",
        help: "按 Esc 取消，并返回配置方式选择。",
        status: "正在等待浏览器授权...",
      },
      input: {
        cancelStatus: "已取消 API key 输入。请选择配置方式。",
        clearStatus: "已清空 API key 输入。",
        emptyStatus: "API key 不能为空。",
        help: "按 Enter 保存 key，按 Esc 返回配置方式选择。",
        placeholder: "粘贴 API key",
        status: "输入 API key 后按 Enter。",
        submitStatus: "正在保存 API key...",
      },
      prompt: "选择登录或 API key 配置方式。",
      response: "选择 Coding Plan 提供商的配置方式。",
      title: "配置 Coding Plan",
    },
    model: {
      requestFailed: (message) => `模型请求失败：${message}`,
      responseReceived: "已收到模型回复。",
      responseReceivedWithTokens: (tokens) => `已收到模型回复。${tokens} tokens。`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `将在 ${delay} 后重试模型请求 ${attempt}/${Math.max(1, maxAttempts - 1)}：${reason}`,
      streamStalled: "模型流式输出停滞。",
    },
    sidebar: {
      subagents: {
        title: "子代理",
        empty: "暂无子代理",
        emptyOutput: "子代理尚未产生输出",
        back: "← 返回主会话",
        readonly: "只读 · Esc 返回",
        loading: "正在加载子代理输出…",
        unavailable: "无法读取子代理输出",
        retry: "重试",
        more: "加载更多",
        pendingMain: "主会话需要你的输入，返回后处理",
        ended: (count) => `已结束 (${count})`,
        status: {
          running: "运行中",
          waiting: "等待输入",
          blocked: "阻塞",
          success: "已完成",
          failed: "失败",
          cancelled: "已取消",
          lost: "失联",
        },
      },
      api: {
        empty: "还没有 API 调用。",
        model: "模型",
        more: (count) => `还有 ${count} 条`,
        requests: "请求",
        server: "服务端",
      },
      cache: {
        hit: "命中",
        lastHit: "上次命中",
        lastMiss: "上次未命中",
        readWrite: ({ read, write }) => `读 ${read} / 写 ${write}`,
        total: "总计",
      },
      context: {
        cache: "缓存",
        cacheReadWrite: "缓存读写",
        inputOutput: "输入/输出",
        reason: "推理",
        tokens: "Tokens",
        used: "已用",
        window: "窗口",
      },
      modifiedFiles: {
        empty: "还没有文件变更。",
        more: (count) => `还有 ${count} 个文件`,
      },
      mcp: {
        empty: "未配置 MCP server。",
        loadFailed: "无法获取 MCP 状态。",
        loading: "正在加载 MCP 状态...",
        more: (count) => `还有 ${count} 个`,
        servers: "服务",
        status: {
          connected: "已连接",
          connecting: "连接中",
          disabled: "已禁用",
          disconnected: "未连接",
          failed: "失败",
          untrusted: "未信任",
        },
        summary: ({ connected, total }) => `${connected}/${total} 已连接`,
        tools: (count) => `${count} 工具`,
      },
      request: {
        complete: "完成",
        error: "错误",
        errorWithStatus: (statusCode) => `错误 ${statusCode}`,
        pending: "进行中",
      },
      status: {
        last: "最近",
      },
      run: {
        draft: "草稿",
        draftChars: (count) => `${count} 字符`,
        draftEmpty: "空",
        messages: "消息",
        mode: "模式",
        model: "模型",
        provider: "供应商",
        thought: "思考",
        trace: "Trace",
        turn: "回合",
        workspace: "工作区",
      },
      sections: {
        apis: "API",
        context: "上下文",
        mcp: "MCP",
        modifiedFiles: "变更文件",
        run: "运行",
        status: "状态",
        todos: "Todos",
      },
      shellSubtitle: "OpenTUI 终端",
      title: "侧边栏",
      todos: {
        empty: "还没有 todo。",
        more: (count) => `还有 ${count} 项`,
        progress: "进度",
      },
    },
    status: {
      compactFailed: "上下文压缩失败。",
      compacted: "对话已压缩。",
      compacting: "正在压缩上下文...",
      interruptedStreamDiscarded: "已丢弃中断的模型流。",
      modelCalling: "正在调用模型...",
      permissionRequested: (toolName) => `正在请求 ${toolName} 权限。`,
      permissionResolved: (toolName) => `${toolName} 权限已处理。`,
      ready: "就绪。",
      recoveringStream: "正在恢复中断的模型流...",
      retryingStream: "正在重试模型流...",
      sessionResumed: "Session 已恢复。",
      targetChanged: (action) => `目标 ${action}。`,
      thinking: "思考中...",
      toolCompleted: (toolName) => `工具 ${toolName} 已完成。`,
      toolFailed: (toolName) => `工具 ${toolName} 失败。`,
      toolPending: (toolName) => `工具 ${toolName} 等待中。`,
      toolRunning: (toolName) => `工具 ${toolName} 运行中。`,
      turnFailed: "本轮失败。",
    },
    terminal: {
      starting: "正在启动 ZCode… Ctrl+C 退出",
      requiresInteractive: "TUI 需要交互式终端。",
    },
    transcript: {
      compact: {
        completed: "上下文已压缩",
        failed: "上下文压缩失败",
        interrupted: "上下文压缩已中断",
        retry: (command) => `Ctrl-R 重试 ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `正在重试压缩上下文（${attempt}/${maxAttempts}）`
            : "正在重试压缩上下文",
        skipped: "上下文已是最新，无需压缩",
        started: "正在压缩上下文",
      },
      roles: {
        agent: "Agent",
        system: "System",
        user: "User",
      },
      thought: {
        complete: "思考",
        thinking: "思考中...",
      },
      title: "对话",
      workflow: {
        actors: "actors：",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `用量：${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `工作流 ${label} - ${status}（${nodesSettled}/${nodesTotal} 步）`,
        error: (message) => `错误：${message}`,
        expandHint: "+ 展开",
        collapseHint: "- 收起",
        log: "日志：",
        nodes: ({ nodesSettled, nodesTotal }) => `已结算 ${nodesSettled}/${nodesTotal} 步`,
        result: (preview) => `结果：${preview}`,
        status: {
          completed: "已完成",
          errored: "出错",
          pending: "待启动",
          running: "运行中",
          stopped: "已停止",
        },
        stopReason: {
          user: "你停止的",
          model: "代理停止的",
          provider: "模型侧错误",
          interrupted: "进程已退出",
          superseded: "已被调整后的 run 替代",
        },
        truncated: "（已截断——完整事实在 run 的事件日志里）",
        interruptedNotice: ({ label, runId }) =>
          `工作流 ${label} 被打断，可恢复：/dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter 选择，Esc 取消",
      disabled: (reason) => ` [已禁用：${reason}]`,
      filterLine: ({ filter, help }) =>
        `筛选: ${filter || "-"} | ${help ?? "Enter 选择，Esc 取消"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "没有匹配的工作区路径。",
      loading: "正在读取工作区路径...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "文件",
    },
    slash: {
      title: "命令",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};

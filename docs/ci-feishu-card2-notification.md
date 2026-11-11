# CI 构建产物飞书 Card 2.0 通知

## 范围

本规范覆盖 notify 之前的测试、CUA Helper、公共 desktop 构建、远程资源与远控前端、CLI
打包过程，以及 `notify:feishu:<platform>:<arch>` 平台结果通知。正式发版通知
`release:notify:feishu` 保持原流程。sandbox/test tag 仍跳过通知；通知失败不改变原任务结果。

## 过程通知与平台收敛

- `notifyCiResult` 是共用卡片和发送入口，接受过程名称、成功/失败结果、摘要及操作链接；
  统一处理人员、文本转义、卡片大小、收件人、超时和有界重试。桌面、过程和 CLI 共用此入口。
- 测试、Helper、公共 desktop 构建、远程资源、远控前端由原 job 的 `after_script` 调用，
  仅在 Runner 提供的 `CI_JOB_STATUS=failed` 时发送失败通知，成功不通知，避免主包产出前刷屏。
  主包平台打包仍发送成功/失败结果；CLI 成功通知仍由上传后的独立入口发送。
  取消、超时未进入 after_script、
  Runner 崩溃及获取源码失败不保证通知；不把未运行当作成功。不新增过程通知 job。
- after_script 使用独立 shell，macOS 重新加载 Node；Windows 使用 PowerShell 的 Node
  初始化入口，Linux 使用 runner 的 Node。不依赖主 script 临时 export 的变量。
- notify 阶段只有六个实际 job（macOS/Windows/Linux × ARM64/x64），每个平台同时处理
  成功和失败；删除独立的 `notify:feishu:failure:*`。共享平台规则未显式指定 when 时，
  build 使用默认 on_success，notify 使用 always，未选平台仍为非阻塞 manual。
- 每个 notify job 仍只依赖对应平台 build，不等待其他平台。使用同一 pipeline 的 GitLab
  Jobs API 查询该 build 的最终状态和 URL；处理分页、只取最新尝试。只对 success/failed
  发送；manual/skipped/canceled/running 等状态跳过，不推断为成功。API 查询有超时。
- 查询 build Job 时，平台变量映射为 Job 名称：`darwin → macos`、`win → windows`、
  `linux → linux`，架构使用原 `ARCH`。映射只用于 Job 匹配，保留原平台变量及产物地址。
  未知平台记录 warning 并跳过，不按原值推断 Job 名；新增平台须同时补映射和 CI 配对校验。
- 上游失败由上游自己的过程通知覆盖，平台被跳过时不重复发平台失败消息。
- CLI 保留成功时的下载和 Job 按钮；失败由原 CLI job 的 after_script 调用统一入口，
  成功时不重复通知。
- 自动重试只对同一个不可变结果重发；显式重跑 job 视为新的尝试，不维护第二套状态文件。
  网络响应丢失时服务端可能已投递，现有服务没有幂等契约，不能承诺通知恰好一次。

```text
前置 job script → Runner 结果 → after_script → 仅 failed → notifyCiResult → 飞书通知服务
平台 build     → 对应 notify（always）→ Jobs API 最终结果 ──────┘
CLI build/upload → 成功时 notifyCiResult；失败时 after_script ──┘
```

实施顺序：先覆盖通用卡片、结果选择、分页/重试与 CI 编排回归，再实现共用入口和 job 接线，
最后运行类型、lint、架构、受影响单测及本地 HTTP 假服务验证；真实 runner 和飞书投递另列验证边界。

## 消息契约

通知由 CI 脚本组装 Feishu Card 2.0，交给 zcode-internal 的通用飞书通知服务发送：

```
POST <ZCODE_FEISHU_NOTIFY_BASE_URL>/api/v1/feishu/messages
Authorization: Bearer $ZCODE_FEISHU_NOTIFY_TOKEN
```

服务用 ZCode Infra 应用投递，CI 侧不再持有飞书应用凭证。`scene` 为
`ci.build.completed` / `ci.build.failed`；收件人优先用 CI 自己的 `FEISHU_RECEIVE_ID`
（显式传给服务），未配置时回落到服务端的场景默认收件人。原 Template 所使用的字段保持不变：

- 标题：`构建完成 · 测试/生产 · <平台架构> · <分支名>`
- 分支：`CI_COMMIT_REF_NAME`（仅在标题展示）
- 提交人：`CI_COMMIT_AUTHOR`
- 提交信息：`CI_COMMIT_MESSAGE`

相关人员优先 @触发打包的人。控制台从服务端登录会话（任务队列从已保存的任务所属用户）
取得飞书 `open_id`，通过流水线变量 `ZCODE_BUILD_TRIGGER_OPEN_ID` 传入，不能由浏览器请求体指定。
该变量去除首尾空白后符合 `^ou_[A-Za-z0-9_-]+$` 时，直接生成 `<at id=ou_xxx></at>`，
不再自动 @提交作者；变量缺失、为空或格式无效时，沿用 `{{mention:<CI_COMMIT_AUTHOR>}}`
占位符，由通知服务用统一的「人员配置」目录解析。提交人和提交信息仍分别显示
`CI_COMMIT_AUTHOR`、`CI_COMMIT_MESSAGE`，不替换成触发人。

`FEISHU_MENTION_OPEN_IDS`（逗号分隔的飞书 `open_id`）仍用于额外 @人员，和触发人去重后
直接内联。作者占位符未命中时仍退化为纯文本，不伪造 @。规则同时用于成功和失败通知。
没有传入触发人变量的旧调用方保持原逻辑；被打包分支需要包含新版通知脚本才支持此优先级。

```text
服务端会话 / 已保存的任务用户 → ZCODE_BUILD_TRIGGER_OPEN_ID → 优先 @触发人
                                                          └─ 无有效值：@commit 作者
CI_COMMIT_AUTHOR / CI_COMMIT_MESSAGE → 提交人 / 提交信息（保持原值）
```

成功卡片不在正文直接展示产物 URL，而是在正文底部提供“下载产物”按钮；失败卡片不展示产物 URL，
在正文底部提供“查看失败 Job”按钮，跳转到同一流水线中对应失败构建 Job 的 `web_url`；该地址由
`notify-feishu-ci.mjs` 使用 CI 变量 `GITLAB_ACCESS_TOKEN`（或兼容的 `GITLAB_PRIVATE_TOKEN`）查询 GitLab Pipeline Jobs 得到。对应 URL 缺失时不渲染按钮；查询失败时打印原因并跳过通知，不改变流水线状态。成功平台通知同样需要该查询凭据。
两个按钮均使用 `default` 描边样式和 `default` 自适应宽度。

环境、架构、触发人和分支只在标题或内部变量中处理，不再作为正文独立字段展示。卡片使用 Card 2.0
`schema: "2.0"`、蓝色 header 和浅色信息块；按钮仅用于打开产物或 Job 地址，不新增外部回调
或其他业务交互。长文本必须在卡片 JSON 中安全转义，并设置与飞书请求限制
匹配的大小校验；提交人和提交信息作为不可信输入统一转义 Markdown/HTML 特殊字符，并限制长度。

构建失败时为对应平台增加失败通知：标题将“构建完成”替换为“构建失败”，正文展示提交人、
提交信息并提供 GitLab Job 地址按钮；失败卡片不展示产物下载地址。触发人和分支不作为正文独立字段展示。
成功卡片使用蓝色 Header 与 `success_colorful` 图标，失败卡片使用红色 Header 与
`fail_colorful` 图标，确保两种状态在通知列表中可以快速区分。

配置 `FEISHU_HEADER_ICON_IMAGE_KEY` 后，Header 改用飞书 `custom_icon` 展示 ZCode
Logo；该 key 必须由同一个飞书应用在具备 `im:resource:upload` 或 `im:resource` 权限后
上传 `public/icon_512@2x.png` 获得。未配置时回退上述成功/失败标准图标。

## 配置与测试

需要新增 GitLab CI/CD 变量 `ZCODE_FEISHU_NOTIFY_TOKEN`（与服务端同值），可选
`ZCODE_FEISHU_NOTIFY_BASE_URL`（默认 `http://intranet.example.invalid:3011`）。生产接收方仍由
GitLab 的 `FEISHU_RECEIVE_ID` 提供。构建通知单元测试和后续手动验证统一使用临时测试群
`oc_5725795450da6920872fdb25412848bf`，不得把该测试群写入生产 CI 默认配置。

构建通知只有这一条发送链路：CI 侧不持有任何飞书应用凭证，`FEISHU_APP_ID` /
`FEISHU_APP_SECRET` 与该脚本无关。缺少 `ZCODE_FEISHU_NOTIFY_TOKEN` 时记录配置错误并跳过投递，
不会静默降级到别的发送身份——否则群里会混入非 ZCode Infra 的机器人。

## 失败边界

通知服务调用失败时重试一次；两次都失败时返回 failed 结果并打印原因。
共用发送入口捕获最终错误并记录 warning；wrapper 以零退出。查询凭据、API、卡片和发送错误
均不得改变构建、发布和后续流水线状态。

## 回归要求

- 成功/失败卡片、摘要、多个链接、文本转义和现有 Preview/CLI 身份兼容。
- 每个平台只有一个结果 job；沿用平台选择和对应 build 依赖，Preview 仍只有 ARM64。
- 真实 job 状态选择、分页、重试后的最新结果；非最终状态不发送。
- 覆盖三种平台与两种架构的 Job 名称映射；Windows 成功/失败结果通过真实 Node 入口和
  本地 Jobs/通知服务验证投递，避免只验证 CI needs 配对而遗漏运行时名称匹配。
- 展开主流水线和 Preview 的 YAML 后，用实际 `TARGET_OS/ARCH` 调用生产 Job 选择函数，
  校验其匹配的 build Job 与 `needs` 声明一致；未知平台不得投递并须记录 warning。
  `build:desktop:app` 在依赖准备后的公共门禁中执行通知回归，配对漂移须阻断后续打包。
- after_script 覆盖前置过程且保留主脚本退出码；通知错误不使原任务失败。
- 前置过程的 success/canceled/running 不发送，failed 发送；主包成功/失败及 CLI 成功通知保留。
- 发送使用本地 HTTP 假服务验证请求、重试与失败边界，不向实际飞书群投递测试消息。

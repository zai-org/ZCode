# Desktop OAuth 轮询登录

## 目标

Z.AI 与 BigModel Desktop 登录不再把 `zcode://oauth/callback` 作为唯一完成路径。App 使用 ZCode
后端已有的短期 OAuth flow，在浏览器完成授权后轮询 flow 状态；deep link 仍保留为兼容路径。
轮询接口的 `provider` 使用 `zai` 或 `bigmodel`，两者共享 flow 生命周期，但 `ready` 凭据字段按 provider 区分。
BigModel 创建 flow 后，App 把授权地址中的回调改为官网旧中转页
`https://zcode.z.ai/app/oauth/login`（测试环境使用对应测试站点），中转页继续把 `authCode/state`
透传到 `zcode://oauth/callback`；Host 中的 polling flow 同时保留。

## 时序

```text
Desktop App                 ZCode Backend                 Browser / Z.AI
    | POST /oauth/cli/init        |                              |
    |---------------------------->|                              |
    | flow_id + authorize_url     |                              |
    |<----------------------------|                              |
    | open authorize_url --------------------------------------->|
    |                             |<---------- OAuth callback ---|
    | GET /oauth/cli/poll/:id     |                              |
    |---------------------------->|                              |
    | pending / ready / failed    |                              |
    |<----------------------------|                              |
    | persist once + refresh UI   |                              |
```

BigModel 双路径：

```text
BigModel Browser
    | authCode/state
    v
ZCode Website /app/oauth/login -----> zcode://oauth/callback -----> Desktop deep link
                                                                    |
Desktop Host ---------------- GET /oauth/cli/poll/:id --------------+
```

Desktop 构造官网中转地址时携带编译期 `app_version`。Website 仅对严格大于 `3.9.1`
的有效版本启用无自动 deep link 的 polling bridge；`3.9.1`、更低版本、缺失或非法版本
继续使用原自动 deep link，避免旧版 App 因不具备 polling 完成能力而停留在登录中间态。

快速连续发起登录时，后一次请求拥有 flow；先发但后返回的 init 响应视为 stale，不得覆盖新 flow：

```text
App                  init A                  init B                  Host pending
 | start A ------------>|                                              |
 | start B ---------------------------------->|                         |
 |                         |<---- A returns    |                         |
 |                         |      stale, drop  |                         |
 |                         |                   |<---- B returns          |
 |                         |                   |------------------------>| flow B
```

## 契约与边界

- App 为每次登录生成 32 字节随机 `poll_token`，只通过 `Authorization: Bearer` 发送，
  不写入日志、设置或 URL。
- `init` 返回的 `flow_id`、`expires_at` 和 `poll_interval_sec` 只保存在 Host 内存。
- App 只接受 HTTPS `authorize_url`、未来的 `expires_at`，以及至少 1 秒且小于 flow 剩余寿命的
  `poll_interval_sec`；异常服务端响应直接终止，不打开外部地址。
- Root 常驻层查询 Host 中的 pending flow；没有 pending flow 时不得产生网络请求。
- 只有 `zai`、`bigmodel` 使用 polling；扩展 provider 仍走原 deep link 流程，不启动 Root 空轮询。
- BigModel 的浏览器回调使用官网 `/app/oauth/login?redirect=zcode://oauth/callback`，不得直接展示
  `/oauth/cli/callback/bigmodel` 的成功或失败页面；修改回调地址不取消 Host polling。
- `pending` 按服务端间隔继续查询；`ready` 原子落盘一次并结束；`failed`、过期、取消或
  业务错误结束当前 flow。
- 相邻 polling 的间隔使用 Host 单调时钟，系统时间回拨不能阻止到期后的下一次查询。
  初始化、polling 和回调的 `expires_at` 校验仍使用系统时间；本地等待仍受五分钟上限约束。
  此分工不放行过期响应，也不把服务端绝对期限替换成固定 TTL。
- 未知 poll status、字段类型错误或 provider 对应 token 缺失按协议错误失败，不抛出 JS 类型异常。
- `OAuthService` 是登录完成的唯一 owner。deep link 与 polling 结果按到达服务的顺序串行处理，
  校验、token 兑换/归一化和落盘都在同一完成边界内。先到路径成功后，后到路径不再校验或兑换；
  先到路径失败时，已到达的另一条路径继续独立处理，不能复用失败的 Promise。
- 有另一条完成路径等待时，失败必须等其结果；另一条成功则忽略先前失败。deep link 单独失败
  不取消有效 polling；polling 的终态错误在没有可用候选或候选均失败后才结束 flow。
- 回调的 `channel_id`、`utm_source`、`utm_campaign` 与登录结果分开处理：当前 flow 的回调仍保存
  参数；polling 先成功后，同 state 的迟到回调在原 30 秒去重窗口内仍保存归因，但不再解析授权码
  或请求 token。错误 state、取消或已被新 flow 替换的回调不得写入。已有 authorize URL 参数、
  `app_version`、redirect 和 state 的传递规则保持不变。
- 只有仍属于当前 pending flow 的结果可以落盘；取消、切换登录后，旧 HTTP 结果（包括 4xx）
  不得清理新 flow 或覆盖已完成登录。
- 新登录开始前取消旧的本地 pending flow；用户取消也会废弃尚未返回的 init 响应。当前后端没有
  cancel 接口，取消只停止 App 查询，后端 flow 依靠 TTL 过期。
- Web `/remote`、shared-host attachment、session/task realtime 与 replayable 恢复链路不变。

## 验收场景

- Z.AI 或 BigModel deep link 未返回时，polling `ready` 仍能完成登录和既有 Coding Plan 刷新。
- deep link 先完成时停止 polling；polling 先完成时忽略迟到 deep link。
- 用户取消、开始新登录、flow `failed`、flow 过期后不再落盘。
- 快速连续开始两个 flow 时，较晚发起的 flow 保持有效，迟到的旧 init/poll 不得覆盖它。
- BigModel 使用原官网中转页兼容 deep link，同时保留 polling flow。

### 双路径竞态回归

```text
回调 / poll 响应 → Host 完成队列 → 校验与兑换 → 保存一次
                          ├─ 成功 → 后续候选跳过（归因仍保留）
                          └─ 失败 → 下一个候选独立校验与兑换
```

- 两种到达顺序均覆盖：先到成功、先到失败后另一条成功、两条均失败。
- 后到候选在先到候选完成前不能开始解析授权码或归一化 token。
- 回调等待期间、polling 成功后到达的归因参数都要保留；旧 flow 参数不得覆盖新 flow。
- 服务层受控 Promise 验证微观时序；桌面 E2E 通过真实 Host HTTP 和 preload 回调验证失败回退后
  UI 成功且没有登录失败提示。手机远控没有增加新的 OAuth 入口或修改 continuous/replayable 链路。

### 回调取消与错误归属

- 已接收的回调因取消或新 flow 而失效时返回 `null`；Root 静默忽略，不更新用户、成功状态或错误提示。
- 两条路径均失败时，各调用方收到自己路径的原始错误；等待备用路径不能覆盖首条路径的诊断信息。
- 成功后的 30 秒去重窗口按回调进入服务的时间判断。pending 期间已接收或窗口内接收的回调，
  不因排队超过窗口而丢失归因；窗口结束后新收到的回调仍拒绝。取消、新 flow 的隔离优先于此规则。

```text
窗口内收到回调 → 入队 → 等待超过 30 秒 → 仍保存归因
窗口结束后收到新回调                  → 拒绝
取消 / 新 flow → 旧回调返回 null → Root 忽略
```

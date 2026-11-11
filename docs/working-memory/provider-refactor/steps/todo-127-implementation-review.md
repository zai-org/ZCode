# Todo127 实施、验证与复审

## 实现边界

2026-09-11 Goal 授权实现。沿用现有分层与 Release schema，不新增数据迁移，不恢复已删除字段，不修改其他 client/configs 消费者。

```text
App / Server Environment       Standalone Prompt / TUI
既有 ApiClient                 既有 fetch
             \                /
       provider-node 共用 URL 下载
       控制面 → HTTPS CDN → 校验 → Active
                         │
                   Config 变化
                         │
             AccountProviderService
       Built-in / 凭据共用串行、过期结果丢弃
                         │
                同版本 Registry 发布

Environment 每分钟检查
  ├─ 下载：既有 lease + TTL + 失败退避
  └─ 仅未对齐时重建 Account（不受下载结果阻挡）
Managed Worker：只消费文件和 Host Account，不拥有下载循环
```

- 两阶段总预算 20 秒含正文；真实字节上限 10,000,000；HTTPS CDN、禁止 URL userinfo，不跟随重定向，无账号头／Cookie。失败仅报告阶段、schema 路径／错误类别，不输出 URL query、正文或 Key。
- 成功间隔一小时；失败 1/2/4 分钟直到一小时；30 秒 lease；显式刷新绕过 TTL 不绕过 lease。正常检查 debug，更新 info；取消不计算网络失败。
- CLI Entry 只物化随包资源并传路径；新增 bundled 环境路径仅用于长生命周期 Standalone。Managed 即使继承该环境字段也不创建下载器。
- Account 源从当前 Config 构造，凭据与 Built-in 复用一个刷新队列；旧异步结果不发布。首次并发 read 合并，不把第二个读者误当新事实造成 fail-closed 后再次启动失败。
- Account 重建失败保留完整旧 Registry；一分钟检查只在版本未对齐时重建，不重新登录、申请 Key 或强制重下 CDN。
- 保留 Registry 版本护栏、固定执行、原 Personal／Selection。修复退出时迟到 Active 写入，文件锁收尾仍异步完成。

## 验证对应

| 条目           | 证据                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR117-01/02/03 | `zcode-builtin-download.test.ts`：新 URL、缺字段、HTTP/JSON/schema/正则/CEL、10 MB 两侧、两阶段合计20秒、取消；Services 测试使用真实 NodeApiClient 装配，无鉴权扩散    |
| BR117-03       | `zcode-builtin-http.test.ts`：真实 HTTP 先返回头但正文不结束，约20秒取消 socket，下一次请求成功；CDN 测试传输映射到本机，不代表真实 CDN TLS 实测                       |
| BR117-04/05    | Release 16项 + lifecycle 2项：lease/force/版本/Endpoint/退出、分钟调度、1小时 TTL、1/2/4/8/16/32/60分钟退避；保留旧 owner 不覆盖控制文件机制                           |
| BR117-06       | Bootstrap 12项：新增长生命周期两阶段下载→Active→Registry；凭据不变/无账号仍跟进，Managed 不下载；既有真实凭据变更、失效、首次读取失败继续通过                          |
| BR117-06/07    | AccountService 9项，过期 Built-in 查询不发布；`providerBuiltinRecovery.test.ts` 使用真实 Config/Account/Registry，失败保留旧版本，TTL 内下一分钟只恢复 Account         |
| BR117-08       | `zcode-builtin-consumption.test.ts`：新 Registry 模型更新、原已取得配置不变、Personal 逐字节不变、个人覆盖及选择保留；真正已创建 Core Model 的整批执行验证仍需最终合批 |
| BR117-09       | `zcode-builtin-process.test.ts` 两个真实子进程观察原子文件替换，所有输出 Built-in 与 Account 同版；Linux 与 Pro macOS 均通过，Windows 未测 |
| BR117-10       | Pro 完整 Electron BR117-N02 通过：设置刷新→正式 HTTPS 下载→Registry→新 Model wire；手机 shared-host／SSH 联合验收仍未测，没有修改 continuous/replayable 协议 |
| BR117-11       | Todo113 第二轮后的最终 revision22 文件14项通过，SHA256 见整批最终复审；此前 revision21 副本是历史证据，不代表线上已发布 |

根 typecheck、CLI Bootstrap/CLI typecheck、根 lint（0错误、42既有警告）、architecture（0新增/0总违规）通过。合批初次 479通过/2失败：一项是 Todo128 新局部参数误用了已退出名称 `providerRevision`，已改为真实语义 `registryRevision`（不改行为）；另一项是测试在后台 lease 落盘未收尾时删除临时目录，改为等待刷新完成。两个对应文件后续55项通过。没有放宽边界测试或添加休眠兜底。

复审日志：`/tmp/provider127-{all-unit,review-fixes,standalone3,entry,integration,recovery,consumption,api-client,artifact,types2,cli-types,lint,arch}.log`。真实 HTTP+进程测试2项通过；CLI Entry4项通过。完整性副本 `/tmp/provider127-release-FPDKMA/zcode-builtin-21.json` 的 SHA256 为 `e9403074ad99eca33538d8c76cc6cce9bffeca8daa84f767c44a2c51151cad08`。

## Pro 补充验收（2026-09-12）

- `zcode-builtin-http/process/consumption.test.ts` 在 Pro Node24.14.0／Darwin arm64 三文件三项通过。真实慢正文在20秒预算取消、随后重试；两个真实进程各自发布同版 Built-in／Account；Personal 字节及覆盖、已取得配置对象保持。日志 `/tmp/provider-20260912-pro-builtin-runtime.log`。配置对象保持不冒充已创建 Core Model 的冻结证明，后者仍由整批 SDK/Core 用例覆盖。
- 新增 accepted pending BR117-N02，实际 Electron 应用从隔离测试 HTTPS 控制面取得版本化 CDN URL；仅变更控制面返回的新 URL，点击设置页刷新，容量500K→700K。刷新前后实际连接测试请求的 `top_p` 分别为0.17／0.37，模型身份相同；Personal 逐字节不变，预置最近选择缓存也不变。不 mock 下载器、Registry、平台或 Model，不写 Active，不读取日常账号，不发布真实 CDN。
- 用例：`packages/desktop/test/e2e/settings/providers/provider-builtin-refresh.test.ts`。本机模型响应为 synthetic / fast-text，manifest 明确两次请求，不声明无模型请求；控制面和 CDN 由已有 MITM 测试代理响应，使用配置 CA，未放宽产品 HTTPS 校验。
- 设置页刷新不变成业务发送前等待，本例仍沿用既定 Host 更新通知／Account 对齐路径。它不覆盖运行中的 Model，不替代付费账号权益或手机／SSH 验收。
- 首轮与补充持久选择断言的第二轮均通过；第二轮证据误写在 afterSession 会清理的测试工作区，改用现有报告目录保留网络及 wire，未改产品。最终结果见整批最终复审。

## 线上前置与未完成部分

控制面与 CDN 实际 HTTP200，但新版共用下载器拒绝线上 revision19：两个模板 access 仍含 `teamApiKeyManagementUrl`。这是本轮已明确删除字段的旧发布产物，不恢复兼容。保留本地/LKG；新版本化 URL 发布由有权限的人执行，未自动上传或改线上指针。

实际发布前运行：`ZCODE_BUILTIN_RELEASE_TEST_FILE=/绝对路径/最终文件.json pnpm exec vitest run packages/provider-node/test/zcode-builtin-integrity.test.ts`，记录文件 hash；上传后比对下载 hash。不能用当前副本的通过代替后续 Todo113 改动的最终文件验收，也不能以 decoder 通过代替完整性断言。

本项代码、桌面刷新整链及最终文件检查已完成；手机／SSH、Windows 和真实上线验证限制仍留在 Goal，不转交102掩盖，也不宣告全部上线验收完成。

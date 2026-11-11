# ZCode stdio Tap Proxy

开发环境可以通过 Help 菜单打开 `Capture Agent stdio Traffic`，让 app 和 ZCode Agent 之间的 stdio NDJSON 经过旁路 proxy。

## 行为

- 仅本地开发运行时显示菜单项并生效，测试/正式安装包不显示。
- 开关状态写入 `~/.zcode/v2/dev/zcode-stdio-tap.json`。
- 抓包文件写入 `~/.zcode/v2/dev/stdio-traffic/<workspaceHash>/`。
- `latest.txt` 指向最近一次 proxy 生成的 `.ndjson` 文件。
- 已运行的 agent 不会被重启；开关只影响后续新启动的 agent 进程。

## 查看

`apps/dev-docs` 的 `stdio 抓包` 页会通过本地 Vite API 读取
`~/.zcode/v2/dev/stdio-traffic` 下最近更新的 `.ndjson` 文件，并按 record 时间倒序显示。
状态显示为 `real tail` 时，数据来自真实 tap 文件；`mock replay` 只用于手动演示，不代表真实 agent 通信。

```sh
cat ~/.zcode/v2/dev/stdio-traffic/<workspaceHash>/latest.txt
```

拿到 `latest.txt` 里的文件路径后：

```sh
tail -f <traffic-file>.ndjson
jq 'select(.direction == "app-to-agent") | .message' < <traffic-file>.ndjson
jq 'select(.id == 7)' < <traffic-file>.ndjson
```

每条 record 保留 `direction`、`raw`、`message`、`parseError`、`id`、`method`、`sessionId` 和 `inputId`。`raw` 是原始 stdio 行，`message` 是可解析 JSON 的结构化副本。

凭据加解密请求 `interaction/requestCredentialCipher` 的参数，以及匹配的反向回复，
在 `raw` 和 `message` 中均隐藏，只保留通信元数据。转发给对端的原始字节不变；
不能因开发抓包而把凭据明文落盘。

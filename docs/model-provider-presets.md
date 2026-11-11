# Model Provider Presets

## 当前边界

- 自动刷新的预置供应商只包含当前 Z.ai 与 BigModel 的 API Key、Coding Plan 和 Start Plan 入口。
- `default-*` 自定义供应商模板已移除，不再在刷新预置供应商时补齐 OpenRouter、Moonshot、MiniMax、DeepSeek、MiMo、Qwen 等默认模板。
- codex/claude/gemini 官方 OAuth 不再作为模型供应商设置入口，也不再暴露 model provider service RPC。

## 远端模型能力补齐

- `client/configs.builtinModels` 下发的是按模型 ID 复用的官方模型事实，不只服务于 builtin provider。
- 每次预置供应商同步完成后，所有 provider 都可以为已有模型按模型 ID 获取远端 `reasoning` 和 `modalities` 补齐，包括 Start Plan 和用户创建的 custom provider；该链路不新增或删除模型。
- 模型 ID 使用 `trim + lowercase` 后的完整字符串匹配；不做别名、前后缀、子串或模糊匹配，命中后仍保留本地 provider 中的模型 ID。
- `reasoning` 采用 fill-only 规则：本地没有时使用远端事实，本地已经配置时完整保留。`modalities` 在 `modalitiesConfigured !== true` 时按 input/output 分侧合入；用户明确配置后完整保留本地值。该链路不覆盖 context window、max output tokens 或其它本地模型 metadata。
- Start Plan 的模型集合仍由 billing/balance 权益决定；通用补齐只 enrich 套餐已有模型，禁止按 `builtinModels` 扩大套餐可选范围。

## GLM 默认模型

- Z.ai / BigModel API Key 预置供应商的默认 GLM 模型列表固定为：`GLM-5.2`、`GLM-5-Turbo`。
- Z.ai / BigModel Coding Plan 预置供应商的默认 GLM 模型列表固定为：`GLM-5.2`、`GLM-5-Turbo`。
- Start Plan 免费入口模型列表固定为：`GLM-5.2`、`GLM-5-Turbo`。
- Z.ai / BigModel 的 API Key 入口允许用户自定义模型 context window；用户保存的显式值优先于预置默认值，设置页与 `config.json` 必须保持一致。
- Z.ai / BigModel 的 Coding Plan 与 Start Plan 入口允许用户手动追加模型配置；本地保存的用户模型只表达客户端可选模型，不改变服务端套餐权益、白名单或额度校验。
- Z.ai / BigModel 的 Coding Plan 与 Start Plan 入口中的 `GLM-5.2` context window 固定为 `1_000_000`，设置页模型列表统一使用英文 compact token 表示（如 `128K`、`1M`）。
- 默认列表顺序就是 UI 和模型选择的优先展示顺序；远端或本地同步逻辑不得把已托管的旧 GLM 模型重新插入默认列表。
- `GLM-5.1` 不再进入 Z.ai / BigModel API Key、Coding Plan 或 Start Plan 的默认模型选择。

## Start Plan 命名

- `builtin:zai-start-plan` 的固定展示名为 `Z.ai - Coding Plan`。
- `builtin:bigmodel-start-plan` 的固定展示名为 `BigModel- Coding Plan`。
- 旧版本已落盘的中文名或 `Start Plan` 名称只作为历史数据读取，展示层需要按以上固定名称规范化。
- 中文界面的购买入口 banner 中，Start Plan 入口标题展示为“体验套餐”；英文界面继续展示为 `Start Plan`。

## Coding Plan 详情页

- 已开通 Coding Plan 时，详情页保留 URL、Models 等配置内容；Models 允许用户手动追加，点击状态卡的升级入口只打开购买流程，不替换或隐藏下方配置区。
- 未登录、未连接、未开通、查询中或权益获取失败时，详情页只展示 Coding Plan 状态卡和下方提示 banner，不展示 API Key、URL、Models 等配置内容，避免把托管套餐入口误导成手动配置入口。Start Plan 待生效（`pending`）同样不展示 Models：套餐卡显示生效排期，模型区只在权益实际可用后出现。
- BigModel 未登录时，详情页不展示体验套餐标题或体验额度说明，只在状态卡下方展示“Start Plan”“个人套餐”“团队套餐”三个全宽入口 banner；Start Plan 使用 Start Plan 额度 banner 的绿色弱强调背景，个人套餐和团队套餐分别使用 Pro 蓝、Max 金色彩，并采用 Start Plan 同款左上径向渐变方向，包含裸图标、标题、说明和右侧箭头。若 150% 配额活动配置可用，未登录的“个人套餐”和“团队套餐”入口标题旁都展示 compact 活动徽标。
- BigModel 已登录但 Start Plan 和 Coding Plan 都没有权益时，详情页不展示体验套餐标题或体验额度说明，只在状态卡下方展示“个人套餐”和“团队套餐”两个全宽入口 banner；个人套餐和团队套餐分别使用 Pro 蓝、Max 金色彩，并采用 Start Plan 同款左上径向渐变方向，包含裸图标、标题、说明和右侧箭头。
- Upgrade Coding Plan 中不可点击的套餐行动按钮统一使用 outline disabled 样式；可购买 / 可升级 / 可续费按钮继续使用默认主按钮样式。售罄、当前套餐、已包含、不可购买和计费周期不可选都属于 outline disabled。
- BigModel 已登录且企业套餐 pricing 已返回时，团队入口不再显示单个泛化“团队套餐”banner，而是复用 Upgrade Coding Plan 团队套餐分组渲染多个团队 banner，例如“标准版”“高级版”，价格也来自对应团队套餐商品。未登录或团队 pricing 尚不可用时继续保留单个“团队套餐”引导入口。
- 个人套餐入口 banner 需要在已登录且购买 token 可用时前置展示售罄状态；当个人套餐商品均为 `soldOut` 时，原价格位置显示“暂时售罄”，不再显示最低价。未登录时不展示售罄状态，继续显示正常入口和价格兜底。
- Z.ai 当前没有团队套餐，购买面板和详情入口都只展示个人套餐，不展示团队套餐入口。
- BigModel 团队套餐列表卡片只用边框和背景表达选中态，不显示“已选择”文字标签。
- 已开通 Start Plan 或 Coding Plan 时，点击升级或打开购买面板不收起状态卡下方的今日余额和剩余额度用量卡（5h、1w、Tool 等）；购买动作只追加购买面板。
- 已开通 Coding Plan 时，详情页状态卡下方的 5h、1w、MCP 剩余额度卡需要展示接口返回的 `nextResetTime`，时间格式复用 sidebar 剩余额度：5h 展示日期时间并在当天时省略日期，1w 和 MCP 展示日期。

## 旧数据迁移

读取本地 provider store 时会清理旧 `default-*` 供应商：

- `apiKey` 为空：视为用户从未启用，直接删除。
- `apiKey` 非空：视为用户已有自定义配置，按普通 custom provider 保留，不再享受默认模板排序或自动补齐。

刷新预置供应商只更新 builtin provider 元信息；普通预置刷新不会隐式修改用户 API Key。

# Desktop Coding Plan Upgrade Availability E2E

日期：2026-07-03

## 覆盖目标

模拟 BigModel 账号已登录但没有个人 Coding Plan 权益时，用户从设置页或 sidebar 头像菜单的升级入口进入
`Upgrade Coding Plan` 购买页。个人套餐数据来自本地 E2E fixture server，
不访问真实 BigModel / ZCode 后端。

账号夹具提供可解析的个人项目和项目凭据；订阅列表为空，权益接口明确返回无套餐。
不能以空项目列表模拟无权益，否则账号状态会变成查询失败，而不是已登录、未开通。

混合 suite 可复用构建前确定的 mock origin，但每个 worker 必须显式重置场景与营销开关。
仅 `marketing-touch-*` worker 启用营销 fixture；购买用例返回空投放，不能继承前一用例的
Popup、Banner 或挂起领取。重新启用营销时使用新的 fixture 状态。

```text
worker spec -> reset(scenario, marketingTouch) -> 同一 mock origin
  购买用例：空投放                营销用例：全新投放状态
```

## Case: BigModel 个人套餐全部售罄

| 字段 | 内容 |
| --- | --- |
| Spec | `packages/desktop/test/e2e/coding-plan/upgrade/coding-plan-upgrade-personal-sold-out.test.ts` |
| 数据源 | `BigModel Coding Plan E2E mock server` |
| 状态 | verified |

### Setup

1. E2E 隔离 HOME 只写入 BigModel OAuth 凭据，表示账号已登录，不夹带其他账号族。
2. 写入 BigModel Coding Plan provider，保持未开通套餐状态。
3. 将 `ZCODE_TEST_BASE_URL` 和 `BIGMODEL_TEST_API_BASE_URL` 指向本地 mock server。
4. `client/configs` 返回 BigModel 个人 Lite / Pro / Max 静态套餐。
5. `pay/batch-preview` 返回同一批个人套餐，且每个 SKU `soldOut=true`。

### Action

1. 打开默认 workspace。
2. 打开设置的模型供应商分区，按共享 Provider ID 进入 BigModel 品牌入口。
3. 等待订阅入口可点击，确认购买 webview 尚未打开，再点击订阅入口。

品牌入口已不提供旧 API Key 连接模式，不再用已删除的模式切换制造同步等待。
订阅按钮在同步期间的加载和禁用状态由 `packages/ui/test/modelProviderCodingPlan.test.ts`
的对应单测保留；此 E2E 只验证当前订阅入口到售罄页的交互。

### Assert

- 当前订阅入口打开可见的 Coding Plan webview，并带有产品的窗口控制。
- 本地购买页 fixture 显示“已售罄”或“Sold out”。
- 真实外部购买站的 SKU 按钮禁用与周期选择不属于该本地 HTML fixture 的验证范围。

## Case: BigModel 个人套餐接口系统繁忙

| 字段 | 内容 |
| --- | --- |
| Spec | `packages/desktop/test/e2e/coding-plan/upgrade/coding-plan-upgrade-personal-system-busy.test.ts` |
| 数据源 | `BigModel Coding Plan E2E mock server` |
| 状态 | verified |

### Setup

1. E2E 隔离 HOME 写入 BigModel OAuth 凭据，表示账号已登录。
2. 写入 BigModel Coding Plan provider，保持未开通套餐状态。
3. `client/configs` 返回静态个人套餐，确保购买页有可展示卡片。
4. `pay/batch-preview` 返回业务失败并被 service 归一为 `coding_plan_system_busy`。

### Action

1. 打开默认 workspace。
2. 点击 sidebar footer 的账号头像菜单。
3. 点击 `Upgrade Coding Plan` 入口打开购买页。

### Assert

- 页面仍显示静态个人套餐卡，而不是空白或无限 loading。
- Lite / Pro / Max 个人套餐按钮使用按钮专属文案：中文“订阅繁忙”，英文“System busy”。
- 这些按钮处于 disabled 状态，不能进入周期选择页。

## 非覆盖项

- 不覆盖真实支付、二维码、Stripe / PayPal 或团队套餐下单。
- 不覆盖手机 `/remote` replayable 链路；该 case 只验证桌面本地 sidebar 升级入口与购买页 UI。
- 不验证真实线上库存或真实 BigModel 账号权益，避免固定回归受线上状态影响。

## 验证命令

升级页的本地 mock origin 写入 renderer 构建产物。新建 run 时需正常构建，不能复用
上一次 run 的 `ZCODE_E2E_SKIP_BUILD=1` 产物，否则 webview 会访问已关闭的旧端口。

- `pnpm --filter @zcode/desktop typecheck:e2e`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:e2e -- --spec ./test/e2e/coding-plan/upgrade/coding-plan-upgrade-personal-sold-out.test.ts`
- `pnpm test:e2e -- --spec ./test/e2e/coding-plan/upgrade/coding-plan-upgrade-personal-system-busy.test.ts`

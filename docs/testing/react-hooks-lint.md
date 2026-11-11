# React Hooks 依赖检查

## 目标与边界

在现有 Oxlint 中启用 `react/exhaustive-deps` 与 `react/rules-of-hooks`。
前者检查依赖遗漏、多余依赖和部分不稳定引用；后者检查 Hook 调用位置和顺序。
不安装第二套 linter，不自动修改业务代码的依赖数组。

配置沿用根 `.oxlintrc.json`。在 override 中启用 React 插件和这两条规则，保留
原有 unicorn、typescript、oxc 插件；不同时引入其他 React 默认规则。
现有 ignorePatterns、各包独立 lint 入口和 nested config 的边界保持不变。
根配置排除的组件目录与 CLI React 源码需要在专项扫描中显式纳入；嵌套配置仍按包独立生效，
不能把根 lint 的 Hooks 诊断称为全库结果。

## 接入策略

- `react/exhaustive-deps` 先设为 `warn`，存量诊断逐项复核后修复。
- `react/rules-of-hooks` 默认 `error`；2026-11-04 首次扫描发现的七个文件精确登记为
  `warn`，诊断仍可见。该例外覆盖这些文件中的同规则诊断，不是按行或按条数冻结的基线。
  后续逐文件清理并删除例外，不放宽其他规则或新增文件。
- `pnpm lint` 自动执行这些检查；CI/pre-push 沿用同一入口。
- 不使用 `lint:fix` 批量修复 Hooks。新增依赖可能重建订阅或扩大渲染范围，删除依赖
  可能移除业务上的失效条件，均须结合 owner、调用方与运行时场景判断。

## 解读诊断

诊断数量不等于 bug 数量，也不等于 Hook 数量。同一依赖数组可以产生多条诊断。
尤其是把对象整体传给 helper，或通过 `props.callback()` 调用成员函数时，检查器可能
同时报告缺少对象和成员依赖多余。应先检查 helper 的输入边界及调用接收者语义，不能
直接把所有成员替换成整个对象。

```text
闭包读取值 → 检查依赖是否覆盖 → 人工复核身份与失效语义 → 运行时验证更新范围
```

`[props]` 即使通过检查，也不能证明依赖足够窄。文件预览回调变化传播到无关侧栏的
场景仍需组件提交记录验证，静态规则不替代 React 渲染回归。

## 验收

工程回归：`node --test scripts/test/react-hooks-lint.test.mjs scripts/test/source-size-policy.test.mjs`。
该回归也纳入现有 `test:architecture` 入口。验证缺失/多余依赖可见、普通文件非法
Hook 调用阻断、精确存量文件仍告警、包内运行继承配置，以及原有插件规则不丢失。
正确的精确依赖和完整对象依赖均保持规则原有语义，不把静态检查包装成性能证明。

专项扫描使用独立的临时配置，只启用两条 Hooks 规则。Oxlint 1.60.0 的 `--no-ignore`
不会清除配置里的 `ignorePatterns`，仅在根配置上添加该参数仍会漏掉被忽略的源码。
显式列出源码目录，不对生成文件、依赖目录和语法测试 fixture 做全目录扫描：

```sh
audit_dir=$(mktemp -d)
cat > "$audit_dir/hooks.json" <<'JSON'
{
  "plugins": ["react"],
  "categories": { "correctness": "off" },
  "rules": {
    "react/exhaustive-deps": "warn",
    "react/rules-of-hooks": "warn"
  }
}
JSON
pnpm exec oxlint -c "$audit_dir/hooks.json" \
  --no-ignore --disable-nested-config --format json \
  packages/ui/src packages/desktop/src packages/web/src packages/web-share/src \
  packages/stream-animate/src packages/e2e-report/src apps/dev-docs/src \
  apps/zcode-cli/packages/tui/src apps/zcode-cli/packages/debug/src \
  apps/zcode-cli/packages/office-runtime/ui \
  apps/zcode-cli/packages/zcode-site-plugin/src/ui > "$audit_dir/result.json"
```

保留原始 JSON；按规则、类别、文件和行号汇总。缺失、多余、不稳定引用、复杂表达式、
cleanup ref 和调用顺序问题分开计数；人工复核结论单列，未验证项不得标为已修复。

## 首轮扫描记录

2026-11-04，基于 `01100ad2c9`，Oxlint 1.60.0。上面的专项扫描覆盖 2,662 个源码目录下的
文件，发现 141 个文件中的 446 条 deps 诊断，另有 18 条 Hook 调用规则诊断。根 lint 的
Hooks 检查不覆盖 CLI React 源码与基础组件目录，但包含辅助脚本与测试，得到 425 条 deps、
20 条调用规则诊断。启用前后同范围比较，原有非 Hooks 诊断没有新增或减少。

| deps 类别                    | 诊断数 |
| ---------------------------- | -----: |
| 缺少依赖                     |    174 |
| 多余依赖                     |    218 |
| 引用每次 render 都变化       |     24 |
| cleanup 读取可变 ref.current |     21 |
| 依赖数组含复杂表达式         |      9 |

优先复核的源码位置与边界：

- `ToolCallBlocks.tsx` 的 `childToolList` 读取 `onOpenWorkflowRun`、
  `disableSummaryContentAnimation`、`animateDiffCountOnMount`，但 deps 未列入这三个输入。
- `plugin-ui/adapters/usePluginUiSidePaneModel.tsx` 的 `feedScope` 读取 `tab.remoteSessionId`，
  deps 未覆盖该字段；需要验证其在同一组件生命周期内变化的场景。
- `hooks/useAppPanels.ts` 的 `handleOpenBrowserUrl` 未读取 `workspaceAbsPath`，但把它列入 deps；
  两个关闭回调还保留了已不使用的 `currentSidePaneScope`、`setIsSidePaneCollapsed`。
- `v4/WorkflowNotificationToolRow.tsx` 在 `onOpenRun` 存在时，每次 render 重建 JSX 值
  `openRunLink`，导致依赖它的 `renderContent` 回调每次更新。
- `v4/SessionPane.tsx` 的 `composerDraftGeneration` 是重读外部草稿的失效信号；虽被标为多余，
  不能直接删除。`app-shell/SidePaneTabOverview.tsx` 的 `currentTime` 同样需要保留相对时间刷新语义。
- `SidePaneTabOverview`、`useGitAutoRefresh` 中对象与成员的成对诊断先检查 helper 边界，
  不机械改成整个对象依赖。
- `resume-workflow-run.tsx` 和 `project-sidebar/grouped/task-row.tsx` 在部分 Hook 之前提前返回，
  分别有 3 条和 8 条调用规则诊断；运行时风险取决于分支在同一组件实例内是否切换。

本轮只接入检查和登记问题，未修改业务依赖，未把静态诊断认定为已经复现的产品 bug。

# 插件类型包 `@zcode-dev/plugin-api`

设计见 `docs/plugins/extension-host.md` §17.9。

- 四个入口（根、`/manifest`、`/sessions`、`/protocol-v4`）只有 `export type { … } from`，来源只有 `@zcode/shared/extension-host` 与 `@zcode/shared/zcode-protocol-v4`。不手写类型，不导出运行时的值；要新增类型先加在协议模块里。
- `package.json` 的 version 等于 `EXTENSION_API_VERSION`（工程测试 `test/version.test.ts`）。能力表变化时两处一起升版。
- 仓库内的消费方读 `src`（tsconfig `paths` + 项目引用）；仓库外读 `pnpm --filter @zcode-dev/plugin-api build` 产出的 `dist`：协议声明全部内联，只依赖 `zod`。
- 发布到 npm，由用户手动发布；版本等于 `EXTENSION_API_VERSION`，发出的版本冻结（docs/plugins/plugin-publishing.md §3.3、§5）。

# Share 独立构建与 CUA 依赖边界

## 状态

- 状态：已实现
- 范围：Share 静态落地页的构建依赖
- 不改变：Share API、OAuth 协议、Desktop 导入、手机 `/remote`、完整 Web 入口

## 当前问题

历史版本的 `build:web-share` 曾通过 `packages/web/src/main.tsx` 构建完整 Web 应用。
当前已切换为独立的 `@zcode/web-share` 入口；Share 仅复用 `@zcode/share-ui`、协议类型、
认证/Share API 客户端和只读 presentation，不再进入完整 Web 的 CUA 依赖闭包。

```text
历史：@zcode/web -> @zcode/client / @zcode/ui -> @zcode/services -> @zcode/zcode-cua
当前：@zcode/web-share -> @zcode/share-ui / @zcode/shared
      @zcode/web       -> @zcode/client / @zcode/ui -> @zcode/services -> @zcode/zcode-cua
```

## 目标边界

- `@zcode/web-share` 只包含 Share 路由、Preview API、OAuth callback 和只读时间线。
- Share 构建不声明、解析或下载 `@zcode/services` 与 `@zcode/zcode-cua`。
- `@zcode/share-ui` 提供 Share 所需的只读 presentation 入口；Desktop/Remote 继续使用完整
  `@zcode/ui`。
- Share 与完整 Web 共用协议类型和已确认的只读展示实现，不共用运行态 service。
- 只读时间线复用的 `message.tsx` 静态引用了文件链接菜单，会把 `@zcode/rpc` 带进闭包。Share 用 vite
  别名直接指向 `packages/rpc/src`（Dockerfile 只复制该源码；rpc 没有三方依赖）。没有 services 时
  不渲染该菜单，所以运行时不创建 RPC 通道。
- `packages/shared/src/app-control` 值导入 `@zcode/session-control/contracts`。Share 用 vite 别名指向
  `packages/session-control/src/contract.ts`，Dockerfile 复制该包的 `src` 与 `package.json`（其 `imports`
  字段解析 `#session-control/*` 子路径）；唯一三方依赖 zod 已由 shared 安装。
- 新增的 `@zcode/*` 值导入进入 Share 闭包时，必须同时登记 vite 别名和 Dockerfile `COPY`，并用
  `docker build -f Dockerfile.web-share .` 验证；本地完整工作区构建会掩盖缺失。无法拉取基础镜像时，可按
  Dockerfile 的 COPY 清单在空目录重建文件布局后执行同样的 install 与 build，效果等同。
- Remote v4 构建从 workspace 内的 `packages/zcode-cua` 构建 CUA，不涉及私有 Git 与凭据。

## 构建链路

```text
Dockerfile.web-share
  -> pnpm install --frozen-lockfile --filter @zcode/web-share...
  -> pnpm --filter @zcode/web-share build
  -> nginx static image
```

Dockerfile 分三段：`sources`（`FROM scratch`，汇总全部源码 COPY）→ `builder`（只按 package.json 安装依赖，
再 `COPY --from=sources /app ./` 一次合并源码后构建）→ `runtime`（nginx）。源码 COPY 必须留在 `sources` 阶段：
Jenkins Pod 内 BuildKit 会退回 native snapshotter，安装后的每一层都要整盘复制 node_modules（实测每层约 80 秒），
13 个分散 COPY 累计约 17 分钟，曾超过 20 分钟上线超时。新增 Share 源码输入时加在 `sources` 阶段，不要加在安装之后。

`.npmrc` 为 `node-linker=hoisted`，`--filter` 不裁剪 lockfile 平铺；CUA 并入 monorepo 后 lockfile
中已无 Git 来源，Share 镜像无需 git、BuildKit secret 或 Jenkins 凭据，也不需要 `packages/zcode-cua`。

## 验收

- Share 镜像构建命令不包含 CUA secret。
- Share 构建不访问任何 Git 仓库。
- `/cn/share`、`/share`、callback、mock fixture 和资源路径保持可用。
- 完整 Web 和 Remote v4 的构建依赖边界不变。
- Share 页面不创建 Host、Agent、service 或 remote session。

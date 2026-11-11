# Desktop CI/CD

`z-code` 的桌面端 CI/CD 入口是根目录的 `.gitlab-ci.yml`，具体 job 按职责拆分在 `.gitlab/ci/*.yml` 中。正式发布在普通 tag 管道上为 `approve -> validate -> upload -> preload -> publish -> release-notify`。发布日志由 infra API 直接编辑 runner 共享目录中的 `latest.yml`；z-code CI 在人工确认后、上传前统一校验六个平台和 remote assets，只上传版本化静态产物，不读取仓库 changelog、不生成独立 locale 清单，也不覆盖 CDN 上的旧 generic stable feed。

## 配置文件结构

- `.gitlab-ci.yml`：只保留本地 include 入口，按顺序加载 CI 分片。
- `.gitlab/ci/00-workflow.yml`：`workflow.rules`、`stages` 和发布变量；共享工作区变量位于 `.gitlab/ci/05-workspace-variables.yml`。Node 依赖缓存不再使用 GitLab cache 模板，统一依赖 `GIT_CLEAN_FLAGS` 排除项的工作区持久化（策略与防回归守卫见 `docs/ci-cache-strategy.md`）。
- `.gitlab/ci/10-scripts.yml`：跨 job 复用的 setup、guard、store maintenance 脚本片段。由于 GitLab include 文件之间不能共享 YAML anchor，这里使用 `!reference` 复用脚本，避免拆分后改变执行内容。
- `.gitlab/ci/20-test.yml`：conversation-session 手动 E2E job（共享 macOS、四 shard Windows、单实例专用 macOS Runner），以及 Windows lint/typecheck/unit test job。
- `.gitlab/ci/30-build.yml`：平台无关 desktop app 构建 job、macOS/Windows/Linux 打包 job和 remote assets 构建 job。macOS 打包 job 会在产物收集后直接完成 DMG 公证。
- `.gitlab/ci/40-notarize-notify.yml`：构建产物通知。
- `.gitlab/ci/50-release.yml`：人工 approve、发布元数据生成、OSS 上传、CDN 预热、正式发布和发布成功通知。
- `.gitlab/ci/preview-child.yml`：MR 中 `build:preview` 手动命令触发的内部测试包子流水线；只复用 workflow、scripts、build 和 notify，不加载 test/release。

Desktop CI 不承载远控静态资源部署；测试与生产手机页面均通过独立 OSS 多版本流水线发布，见 [Remote v4 静态部署](./web-remote-control/remote-v4-static-deployment.md)。

## 流水线阶段

- `test`：保留 E2E 与质量任务配置；App 单测 job 已退役，工程测试使用 `pnpm test:engineering`，push 自动执行受影响工程测试（当前质量 job 的启用状态以 CI rules 为准）
- `build-app`：`build:desktop:app` 构建平台无关的 `packages/desktop/out/`，并通过 DAG `needs` 只等待 MR 人工确认；conversation E2E 在 `approve-mr` 阶段提供共享 macOS、Windows 与专用 macOS Runner 三个手动 optional 入口，失败不会阻塞后续 build job 调度。
- `build`：macOS / Windows / Linux runner 负责各自平台 runtime assets、签名与安装包生成；正式打包只执行资产准备、静态校验和产物构建，不运行 `test:native-search:e2e`、`test:sea-runtime-tools:e2e` 等行为 E2E，这些命令保留为独立验证入口；`build:cua-helper:arm64` 与 `build:cua-helper:x64` 在所有被 workflow 接纳的流水线中自动运行，同架构 macOS job 等待并消费本次流水线的 Helper artifact；macOS job 在收集产物后直接执行 DMG 公证；Windows 和 Linux 都按 x64 / arm64 两个并行 job 构建，Linux 同时产出 AppImage、deb、rpm 三种安装包；另有独立 `build:remote:assets` 只负责 Source Server descriptor 与四个平台 archive。
- `notify`：构建成功时向飞书发送各平台产物通知；macOS 通知依赖对应的 `build:macos:*`，因此只在对应架构的打包与公证都成功后出现。每个平台另有失败通知 Job，在构建失败时发送同样的摘要并附 GitLab Job 地址，不展示下载地址。
- `approve`：全部构建完成且 infra 编辑完六个平台日志后出现的人工门禁；人工确认后自动进入完整性检查
- `validate`：approve 放行后自动校验六个平台 `latest.yml` 的版本、日志、引用文件与 size/sha512，以及版本根 `source-server-release.json` 的版本、四个 target、文件名、size/sha256、相对 URL 与真实 `zcode-server-*.tar.gz`；发现基线时代残留的 `manifest-*.json` / `components/` 或未被 descriptor 引用的 archive 直接失败；upload 只能在本阶段成功后执行
- `upload`：上传当前纳入正式发布的 macOS / Windows / Linux 版本化构建产物，以及 Source Server descriptor/archive 到 OSS；Electron 产物写入 `<version>/<platform>-<arch>/`，例如 `v3.3.3/macos-arm64/`，本阶段解析更新元数据生成 `release-meta-*.json`，但不覆盖 stable feed。
- `preload`：`release:preload:cdn` 在 upload 成功后自动预热版本化平台/架构产物和 Source Server descriptor/archive；该阶段必须成功后才允许进入 publish，避免服务端 manifest 发布后客户端拉到尚未预热的安装包或 blockmap。
- `publish`：`release:publish:gray` 在预热成功后自动执行。job 先直接调用后端灰度控制接口 `https://zcode-api.z.ai/api-admin/v1/releases/gray`（可由 `ROLLOUT_API_URL` 或 `ZCODE_RELEASE_GRAY_API_URL` 覆盖）并携带 `Authorization: Bearer $ROLLOUT_ADMIN_TOKEN`，将灰度开关重置为关闭且比例归零；重置成功后才调用后端 release API 写入 `status=3`，避免新版本继承上一轮灰度策略。`release:publish:stable` 位于同一 stage，通过 `needs` 等待 gray，人工触发后复用同一批 `release-meta-*.json` 写入 `status=1`；`ci*` 分支默认只允许自动验证到 gray，脚本会阻止它默认写正式 stable 状态。
- `release-notify`：手动读取共享目录 `macos-arm64/latest.yml` 中由 infra 编辑的 `releaseNotes`，发送飞书发版成功通知

Linux 桌面构建与 `notify:feishu:linux:*` 已启用；正式 tag 的 macOS、Windows、Linux x64/arm64 都进入主 upload、preload、publish 链路。sandbox/test-tag 验证链路仍维持现有 macOS arm64 上传范围。远程 runtime 由 `build:remote:assets` 统一产出 descriptor/archive。

## Release Job 命名

| job                                  | 触发                       | 职责                                                                                                                                |
| ------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `release:approve`                    | 全部构建完成后手动         | 确认 infra 已完成六个平台日志编辑并放行完整性检查                                                                                   |
| `release:validate`                   | approve 后自动             | 校验共享目录中六个平台安装包、更新清单、日志和 Source Server descriptor/archive，失败时不开放 upload                                |
| `release:upload:<platform>:<arch>`   | 自动                       | 上传版本化安装包、Source Server descriptor/archive，生成 `release-meta-*.json` 和版本化 CDN 预热清单                                |
| `release:upload:sandbox:macos:arm64` | sandbox 手动流水线自动运行 | 验证 sandbox 上传链路，不触达正式发布路径                                                                                           |
| `release:preload:cdn`                | approve 后自动             | 预热版本化平台/架构安装包、更新清单、blockmap 和 Source Server CDN URL                                                              |
| `release:preload:cdn:sandbox`        | 手动                       | 预热 sandbox 版本化产物 CDN URL                                                                                                     |
| `release:publish:gray`               | approve 后自动             | 等 `release:preload:cdn` 成功后，先关闭灰度开关并把比例重置为 `0`，再调后端 release API 发布灰度状态 `status=3`                     |
| `release:publish:stable`             | 灰度确认后手动             | 复用 upload 元数据调后端 release API 发布全量状态 `status=1`，不上传 stable feed；`ci*` 分支默认被脚本拦截，避免验证包写正式 stable |
| `release:notify:feishu`              | 手动                       | 发送正式发版飞书通知                                                                                                                |

## MR 手动 Job 命名

| job                                          | 触发           | 职责                                                                                                                                                   |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approve:merge-request`                      | 手动、blocking | 放行当前 MR 的 production 验收包 DAG                                                                                                                   |
| `build:preview`                              | 手动、optional | 启动同一 MR commit 的 Preview child pipeline；不继承 parent 默认变量，只显式传递 Preview 控制变量，固定 `ZCODE_ENV=test`，不阻塞 production 验收包 DAG |
| `test:e2e:conversation-session:auto`         | 手动、optional | 在共享 `macos + e2e` Runner 上单 job 执行正式 conversation/plugin/workspace-file-tree replay 集合                                                      |
| `test:e2e:conversation-session:auto:windows` | 手动、optional | 生成十个按历史耗时加权的 shard（每个约 40 个 spec），调度到 `windows-e2e + e2e` Runner 池                                                              |
| `test:e2e:conversation-session:auto:mac`     | 手动、optional | 只生成一个 job，并调度到专用标签的 darwin/arm64 Runner                                                                                                 |

## 发布链路修改前后对比

| 环节                  | 修改前                                                                                      | 修改后                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| update metadata       | 构建与日志注入发生在同一阶段，修改日志可能要求重新打包                                      | 构建只产出基础 `latest.yml`，infra 在共享目录编辑日志，approve 后由 validate 校验，不生成独立 locale 文件              |
| `upload`              | 上传版本化产物时会一并覆盖 stable feed，客户端可能在后端 release API 前看到新 `latest*.yml` | 只上传版本化产物和 Source Server descriptor/archive，只产出 `release-meta-*.json` 与版本化预热 URL，不覆盖 stable feed |
| `release:preload:cdn` | upload 后预热版本化产物，后续发布 job 需要等待它完成                                        | 独立 `preload` stage；approve 放行并 upload 成功后自动预热版本化平台/架构产物，必须成功后才允许 publish                |
| `release:publish:*`   | 非手动或可能跟随前置阶段自动进入；stable feed 覆盖职责不明确                                | 灰度和全量阶段都只调用后端 release API，stable / preview 可见性由服务端 manifest 控制，不再上传 stable feed            |
| `release-notify`      | publish 成功后可能自动通知                                                                  | 全量 publish 成功后提供手动通知 job                                                                                    |
| macOS 公证与产物通知  | `notarize:macos:*` 独立 stage/job 负责公证，并在 after_script 里发送 macOS 产物通知         | `build:macos:*` 在构建阶段完成签名、收集与公证；`notify:feishu:macos:*` 在 notify 阶段单独发送 macOS 产物通知          |

## 触发规则

- tag（不含 `test`）：正式发布，产物目录为 `release/$CI_COMMIT_TAG/`
- tag（含 `test`，大小写不敏感）：自动切换 `SANDBOX_RELEASE=1`，上传路径改为 `OSS_PATH_PREFIX_SANDBOX/$CI_COMMIT_REF_SLUG`，用于验证 CI/CD 流水线，不污染正式更新 feed
- `ci*` 分支 push：非 tag 的真实 release 链路验证入口，产物目录为 `@electron/ci/$CI_COMMIT_REF_SLUG/`，上传路径为 `OSS_PATH_PREFIX_SANDBOX/$CI_COMMIT_REF_SLUG`；`release:approve` 放行后自动执行 validate、upload、preload 和 gray publish，stable promote / release-notify 为手动。默认不允许 `ci*` 把验证包发布为正式 `status=1`；只有发布负责人明确批准演练时才可临时设置 `ALLOW_CI_RELEASE_STABLE_PUBLISH=1`。
- Merge Request 到 `main` / `staging`：默认 production 打包验证，产物目录为 `@electron/dev/$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME/`
- Merge Request 到 `main` / `staging`：`approve-mr` 阶段额外展示 `build:preview`；不点击时不阻塞现有 MR 流水线，点击后以相同 MR ref/SHA 启动子流水线，Preview 产物目录为 `@electron-preview/$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME/`
- MR、GitLab Run pipeline、Pipeline Trigger API 或普通 API pipeline 显式传入 `ZCODE_ENV=test` 时，同样在 workflow 创建 job graph 时切换到 `@electron-preview/<branch>/`；未传或使用 `production` 时继续写入 `@electron/dev/<branch>/`。tag 与 `ci/*` 发布验证路径保持不变。
- 源分支为 `staging` 或 `chore/ci` 的 MR：允许跑 CI
- GitLab Web UI / Pipeline Trigger API / 普通 API 手动触发：production 产物目录为 `@electron/dev/$CI_COMMIT_REF_NAME/`，显式传入 `ZCODE_ENV=test` 时使用 Preview 路径。Trigger API 可以传 `ZCODE_BUILD_PLATFORMS=macos-arm64,windows-x64` 只自动打指定平台；未选平台保留非阻塞手动 job。
- CUA Helper 双架构 job 跟随对应 macOS 平台选择规则；未传 `ZCODE_BUILD_PLATFORMS` 时双架构自动运行，传入列表后未选架构保留非阻塞手动入口。
- MR 与 GitLab Web UI 手动触发的 pipeline 会展示 `test:e2e:conversation-session:auto`、`test:e2e:conversation-session:auto:windows` 和 `test:e2e:conversation-session:auto:mac` 三个手动 optional E2E 入口；未点击或执行失败都不阻塞 `build:*`。tag 和 `ci*` release 验证链路不创建这些 job。

专用 macOS Runner 的分片与调度关系：

```text
manual test:e2e:conversation-session:auto:mac
  `-- one GitLab job --> tags: <专用 macOS runner 标签> --> one dedicated shell runner instance
```

Preview 手动链路：

```text
MR parent pipeline
  `-- build:preview [manual, optional]
        +-- inherit parent default variables: false
        +-- forward: ZCODE_PREVIEW_PIPELINE / ZCODE_ENV / TARGET_OUTPUT_DIR
        `-- child pipeline [same MR ref/SHA, ZCODE_ENV=test]
              +-- resolve temp/cache paths from child runner CI_PROJECT_DIR
              +-- desktop app + macOS/Windows/Linux + Computer Use Helper + remote assets
              +-- artifact notifications
              `-- no tests / Web remote deployment / upload / publish / release
```

## Computer Use Helper 测试包固定流程

Helper 发布脚本 `scripts/package-cua-helper-release.mjs` 提交 Apple 公证时必须传入
`--no-s3-acceleration`，与主安装包保持一致，使用普通 S3 上传端点。加速端点可能在
Apple 公证 API 已创建提交记录后发生 TCP/TLS 握手超时；因此 API 查询成功不能代替上传验收。
验收必须完成实际 ZIP 上传、取得 `Accepted`，并通过 staple 和 Gatekeeper 校验。

CUA / broker / permission 相关测试包必须走 `ci*` 分支或含 `test` 的 tag，产物放在
`/zcode/@electron/ci/<test-build-name>/` 或 sandbox 路径，不能放到
`/zcode/@electron/release/`。`release/` 只给正式版本目录使用。

推荐优先使用 `ci*` 分支验证 producer 链路，因为它不需要创建 tag，也能跑真实签名、
公证、staple 和共享目录同步：

```bash
VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
CI_BRANCH="ci/cua-helper-${VERSION}-${STAMP}"

git push origin HEAD:refs/heads/${CI_BRANCH}
glab ci list --ref "${CI_BRANCH}" --sha "$(git rev-parse HEAD)"
```

等待同一条 pipeline 中这些 job 成功：

- `build:desktop:app`
- `build:macos:arm64`
- `build:macos:x64`
- `build:cua-helper:arm64`
- `build:cua-helper:x64`

两个 `build:cua-helper:*` job 都随 build DAG 自动调度，不需要在 GitLab UI 中逐个点击运行。Helper 构建失败会按普通 build job 语义使流水线失败，避免 macOS 验收包在未产出同流水线 Helper 的情况下继续成为可交付结果。

`build:macos:<arch>` 通过 `needs`（`optional`）依赖同架构的 `build:cua-helper:<arch>` artifact。strict
release 的产物验收（`scripts/notarize-macos.sh` → `doctor-macos-release-app.sh`，`ZCODE_CUA_REQUIRE_HELPER=1`）
会定位最终 `ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app` 并设
`ZCODE_CUA_HELPER_APP_PATH`，因此校验的是实际随 DMG 交付的内嵌副本，而不是中间 artifact 或 runner 上
`${ZCODE_HOME:-$HOME/.zcode}` 的残留状态。包内 Helper 缺失会 fail-closed。

成功后固定下载入口如下，其中 `<slug>` 是 GitLab 的 `$CI_COMMIT_REF_SLUG`：

```text
http://intranet.example.invalid:12345/zcode/@electron/ci/<slug>/macos-arm64/ZCode-<version>-mac-arm64.dmg
http://intranet.example.invalid:12345/zcode/@electron/ci/<slug>/macos-arm64/ZCode-<version>-mac-arm64.zip
http://intranet.example.invalid:12345/zcode/@electron/ci/<slug>/macos-x64/ZCode-<version>-mac-x64.dmg
http://intranet.example.invalid:12345/zcode/@electron/ci/<slug>/macos-x64/ZCode-<version>-mac-x64.zip

http://intranet.example.invalid:12345/zcode/@electron/ci/<slug>/pipeline-<pipeline-id>/cua-helper-macos-arm64/ZCode-CUA-Helper-<version>-mac-arm64.zip
http://intranet.example.invalid:12345/zcode/@electron/ci/<slug>/pipeline-<pipeline-id>/cua-helper-macos-x64/ZCode-CUA-Helper-<version>-mac-x64.zip

（`pipeline-<pipeline-id>` 是候选 Helper 的隔离目录；Helper plist 的
`ZCODECUAHelperBuildId` 形如 `pipeline-<pipeline-id>-<short-sha>`，按 build id
中的 pipeline id 定位下载目录。）
```

The Helper jobs also sync the resolver-friendly default dependency URL:

```text
http://intranet.example.invalid:12345/zcode/deps/zcode-cua-helper-<version>/ZCode-CUA-Helper-<version>-mac-arm64.zip
http://intranet.example.invalid:12345/zcode/deps/zcode-cua-helper-<version>/ZCode-CUA-Helper-<version>-mac-x64.zip
```

Record SHA-256 for every package that will be handed to testers:

```bash
shasum -a 256 ZCode-<version>-mac-arm64.zip \
  ZCode-CUA-Helper-<version>-mac-arm64.zip
```

Minimum producer evidence before sending the package:

```bash
glab api 'projects/:fullpath/pipelines/<pipeline-id>/jobs?per_page=100' \
  | jq -r '.[] | select(.name=="build:macos:arm64" or .name=="build:macos:x64" or .name=="build:cua-helper:arm64" or .name=="build:cua-helper:x64") | [.id,.name,.status,.web_url] | @tsv'

glab api 'projects/:fullpath/jobs/<helper-job-id>/trace' \
  | rg 'provenance ok|notary result: status=Accepted|staple and validate action worked|Job succeeded'
```

For release-quality CUA validation, do not stop at package production. Install the
standalone Helper under `${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app`,
launch the matching ZCode.app, and run the zcode-cua consumer gates. Product broker
sockets are minted as random `broker-<hex>.sock` files; do not hard-code
`broker.sock` in new validation scripts.

## Runner 约束

- `build:desktop:app` 需要带 `macos` tag 的 shell runner，产出 `packages/desktop/out/` artifacts 供平台打包 job 复用
- `test:e2e:conversation-session:auto` 需要带 `macos` tag 的 shell runner，使用普通 fixture replay，不访问真实模型上游，也不启动 Docker，job 超时上限为 `timeout: 4h`（`:mac` 继承）；默认只跑已稳定的 conversation replay 子集，长时序 stop/compact held queue case 需要单独 replay 稳定后再进入自动门禁。
- `test:e2e:conversation-session:auto:windows` 需要同时带 `windows-e2e` 与 `e2e` tag 的 PowerShell runner pool，并通过 `parallel: 10` 将同一正式 replay 集合按历史 spec 耗时（`scripts/ci/select-e2e-weighted-shard.mjs`）切成十个 LPT 子集，每个约 40 个 spec；每个 shard job 的超时上限为 `timeout: 4h`。分桶前按与默认全量相同的环境准入（`packages/desktop/scripts/e2e-formal-spec-selection.mjs`）过滤：远端队列 spec 需要 `ZCODE_E2E_SSH_CONTAINER` 等远端 harness，未入队的 ssh-remote spec 需要 SSH 凭据；缺少时不进入任何分桶。分桶结果以显式文件交给 WDIO，WDIO 会把它当成定向运行而不再做这层门禁，所以准入必须在分桶脚本里完成。
- `test:e2e:conversation-session:auto:mac` 只匹配专用 macOS runner 的 tag（标签名见 `.gitlab/ci/20-test.yml`），复用 macOS Bash replay 合同并生成一个 job；它不会落到共享 `macos` runner，也不会参与构建/发布 job。
- `build:macos:*` 需要带 `macos` tag 的 Apple Silicon shell runner，并预装 Node.js、corepack、pnpm、Xcode Command Line Tools、系统 `make` / `curl` / `tar` 与 Rosetta 2；arm64/x64 job 通常下载对应 native-search 预编译 sidecar，受信任流水线在共享 deps 缺少自产归档时才复用同一 runner 现场构建并发布 `bfs` / `ugrep`。自产 sidecar 固定 `MACOSX_DEPLOYMENT_TARGET=12.0`，Microsoft rg 可以使用更低 deployment target，但任何 sidecar 都不得高于 12.0；通过 Mach-O 依赖校验后再分别签名、打包并完成 DMG 公证
- `build:remote:assets` 同样运行在 `macos` runner；其产物写入共享目录供 `release:upload:macos:arm64` 复用
- `build:linux:x64` / `build:linux:arm64` 分别要求同时带有 `linux` + `linux-x64`、`linux` +
  `linux-arm64` tag 的 native runner（常见为 Docker）；镜像里需要能跑 Electron 打包依赖与
  native-search verifier。共享 deps 已有归档时只下载预编译产物，不要求 Cargo；缺少自产归档且
  允许补产时，还必须实际运行 Node 24、glibc 2.28、GCC 12 与 G++ 12，并提供 binutils、`make`、`curl` 和 `tar`。Linux 两个
  架构的 `rg` 都是 Microsoft musl 静态产物，其余 sidecar 由对应架构 producer 构建，不额外固定
  镜像名称，但最终 ELF 的最高 GLIBC symbol version 不得超过 2.28。`x64` 在这里指 `x86_64` / `amd64`。rpm target 由 fpm 调用
  系统 `rpmbuild` 产出（fpm 预编译二进制不自带），rpm 默认 xz 压缩还依赖系统 `xz`；job 兜底
  安装同时覆盖两者（`rpm` + `xz-utils`），镜像建议预装以避免每次打包现场补装。
- `build:windows:x64` / `build:windows:arm64` 需要带 `windows` tag 的 runner，并预装 Node.js、Python 3.10+、Visual Studio Build Tools 2022（含 `VC.Tools.x86.x64`）；当前由 x64 Windows runner 交叉生成 arm64 Electron/NSIS 安装包。arm64 job 会按目标架构重新编译 CUA 原生 addon，因此**始终**要求 VS 2022 的 `VC.Tools.ARM64` 组件（不再只在 `ugrep` 补产分支下要求）。共享 deps 缺少对应 `ugrep` 归档且允许补产时，runner 还必须提供 CMake、`curl` 和 `tar`；已有归档的普通打包路径不因这条冷启动分支额外要求这些 native-search producer 命令。
- Windows 打包前会执行 `scripts/ci-ensure-node-gyp-python.ps1` 与 `scripts/ci-import-vcvars64.ps1`，确保 `node-gyp` / `electron-rebuild` 的编译环境完整
三个平台的正式打包 job 都不得调用 runtime 行为 E2E。native-search 的 Bash toolcall E2E 和 SEA 单文件 runtime-tools E2E 继续保留为独立测试命令；其中 SEA 只验证 CLI 单文件交付，不是 desktop Electron 打包的前置条件。

三个平台的打包 job 都会在 `prepare:desktop-runtime` 前执行 `ci:ensure-native-search-deps`，并作为授权的共享 deps 写入入口显式设置 `ZCODE_NATIVE_SEARCH_ALLOW_PUBLISH=1`。该步骤直接检查共享根的 `deps/native-search-tools`：Microsoft `rg` 缺失时立即失败；自产 `bfs` / `ugrep` 缺失时，在当前平台 runner 构建并发布。相同 `platform-arch` 的 job 通过 `resource_group` 跨 pipeline 串行。所有 producer 归档都必须配置 SHA-256，并在发布、HTTP prepare 和解包前通过校验；摘要缺失或不匹配时立即失败。发布后仍由正式 HTTP prepare 路径重新下载、解包和验证，不能直接消费 job 临时目录。脚本本身仍保持默认拒绝写入，因此本地或其他 CI 入口不会因为归档缺失而自动发布。

### 共享产物根路径（macOS / Linux / upload）

- **macOS shell / `build:remote:assets` / upload 读盘**：
  默认 **`ZCODE_CI_SHARED_ROOT=/Users/dev/shared/zcode`**，完整路径为
  **`${ZCODE_CI_SHARED_ROOT}/${TARGET_OUTPUT_DIR}`**
  例如：`/Users/dev/shared/zcode/@electron/dev/my-branch/`。macOS 安装包只写入 **`macos-arm64/`**、**`macos-x64/`**；根目录只保留 Source Server descriptor/archive，由 macOS arm64 upload job 通过额外来源目录附带上传。
- **Linux Docker**
  与常见 runner 配置 **`volumes = ["/Users/dev/shared/zcode:/output", ...]`** 对齐：容器内写入
  **`${ZCODE_CI_LINUX_CONTAINER_OUT}/${TARGET_OUTPUT_DIR}`**（默认 **`ZCODE_CI_LINUX_CONTAINER_OUT=/output`**），宿主机上即 **`/Users/dev/shared/zcode/${TARGET_OUTPUT_DIR}`**。
  若挂载点不是 `/output`，可在 GitLab CI/CD 变量中覆盖 **`ZCODE_CI_LINUX_CONTAINER_OUT`**，或仅用 **`LINUX_SHARED_OUTPUT_ROOT`** 覆盖收集根目录。x64/arm64 并行构建会先写入当前 job 工作区的 `.tmp/linux-<arch>-collect` 临时目录，再同步到 **`linux-x64/`**、**`linux-arm64/`** 架构隔离子目录，正式 upload 只读取对应子目录，避免两个架构统一命名后的 `latest.yml` 互相覆盖导致发布元数据或更新 feed 串架构。
- **Windows**
  默认 **`ZCODE_CI_WINDOWS_SHARED_ROOT=//172.16.0.10/shared/zcode`**，拼接规则同 mac。x64/arm64 并行构建会先写入当前 job 工作区的 `.tmp/windows-<arch>-collect` 临时目录，再同步到 **`windows-x64/`**、**`windows-arm64/`** 架构隔离子目录，正式 upload 只读取对应子目录，避免两个架构的 `latest.yml` 互相覆盖导致发布元数据或更新 feed 串架构。
- 以上变量均可在 GitLab **CI/CD 变量**中按环境覆盖。

## Linux 安装包格式与 glibc 基线

Linux 打包产出 `AppImage`、`deb`、`rpm` 三种安装包，x64 / arm64 双架构。`deb` 与 `rpm` 的 packageName 均按 flavor 拆分（`zcode` / `zcode-preview`），避免系统包管理器把另一 flavor 的安装当成升级替换。`latest.yml` 与 electron-updater 在 Linux 上固定以 AppImage 作为更新产物，`deb` / `rpm` 只做首次安装分发，不参与自更新；`upload-oss.sh` 解析更新元数据时也强制校验更新产物必须是 AppImage。

rpm 面向 RHEL 8+（glibc 2.28）基线。整包 glibc 下限按 ELF `GLIBC_*` symbol version 实测：随包 node-pty prebuild 与 `bfs` / `ugrep` 为 2.28，Electron 41 主二进制为 2.25，`rg` 为 musl 静态无 glibc 依赖，整体 floor = 2.28；Ubuntu 20.04+、Debian 10+、RHEL 8+/9 均满足，CentOS 7、Ubuntu 18.04、Amazon Linux 2 不在支持范围。rpm 产物文件名复用统一 `artifactName` 模板，electron-builder 对 rpm/deb 使用包管理器架构名（`x86_64` / `amd64` / `aarch64`）落盘，Preview flavor 带 `_TEST` 后缀；`ci-collect-artifacts` 收集阶段统一归一化为 `-linux-x64` / `-linux-arm64` 命名（扩展名无关，`.rpm` 同样生效），`upload-oss.sh` 按归一化名收集，其扩展名 pattern 均已包含 `.rpm`。

rpm Requires 在 electron-builder 默认集（gtk3、nss、libnotify、libXScrnSaver、libXtst、xdg-utils、at-spi2-core、libuuid）之外，通过 `rpm.fpm` 追加 `mesa-libgbm` 与 `alsa-lib`：这两个库是 Electron ELF 的 DT_NEEDED 实际依赖但不在默认集内，最小化 RHEL 上装完会因 `libgbm.so.1` 缺失无法启动（rockylinux:8 容器实测）；必须用 fpm `-d` 追加而不是 `depends`，后者会整组替换默认 Requires。rockylinux:8 冒烟链路已完成：rpm 元数据（flavor 包名 / `x86_64` arch 映射）、dnf 依赖解析安装、无显示环境 `ELECTRON_RUN_AS_NODE` 运行、随包 `bfs` / `ugrep` / `rg` 执行、安装树全量 ELF glibc 扫描（max = 2.28）全部通过。

## 关键 CI 变量

- `TARGET_OUTPUT_DIR`：当前流水线写入共享目录的相对路径，由 `workflow.rules` 统一计算
  - MR/Preview child 的 `ZCODE_ENV=test`：`@electron-preview/$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME/`
  - web/API/trigger 的 `ZCODE_ENV=test`：`@electron-preview/$CI_COMMIT_REF_NAME/`
  - MR/web/API/trigger 的 production：`@electron/dev/<branch>/`
- `ZCODE_CI_TMPDIR` / `NPM_CONFIG_CACHE` / `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE`：引用 runner checkout 的 job-local 路径。Preview trigger 不转发 parent 中这些默认变量，避免 trigger 阶段缺少 job-only `CI_PROJECT_DIR` 时把路径固化为 `/.tmp`、`/.npm-cache` 等根目录；child job 使用自己 pipeline 的默认定义重新解析。
- `ZCODE_CI_SHARED_ROOT`：macOS / upload 使用的宿主机共享根（默认 `/Users/dev/shared/zcode`）
- `ZCODE_CI_TEST_REMOTE_ASSET_ROOT`：`ZCODE_ENV=test` 时 Source Server 资源的固定共享根
  （默认 `/Users/dev/shared/ssh-remote-assets`），CI 会把 descriptor 与四个 archive
  同步到 `${ZCODE_CI_TEST_REMOTE_ASSET_ROOT}/${VERSION}`，对应访问地址为
  `http://intranet.example.invalid:12345/ssh-remote-assets/${VERSION}`
- `ZCODE_CI_LINUX_CONTAINER_OUT`：Linux Docker 容器内共享挂载点（默认 `/output`）
- `ZCODE_CI_WINDOWS_SHARED_ROOT`：Windows SMB 根路径（默认 `//172.16.0.10/shared/zcode`）
- `ZCODE_NATIVE_SEARCH_DEPS_ROOT`：`ci:ensure-native-search-deps` 使用的共享 deps 根。平台 job 分别从上述 macOS、Linux container 与 Windows 根自动推导，通常不需要单独配置
- `ZCODE_NATIVE_SEARCH_ALLOW_PUBLISH`：显式补产开关。三个平台打包 template 已设为 `1`；其他调用方只应在确认具有共享 deps 写入职责时设置。protected ref 即使未设置也可补齐缺失的自产归档
- `LINUX_SHARED_OUTPUT_ROOT`（可选，仅 Linux Docker）：覆盖容器内产物收集根目录
- `OSS_BUCKET` / `OSS_PATH_PREFIX` / `CDN_DOMAIN`：OSS 上传与主 CDN URL 生成所需变量（仓库 `.gitlab-ci.yml` 默认：`cgx-public`、`zcode/electron/releases`、`cdn-zcode.z.ai`；可在 GitLab CI/CD 设置中覆盖）。CI URL 校验、upload 和 preload 脚本的域名兜底也统一为 `cdn-zcode.z.ai`。`CDN_DOMAIN` 和 `OSS_BUCKET` 支持逗号列表并按顺序对应；`OSS_PATH_PREFIX` 支持单值复用，也可配置同样数量的逗号列表。upload/publish 阶段会展开全部目标；桌面包不再把这些变量写入可配置的旧 generic feed。
- `OSS_CONFIG_FILE`：可选，控制每组 OSS 目标调用 `ossutil` 时使用的配置文件。支持单值复用，或配置为与 `CDN_DOMAIN` 等长的逗号列表；为空时使用 runner 默认 ossutil 配置。新旧 OSS AK/SK 或 region 不一致时，应把 AK/SK 和 region 写入对应配置文件，并按 `CDN_DOMAIN` 顺序配置文件路径。
- `CDN_PRELOAD_PROFILE` / `ALIYUN_CDN_PROFILE`：可选，控制 `cdn-preload.sh` 调用阿里云 CDN OpenAPI 时使用的 aliyun CLI profile。`CDN_PRELOAD_PROFILE` 优先级更高；支持单值复用，或配置为与 `CDN_DOMAIN` 等长的逗号列表。预热脚本不显式传 `--region`，region 由对应 profile 或 aliyun CLI 默认配置决定，避免覆盖多账号迁移时每个 profile 自带的 endpoint 配置。
- `CDN_PRELOAD_DOMAINS`：历史兼容变量；当前 upload/preload 链路不再读取，新 OSS/CDN 迁移通过 `CDN_DOMAIN` 列表展开预热域名。
- `ZCODE_UPDATE_FEED_URL`：仅限未打包开发态的可选诊断变量，用完整服务端 manifest 接口 URL 覆盖默认更新检查接口；打包应用忽略该变量及 `--zcode-update-feed-url` 启动参数，继续使用既有服务端 manifest 入口。开发态覆盖时仍会写入当前 `platform` / `device_mid` / `channel` 查询参数和对应 header，不切换到旧 generic feed。
- Windows 签名与换证：更新授权依赖官方 HTTPS 清单，下载文件须通过清单哈希和有效 Authenticode 签名校验；不按历史发布者 DN 限制新签名者，也不需要用户预装换证过渡版。包内 `publisherName` 仅用于激活自定义校验并保留签名诊断信息，详见[Windows 更新信任边界与换证](desktop/auto-update-service-manifest.md#windows-更新信任边界与换证)。
- `ZCODE_ENV`：可选，`production` 打正式包，`test` 打测试包。测试包文件名会追加 `_TEST`，构建产物飞书通知会把环境标识放进卡片标题；测试环境标题背景色使用红色，正式环境使用默认蓝色。`publish-release.sh` 会拒绝 `ZCODE_ENV=test` 调用正式 release API。
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`：macOS notarytool 公证凭据
- `APPLE_SIGNING_IDENTITY` 或 `CSC_NAME`：macOS 签名身份
- `APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64` / `APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD`：macOS Developer ID Application p12。配置后 macOS build job 会为当前 job 创建一次性 keychain 并导入 p12，runtime 预签名和 electron-builder 最终签名都显式使用该 keychain，避免多个 job 共享 runner login keychain 时触发 `errSecInternalComponent`
- `CSC_LINK` / `CSC_KEY_PASSWORD`：Windows 证书环境变量，由 `electron-builder` 直接消费
- `ZCODE_FEISHU_NOTIFY_TOKEN`：必配，构建产物 Card 2.0 通知经 zcode-internal 通用飞书通知服务发送所需的服务令牌，需与服务端配置同值；可选 `ZCODE_FEISHU_NOTIFY_BASE_URL` 覆盖服务地址（默认 `http://intranet.example.invalid:3011`）
- `FEISHU_RECEIVE_ID` / `FEISHU_RECEIVE_ID_TYPE`：构建产物通知的接收方，作为显式收件人传给通知服务；未配置时回落到服务端配置的场景默认收件人
- `ZARA_RELEASE_NOTIFY_*`：发版成功通知的 Zara/飞书发送配置，仅在正式 tag 发布并通过 `release:approve` 放行后的 `release:notify:feishu` 中使用；CI 默认配置接收群和远端发送目录
- `FEISHU_RELEASE_APP_ID` / `FEISHU_RELEASE_APP_SECRET`：发版通知专用飞书应用「ZCode 发版通知」的凭据，建议配成 GitLab masked CI 变量；未配置时读取 runner 本机发版服务目录中的 `.env`（同名两个 key，可用 `FEISHU_RELEASE_ENV_FILE` 覆盖路径）；两处都没有才回退旧的 Zara 发送链路并打印 warning
- `RELEASE_NOTIFY_*`：`ZARA_RELEASE_NOTIFY_*` 中通用配置（`VERSION`、`LATEST_YML`、`RECEIVE_ID`、`CHAT_ID`、`RECEIVE_ID_TYPE`、`RETRY_RECEIVE_ID`、`DRY_RUN`）的新名，新名优先，旧名继续可用
- `RELEASE_API_KEY` / `RELEASE_API_URL` / `RELEASE_API_KEY_TEST` / `RELEASE_API_URL_TEST` / `RELEASE_API_IDEMPOTENCY_KEY` / `RELEASE_API_CONNECT_TIMEOUT` / `RELEASE_API_MAX_TIME` / `RELEASE_API_TEST_RETRY_ATTEMPTS` / `RELEASE_API_RETRY_DELAY_SECONDS` / `RELEASE_STATUS`：`publish-release.sh` 调用后端发版接口所需变量（`RELEASE_API_URL` 默认 `https://zcode.z.ai/api/v1/releases`，`RELEASE_STATUS` 默认 `3`）。`release:publish:gray` 在调用发版接口前还会执行 `reset-release-rollout.sh`，该脚本需要受保护、masked 的 `ROLLOUT_ADMIN_TOKEN`，默认调用 `https://zcode-api.z.ai/api-admin/v1/releases/gray`，也可通过 `ROLLOUT_API_URL` 或 `ZCODE_RELEASE_GRAY_API_URL` 覆盖；该请求必须走 HTTPS 受保护后端入口并发送 `Authorization: Bearer $ROLLOUT_ADMIN_TOKEN`。脚本会先读取当前灰度配置，再提交完整 `{ disabled: true, percentage: 0, device_mid_allowlist? }`，避免后端灰度接口拒绝 partial payload。配置 `RELEASE_API_URL_TEST` 时必须同时配置受保护、masked 的 `RELEASE_API_KEY_TEST`；脚本不会把生产 `RELEASE_API_KEY` 发送到测试域名。同一份 release request body 会在主 `RELEASE_API_URL` 成功后继续尽力 POST 到测试 release API；两个 endpoint 使用相同 `Idempotency-Key` header，默认值由 release body 与 status 派生，也可通过 `RELEASE_API_IDEMPOTENCY_KEY` 覆盖。测试接口默认重试 `3` 次，重试间隔按 `RELEASE_API_RETRY_DELAY_SECONDS`（默认 `5` 秒）指数退避。脚本会在第一次网络请求前校验纯配置错误：`RELEASE_API_TEST_RETRY_ATTEMPTS` 允许 `1..5`，`RELEASE_API_RETRY_DELAY_SECONDS` 允许 `0..300`，`RELEASE_API_CONNECT_TIMEOUT` 允许 `1..60`，`RELEASE_API_MAX_TIME` 允许 `1..600`。任一接口最终返回非 2xx 或 curl 传输失败都会让 publish job 失败并阻断后续 CI，但脚本不会自动回滚已经成功的主 release API，发布负责人需要按同一份 release metadata 和幂等键做人工补偿。每次 POST 默认连接超时 `10` 秒、总耗时上限 `60` 秒；响应体写入每次脚本执行独占的 `mktemp -d` 临时目录并在退出时清理，避免共享 runner 上并发 publish job 互相删除或串读响应文件。`RELEASE_STATUS` 只允许单个数字状态，灰度 job 固定传 `3`，全量 job 固定传 `1`，禁止通过列表在同一个 publish job 内同时发布多个状态。`CI_RELEASE_BRANCH=1` 且 `RELEASE_STATUS=1` 默认失败；仅在明确批准的 release rehearsal 中设置 `ALLOW_CI_RELEASE_STABLE_PUBLISH=1`。

## 关键脚本

- `scripts/assert-node-version.mjs`：确保 CI 上的 Node 版本符合仓库要求
- `scripts/ci-collect-artifacts.mjs`：从 `packages/desktop/dist` 收集当前平台构建产物、更新元数据和 blockmap
- `scripts/notarize-macos.sh`：由 `build:macos:*` 在产物收集后执行 DMG Developer ID 签名、公证、stapler 与 Gatekeeper 验收；正式 tag 发布缺少 Apple 凭据或签名身份时会失败，非正式链路仍可跳过并保留未公证产物命名供测试排查使用。
  - 公证后去掉 `.unnotarized` 后缀时，同步更新 `latest.yml` / `latest.yaml` 引用 DMG 的 size 与 sha512；通过符号链接路径执行脚本也必须更新，不能因入口路径形式不同而静默跳过。
- `scripts/upload-oss.sh`：上传 Electron 版本化安装包并解析唯一的 `latest.yml` 生成发版元数据；不读取或上传 locale/legacy 更新清单，也不覆盖 stable feed。Electron 版本化路径为 `oss://<bucket>/<path-prefix>/$VERSION/<platform>-<arch>/`，例如 `.../3.3.3/macos-arm64/`；Source Server descriptor/archive 进入同一版本目录。当 `CDN_DOMAIN` / `OSS_BUCKET` 配置多值时，每组目标都会上传完整版本目录和 Source Server assets；release metadata 使用第一组 CDN 目标。
  - 正式 macOS tag 发布只允许上传已完成签名、公证和 staple 的 `*.dmg`；如共享目录仍存在 `*.unnotarized.dmg`，upload 会直接失败，避免 Gatekeeper 校验不完整的安装包进入 CDN。
  - upload job 会同时输出 `release-meta-*.json`（由 `RELEASE_META_OUT` 指定），供 publish 阶段聚合；正式发布主链路默认会有 `darwin-aarch64`、`darwin-x86_64`、`windows-x86_64`、`windows-aarch64`、`linux-x86_64`、`linux-aarch64`。
  - Linux upload 手动执行时必须存在有效的 `latest.yml`，并基于其中的 AppImage `path` / `sha512` 生成发版元数据。
  - 通过 `EXTRA_UPLOAD_SOURCE_DIR` 与 `EXTRA_UPLOAD_FILES` 附带上传 `source-server-release.json` 与 `zcode-server-*.tar.gz`，并写入 `CDN_URLS_OUT` 参与预热
- `scripts/cdn-preload.sh`：对上传后的 CDN URL 执行预热。`upload-oss.sh` 会保留第一组 CDN URL 用于 release metadata，同时按 `CDN_DOMAIN` 目标列表把所有域名写入 `cdn-urls-*.txt`；`release:preload:cdn` 消费版本化平台/架构产物和 Source Server URL 并执行预热。脚本默认处理清单中所有带有效 size 的 URL，不再按体积跳过小文件；`PRELOAD_MIN_BYTES` 仅作为人工调试开关，显式设置为大于 0 时才按记录的文件大小筛选。阿里云 OpenAPI region 与 CDN 预热范围由 aliyun profile 和域名自身配置管理，脚本不显式传 `--region` 或 `--Area`。
- `scripts/publish-release.sh`：读取 `release-meta-*.json` 组装 `{ releases: [...] }` 请求体并调用后端 release API。灰度 job 发送 `status=3`，全量 job 发送 `status=1`；配置 `RELEASE_API_URL_TEST` 时同步双写测试 release API。脚本不执行任何 OSS feed 上传。
- `scripts/notify-release-feishu.js`：读取共享目录 `macos-arm64/latest.yml` 中的 `releaseNotes`，校验清单版本与通知版本一致后，用专用飞书应用直接调用飞书 OpenAPI（tenant_access_token + im/v1/messages）发送 Card 2.0 交互卡片（无凭据时回退 Zara）；Tag pipeline 使用 `CI_COMMIT_TAG`，非 Tag release 演练必须显式设置 `ZARA_RELEASE_NOTIFY_VERSION`。支持逗号分隔的多群接收配置、接收方级稳定 `uuid`、失败群继续发送及 `RELEASE_NOTIFY_RETRY_RECEIVE_ID`（旧名 `ZARA_RELEASE_NOTIFY_RETRY_RECEIVE_ID`）精确补发。`RELEASE_NOTIFY_DRY_RUN=1`（旧名 `ZARA_RELEASE_NOTIFY_DRY_RUN`）只输出卡片 JSON 和 payload 大小，不调用飞书 API
- `scripts/notify-feishu.mjs`：构建阶段产物通知，发送自组装的 Feishu Card 2.0；标题展示构建状态、环境、架构和分支，正文展示提交人及提交信息，底部按钮打开产物或失败 Job 地址，卡片失败由 CI 包装脚本吞掉，不阻断主流水线

## CDN 与自动更新清单缓存

- 唯一的 `latest.yml` 更新清单进入版本化平台/架构目录并包含 `releaseNotesByLocale`；同一版本目录应按不可变资产处理。当前 CI 不生成 locale 或旧 generic stable feed 副本。
- 服务端 manifest 发布后若 CDN 对新版本目录尚未完成预热，客户端可能短时间下载失败，因此 `publish` 必须等待 `release:preload:cdn` 成功。

## 排障重点

- 如果 `prepare:desktop-runtime` 失败，先看下载日志里打印的 URL，通常是外网访问或上游发布资产变化
- 如果 `build:remote:assets` 失败，优先检查 `packages/desktop/mock-cdn/releases/<version>/` 下是否存在 `node/<platform-arch>`，以及 runner 对上游二进制下载源的网络访问
- 如果 macOS 公证失败，先确认 `APPLE_*` 三个变量是否完整，以及 runner 上是否能执行 `xcrun notarytool`
- 如果 upload 阶段报错缺少更新元数据，优先检查共享目录里是否存在对应平台目录下的 `latest.yml`
- 如果某个平台没有产物，优先检查 `packages/desktop/dist` 下文件名是否仍符合 `ZCode-{version}-{os}-{arch}` 约定
- 如果共享目录里缺少文件，先确认 build job 的 `CI_ARTIFACT_OUTPUT_DIR` 是否指向 runner 实际挂载的共享路径

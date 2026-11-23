# Remote Asset Network Policy

Current Desktop network policy for Source Server release downloads. Runtime layout, installation,
handshake and ownership are defined in the [R3 specification](../architecture/r3-source-server-remote-architecture.md)
and [Server CLI/daemon specification](../architecture/r2-server-cli-and-daemon.md).
The old Remote Host process, loose-file layout and deployServer transaction are not the R3 path.

### Desktop-side network policy

All HTTP(S) requests issued by the Desktop Window Host while resolving remote
assets must use the same immutable Host network transport as app-managed API
requests. R3 requests are the release descriptor and complete Source Server archive.
The retained legacy adapter also uses this port for component metadata and optional progress HEAD requests.

- `AppSettings.httpProxy`, `httpProxyNoProxy`, and `httpProxyCaCertPath` remain
  the only Desktop authority for this transport. Ambient shell proxy and CA
  variables are not an implicit source.
- An explicit proxy or CA failure is fail-closed for mandatory manifest and
  component requests; they must not retry through `globalThis.fetch`. The
  optional remote-download progress `HEAD` keeps its existing best-effort
  failure behavior, but it must not fall back to a direct request.
- Remote-asset requests reuse the lifecycle snapshot and dispatcher pool owned
  by the Window Host's base local service collection. They must not create an
  additional download-specific proxy-policy source or dispatcher pool; the
  existing desktop-attached remote service collections keep their own API
  transport ownership unchanged.
- Standalone server callers that do not receive the Desktop-owned transport keep
  their existing direct behavior.
- In `remote-download` mode only the Desktop-side manifest and progress metadata
  requests use this policy. The component archive itself is still downloaded by
  the remote machine's `curl` or `wget` and therefore follows the remote
  machine's network configuration.

```text
setting.json
  httpProxy / noProxy / CA
            |
            v
Window Host base-service network transport (lifecycle snapshot)
       |                         |
       v                         v
NodeApiClient             RemoteAssetNetworkPort
                              |        |
                              v        v
                         manifest   archive / HEAD
                              |
                              v
                    local cache -> SSH upload
```

### R3 Source Server release downloads (B-04)

POSIX 完整包与组件包的可执行权限由目标发行布局决定，不依赖打包宿主的文件权限。
Windows 的 NTFS 不保留 POSIX 执行位；生成 tar 时必须将 `bin/zcode`、`runtime/node`、
随包原生搜索工具及 node-pty 的 `spawn-helper` 写为 `0755`，普通脚本、数据与声明文件不增加执行位。
归档不携带宿主 xattr。安装端继续直接执行归档中的入口，不以安装时补权限掩盖坏包。
工程回归须读取完整包和组件包的 tar 元数据，不能因 Windows 上 `stat.mode` 不支持执行位而跳过。

The same Desktop network policy applies to `source-server-release.json` and the
Source Server archive. The connection and management/update resolver callbacks
must both pass the Window Host's existing `RemoteAssetNetworkPort`; descriptor
and archive requests must not bypass it through global fetch. Local staged
archives keep their existing verification path. In `remote-download` mode the
Desktop fetches only the descriptor; the remote archive download retains its
remote network policy. No global dispatcher, task protocol, workspace identity,
or continuous/replayable delivery behavior changes.

Verification: an isolated resolver test forbids global fetch and observes both
requests through the injected port. `SSH-P0-CONN-04` uses a clean remote target,
a cold Desktop with explicit proxy settings, an empty local cache, and a CDN
hostname available only through the case-local proxy. It asserts descriptor and
archive requests, matching remote archive SHA, successful connection, and one
Window Host. Proxy failure must fail without direct fallback.

### Retained component installer failure contract

The retained `RemoteDownloadAssetInstaller` must stop on the first failed
foreground staging, download, checksum, extraction, or cache publication step.
Its shell transaction runs sequential commands under `set -eu`; compound
progress and cleanup commands must not split an `&&` chain and turn failure
into success. Cleanup removes only this transaction's staging and lock, preserves
the failure status and diagnostic, and must not publish `.ready` for a failed
component. `installFile`/`installDirectory` must reject before copying from that
failed component. A subsequent attempt must be able to download and install it.

```text
download / checksum / extraction fails
  -> transaction exits nonzero -> owner cleanup
  -> installer rejects with original diagnostic -> no component copy
```

Regression coverage executes the actual installer-generated script in a POSIX
shell, with controlled downloader results, and checks rejection, cleanup, retry
and successful installation. This contract does not change the R3 Desktop
connection flow: R3 executes its archive download separately and already checks
that command's exit status before installation. Its shared download command
builder, local-upload mode and platform compatibility policy remain unchanged.

## Historical deployment reference

The pre-R3 layout, serialization and rollback investigation remain available in the fixed document snapshot:

```bash
git show a17a875588b8d66c2bee49236292e174df651363:docs/remote/zcode-agent-remote-deployment.md
```

Retained legacy code is subject to the R3 removal/rollback boundary; this document does not authorize deleting it.

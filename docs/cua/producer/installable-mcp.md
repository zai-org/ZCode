# Installable MCP package

> DEPRECATED. The Python MCP server that lived in this repo is **removed**, so
> there is no longer a Python distribution to install. The canonical CUA MCP
> tool is now the TypeScript package **@zcode/zcode-cua** (npm). This document
> described the old `uvx --from zcode-cua[macos]@<wheel> zcode-cua` install
> profiles, the private-PyPI / file-share distribution flows, and the
> `scripts/package_mcp_distribution.py` release-bundle pipeline — all of which
> targeted the removed Python wheel and no longer apply.

Install the canonical tool from npm:

```bash
npm install @zcode/zcode-cua
# or, without installing:
npx @zcode/zcode-cua
```

The TypeScript CLI supports both transports. STDIO is still the default; local
Streamable HTTP is available explicitly:

```bash
npx @zcode/zcode-cua --transport streamable-http --host 127.0.0.1 --port 8001
```

The MCP endpoint is `http://127.0.0.1:8001/mcp`.

Source and the product/broker install profiles live in the z-code repo:
[git.example.invalid/codegeex/z-code](https://git.example.invalid/codegeex/z-code)
→ package [@zcode/zcode-cua](https://www.npmjs.com/package/@zcode/zcode-cua).

What this repo still hosts (the real-model act-verify harness, the canonical
skill, screenshot-pipeline parity fixtures) is described in the top-level
`README.md`. The earlier Python packaging/distribution guide is preserved in the
git history of this repo (see the commit prior to `refactor/deprecate-python`).

Current producer integration is documented in the
[monorepo migration guide](../zcode-cua-monorepo-migration.md).

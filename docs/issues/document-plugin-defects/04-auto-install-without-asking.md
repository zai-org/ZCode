# 04 — pdf 插件：缺少依赖时不询问用户就自动安装

Status: needs-triage

## 现象

插件的约定是：大体积或可选的依赖先问用户，再安装。下面两处直接安装：

- `apps/zcode-cli/packages/pdf-plugin/skills/pdf/scripts/html2pdf-next.js:89`：找不到 Chromium 时执行 `npx playwright install chromium`。只有设置 `PDF_SKIP_BROWSER_INSTALL=1` 才跳过（`:562`）。
- `apps/zcode-cli/packages/pdf-plugin/skills/pdf/scripts/pdf.py:1909-1912`：`_pdf_stats` 缺少 pypdf 时，依次尝试 `pip install`、`--break-system-packages` 和 `--user`。

## 影响

- Chromium 下载体积大，用户没有机会拒绝。
- `--break-system-packages` 会绕过系统 Python 的保护。预装 Python 落地后，这段代码在预装 Python 下运行时会把 pypdf 装进预装 Python 的附加区（pypdf 本身已预装，正常不会触发）。

## 背景

在梳理预装依赖时发现。修复时机另定。

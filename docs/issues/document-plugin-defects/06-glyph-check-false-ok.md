# 06 — pdf 插件：缺少 PyMuPDF 时缺字检查报告“没有问题”

Status: needs-triage

## 现象

- `apps/zcode-cli/packages/pdf-plugin/skills/pdf/scripts/pdf.py:2538` 的 `check_missing_glyphs` 导入 PyMuPDF 失败时，只向 stderr 打印警告，然后返回空列表（`:2544-2548`）。
- 调用方 `font.check`（`:2602`）把空列表报告为 `"status": "ok"`。

所以缺少 PyMuPDF 时，缺字检查没有执行，结果却显示通过。

## 影响

PyMuPDF 不预装（法务不通过）。用户没有自行安装 PyMuPDF 时，这个误报会在所有环境出现，包括预装 Python 已就绪的桌面端。

## 待确认

- 缺少依赖时是否应报告“未执行”或非零退出码，而不是“通过”。

## 背景

在梳理预装依赖时发现。修复时机另定。

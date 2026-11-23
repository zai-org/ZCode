# 05 — 文档插件：安装脚本漏装代码使用的依赖

Status: needs-triage

## 现象

代码使用了下列依赖，但插件的安装脚本不安装它们：

| 依赖              | 使用位置                                                                                      | 安装脚本                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| python-docx、lxml | `documents-plugin/skills/docx/scripts/add_toc_placeholders.py:49`、`:453`；生成目录时必然执行 | `docx/env_setup/setup_mac_linux.sh:156-158` 只装 defusedxml |
| pdf-lib（npm）    | `pdf-plugin/skills/pdf/scripts/html2pdf-next.js:58`，每次运行都 require                       | 没有脚本安装                                                |
| pdfplumber        | xlsx 插件 `scenes/convert.md` 使用                                                            | xlsx 的安装脚本不装                                         |

另有反方向的问题：xlsx 安装并检查 XlsxWriter，代码没有使用；pptx 把 playwright、sharp、markitdown 列为必需，SKILL.md 中没有调用。

## 影响

本机桌面落地预装 Python 后，python-docx、lxml、pdfplumber 由预装资源提供，桌面端不再受影响。远端、Web 服务端、独立 CLI 和容器环境仍受影响。pdf-lib 属于 Node 包，在下一期之前各环境都受影响。

## 背景

在梳理预装依赖时发现。修复时机另定。

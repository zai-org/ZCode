# Third-Party Attribution Notice

本目录的大部分内容取自开源项目 **Open Design**（Apache License 2.0），另有几组子目录取自其他项目、各自保留原许可。
本文件记录来源、本仓库所做修改与第三方品牌声明。仓库级登记见 `third-party/copied-components.json`，
生成的总声明见仓库根 `THIRD-PARTY-NOTICES.md`。

---

## 一、主体来源：Open Design

| 项 | 内容 |
|---|---|
| 仓库 | <https://github.com/nexu-io/open-design> |
| 对照版本 | tag `open-design-v0.7.0`，commit `11b4750677177c6e7918abd9463224da6331cede` |
| 协议 | Apache License 2.0，全文见同目录 [`LICENSE.md`](./LICENSE.md)（与上游 `LICENSE` 逐字节一致） |
| 原始版权 | Copyright 2026 Open Design contributors |
| NOTICE | 上游在该版本没有 NOTICE 文件 |

导入时没有记录上游 commit；上面的对照版本是按文件 Git blob 比对找到的匹配快照，不声称是原始导入提交。

| 本仓库路径 | 上游路径 |
|---|---|
| `design-skeletons/` | `design-templates/`（改名，SKILL.md 内部引用不受影响） |
| `design-systems/` | `design-systems/` |
| `skills/` | `skills/` |
| `craft/` | `craft/` |

---

## 二、本仓库的修改

### 改过的文件

以下文件相对上游有改动，每个文件内都有一行 `Modified by ZCode:` 说明改了什么（Apache-2.0 第 4(b) 条）：

- `craft/anti-ai-slop.md`
- `design-skeletons/html-ppt-hermes-cyber-terminal/{SKILL.md,example.html}`
- `design-skeletons/mobile-app/{SKILL.md,assets/template.html,references/checklist.md}`
- `design-skeletons/open-design-landing-deck/{SKILL.md,schema.ts}`
- `design-skeletons/orbit-notion/{SKILL.md,example.html}`
- `design-skeletons/saas-landing/{SKILL.md,example.html}`
- `design-skeletons/web-prototype/{SKILL.md,assets/template.html}`
- `design-skeletons/wireframe-sketch/{SKILL.md,example.html}`
- `skills/frontend-design/SKILL.md`、`skills/taste-skill/SKILL.md`（来源见第三节）

### 本地新增（上游没有）

- `design-skeletons/ai-assistant-mobile-dashboard/`
- `skills/infinite-canvas/`
- `LICENSE-html-ppt`（html-ppt 许可原文的副本）、`design-systems/BRAND-DISCLAIMER.md`、本文件

### 删除

- 上游的 `community-pets/`、`bin/`、`prompt-templates/`、`frames/`、`design-skeletons/AGENTS.md` 等与设计技能无关的内容未随包
- `skills/competitive-ads-extractor/`：上游（ComposioHQ/awesome-claude-skills）任何版本都没有许可原文，已移除

---

## 三、自带独立许可的子目录

| 子目录 | 上游 | 许可 |
|---|---|---|
| `design-skeletons/html-ppt-{course-module,hermes-cyber-terminal,pitch-deck}/` | lewislulu/html-ppt-skill，经 Open Design 改编 | MIT，Copyright (c) 2026 lewis，见 `LICENSE-html-ppt` |
| `design-skeletons/html-ppt-zhangzara-*/` | zarazhangrui/beautiful-html-templates，经 Open Design 打包 | MIT，Copyright (c) 2026 Zara Zhang，各目录自带 `LICENSE` |
| `skills/frontend-slides/` | zarazhangrui/frontend-slides | MIT，Copyright (c) 2025 Zara Zhang，目录内 `LICENSE` |
| `skills/design-consultation/`、`skills/design-review/`、`skills/plan-design-review/` | garrytan/gstack | MIT，Copyright (c) 2026 Garry Tan，目录内 `LICENSE`、`NOTICE.md`、`licenses/` |
| `skills/brand-guidelines/` | anthropics/skills | Apache-2.0，目录内 `LICENSE.txt` |
| `skills/frontend-design/` | anthropics/skills | Apache-2.0，目录内 `LICENSE.txt`（上游原文，无版权行） |
| `skills/taste-skill/`；`design-skeletons/{html-ppt,web-prototype}-taste-*/`（后者是 Open Design 对 taste-skill 的改编） | Leonxlnx/taste-skill | MIT，Copyright (c) 2026 Leonxlnx，见 `skills/taste-skill/LICENSE` |

各子目录的固定上游 revision 与比对证据登记在 `third-party/copied-components.json`。

---

## 四、第三方品牌商标声明

`design-systems/` 下的 `DESIGN.md` 引用了第三方品牌的视觉风格（Apple、Linear、Stripe、Notion、Vercel、Figma 等）。
这些品牌名称、商标与设计语言归各自所有者所有；这里只作非官方的风格参考，不构成合作或授权，
生成的设计稿不得以这些品牌名义对外发布或造成商业混淆。详见 [`design-systems/BRAND-DISCLAIMER.md`](./design-systems/BRAND-DISCLAIMER.md)。

---

## 五、责任声明

上游内容按 "AS IS" 提供，无任何明示或默示担保；本仓库的再分发遵循同样的责任分配。

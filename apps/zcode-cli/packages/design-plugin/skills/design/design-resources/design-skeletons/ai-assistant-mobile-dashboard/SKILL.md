---
name: ai-assistant-mobile-dashboard
description: |
  AI 助理 / 智能管家 类**手机 App** 的 Dashboard 形态骨架。区别于传统 chatbot
  形式——以信息聚合卡片 + 命令面板入口为主，对话只是底层能力之一。
  覆盖场景：个人助理 / AI 秘书 / 智能管家 / 日程管家 / 信息聚合 App / Copilot-style 助手。
  调用本 skill 时 agent 必须 clone example.html 作起点（**不允许从空白写**），
  并按当前项目的 design-system token 替换 + 改写文案。
triggers:
  - "ai 助理"
  - "智能管家"
  - "个人助理 app"
  - "ai 秘书"
  - "copilot app"
  - "智能 dashboard"
  - "日程管家"
  - "信息聚合 app"
od:
  mode: prototype
  platform: mobile
  scenario: ai-assistant
  preview:
    type: html
    entry: example.html
    reload: debounce-100
  design_system:
    requires: true
    sections: [color, typography, layout, components]
    recommended_brands: [raycast, arc, agentic, vercel, linear-app]
  craft:
    requires: [typography, color, anti-ai-slop, accessibility-baseline,
               state-coverage, animation-discipline, laws-of-ux, typography-hierarchy]
  inputs:
    - name: app_name
      type: string
      required: true
    - name: hero_tagline
      type: string
      required: true
    - name: user_locale
      type: enum
      values: [zh-CN, en-US, ja-JP, ...]
      default: zh-CN
    - name: card_categories
      type: enum[]
      values: [calendar, inbox, weather, activity, music, finance,
               commute, news, smart-home, focus-block]
      default: [calendar, inbox, weather, activity]
      min: 3
      max: 6
  parameters:
    - name: density
      type: enum
      values: [compact, comfortable, spacious]
      default: comfortable
    - name: theme
      type: enum
      values: [dark, light, auto]
      default: dark
    - name: accent_intensity
      type: opacity
      default: 1.0
      range: [0.6, 1.0]
  outputs:
    primary: index.html
  capabilities_required:
    - file_write
---

# AI Assistant Mobile Dashboard · 设计骨架

**Agent，严格按本流程执行。禁止跳步。禁止从空白写。**

## LOCALIZATION RULE

When instantiating this skeleton for a user, the agent MUST write ALL visible copy (headings, labels, body text, placeholder strings) in the user's conversation language. Machine fields (element id, class, data-* attributes, HTML lang attribute) remain in English unless the user's language requires a different lang attribute. The `<html lang>` attribute must match the user's language.

## 1. 读上下文（必做）

按 **`OUTPUT_RULES §三·补`** 执行输出前必读三件套——view skeleton example.html + `审美相关skill/design-systems/<used_design_system>/DESIGN.md` + `od.craft.requires` 数组里所有 craft.md。

完整规则、例外条款、跳过声明方式见 `OUTPUT_RULES §三·补`，本文件不重复。

> ⚠️ **未 view 三件套即开始生成 → 视为"凭记忆走捷径" → 必须中止生成、重新走 view 流程**。
> ⚠️ design-system 明示规范与 craft 黑名单冲突时，按 `OUTPUT_RULES §三·补·补` 仲裁规则 → design-system 胜（详见 OUTPUT_RULES）。

## 2. 复制骨架（必做）

- 把本目录的 `example.html` **整文件复制**到工作区，命名为 `{app_name}-Dashboard V1.0.html`
- 保留 `<style>` 块所有 CSS 结构不动，先改 `:root` token 映射到选定 design-system

## 3. 段落清单（按顺序）

骨架强制包含以下 6 段，**少一段不允许**：

1. **Context Strip** —— 顶部时间 / 场景上下文（如 "周一 17:48 · 傍晚"）
2. **Hero Card** —— 当日核心摘要 + 命令面板入口（⌘K 或类似手机版命令栏）
3. **Metric Tiles** —— 双列卡片 2-4 个（如 日程 / 收件箱 / 天气 / 运动）
   - 每个 tile：label + 大数字（mono + tabular-nums）+ 1 行 secondary copy
4. **Recent Threads** —— 信息聚合卡（消息 / 邮件 / 提及）3-5 条
5. **Suggestion / Command Hint** —— accent 色背景的智能建议卡（点击执行）
6. **Footer** —— 极简版本号 + 尺寸标识

## 4. 应用 design-system（硬约束）

- 所有颜色 token 必须来自 `审美相关skill/design-systems/<brand>/DESIGN.md`
- 禁止凭记忆写 hex 值
- accent 色全屏使用 ≤ 3 次（hero CTA + 一个 metric 数字 + suggestion 卡背景）
- 不要堆阴影——若 design-system 未明确允许，全程不加 box-shadow

## 5. 文案准则（硬约束）

按 **`DESIGN.md §七` + `OUTPUT_RULES §七·补`**：

- **必须匹配用户 query 的语言**——中文 query → 中文文案（含人名 / 城市 / 卡片标签 / footer 微文案）
- 借鉴英文 design-system 时**只借视觉 token，不借文案**
- 禁止 lorem ipsum / "John Doe" / 编造的 stats（如 "10,000+ users"）
- mock 数据必须真实可信——人名用中文名 / 城市用真实地名 / 时间用合理时间

## 6. 应用 craft（硬约束）

按 `od.craft.requires` 拉取的 8 个工艺文件硬规则：

- `typography` —— `tabular-nums` 强制 / 字间距 / 行高
- `color` —— oklch 优先 / 对比度 ≥ 4.5（暗色 ≥ 12:1 是 dashboard 加分项）
- `anti-ai-slop` —— 禁用清单（Inter / Roboto / 紫渐变 / Bento grid / 左 border accent / "10,000+" 装饰数字）
- `accessibility-baseline` —— 触控目标 ≥ 44pt / 焦点态 / 语义化 HTML
- `state-coverage` —— **dashboard 必跑**：loading / empty / error 三态
- `animation-discipline` —— hero 卡轻微入场 + 命令栏点击微震反馈，禁止散落微交互
- `laws-of-ux` —— Fitts（关键操作放下半屏）/ Hick（命令面板入口固定一处）
- `typography-hierarchy` —— mono 数字 + sans 标题 + sans body 三级层级

## 7. 自检（必做，逐项打勾）

交付前必过：

- [ ] 所有文字内容**真实可信 + 匹配用户语言**——无 lorem / 无 "John Doe" / 无编造 "10,000+"
- [ ] 每个 hex 来自 design-system DESIGN.md
- [ ] 触控目标 ≥ 44pt / 不依赖 hover / 单手可达
- [ ] accent 色全屏 ≤ 3 处
- [ ] 顶部 status bar 安全区已留（44pt iOS / 设备相应值）
- [ ] tabular-nums 数字等宽
- [ ] 每个 section 含 `data-od-id="<slug>"`
- [ ] 字体不是 Inter / Roboto / Fraunces / Space Grotesk
- [ ] 没有紫渐变 / mesh gradient / 左 border accent 卡片 / 编造装饰数字

## 8. 写文件 + MEDIA: + 自检 + 归档

按 `OUTPUT_RULES §三 / §四 / §六`：
- 真实写入 `.html` 到工作区，**禁止只展示路径**
- 主动通过 `MEDIA:` 唤起端内预览
- 跑 Phase 3 自检 9 项 + DESIGN §十二 8 项
- 交付完成后按 OUTPUT_RULES §六 归档（加 `[DONE]` 标记，改"已交付"）✅

---

## 给 skill 编写者的注释

本 skill 是从首次实战测试（用户首句"做一个科技感酷的个人助理 App"）抽取出来的产品级范式。

结构：

```
ai-assistant-mobile-dashboard/
├── SKILL.md       ← 本文件（指令）
└── example.html   ← 可 clone 的成品骨架（含 6 段 + Raycast 风格 token）
```

要点：
- `od:` frontmatter 声明依赖 + 输入 + 可调参数。Agent 读 frontmatter 自动按依赖拉资源
- `data-od-id` 标注让 inline-comment patch 机制可定位元素做局部 patch
- design-system 是协作者不是覆盖——本 skill 给 agent 按 brief 微调权力，但不允许凭空发明新 token
- 推荐 design-system：raycast（工具感）/ arc（柔和未来）/ agentic（AI 平台原生）/ vercel（极简技术）/ linear-app（极简紫黑）

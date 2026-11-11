---
name: saas-landing
description: |
  单页 SaaS 落地页骨架，含 hero / features / social proof / pricing / footer-CTA / footer 六段式。
  调用本 skill 时 agent 必须 clone example.html 作起点（**不允许从空白写**），并按当前项目的
  DESIGN.md 视觉规范替换 token + 改写文案。
  触发关键词：SaaS 落地页 / 营销页 / 产品官网 / landing page。
triggers:
  - "saas 落地页"
  - "营销页"
  - "产品官网"
  - "landing page"
  - "marketing page"
od:
  mode: prototype
  platform: desktop
  scenario: marketing
  preview:
    type: html
    entry: example.html
    reload: debounce-100
  design_system:
    requires: true
    sections: [color, typography, layout, components]
  craft:
    requires: [typography, color, anti-ai-slop, laws-of-ux]
  inputs:
    - name: product_name
      type: string
      required: true
    - name: tagline
      type: string
      required: true
    - name: has_pricing
      type: boolean
      default: true
    - name: proof_count
      type: integer
      default: 4
      min: 0
      max: 6
  parameters:
    - name: hero_density
      type: spacing
      default: 96
      range: [48, 200]
    - name: accent_strength
      type: opacity
      default: 1.0
      range: [0.5, 1.0]
  outputs:
    primary: index.html
  capabilities_required:
    - file_write
---
<!-- Modified by ZCode: rewritten as a Chinese six-section skeleton. Derived from open-design 0.7.0 (Apache-2.0); see design-resources/NOTICE.md. -->

# SaaS Landing Skill · 单页落地页骨架

**Agent，严格按本流程执行。禁止跳步。**

## 1. 读取上下文（必做）

动手前：
- 读当前工作区的 `DESIGN.md`。**缺则停下来索取，不要硬上**。
- 提取色板、字体、布局原则、组件样式 token。
- 注意 DESIGN.md 的 **"Agent Prompt Guide"** 段——若与本 skill 指令冲突，**以 DESIGN.md 为准**。

## 2. 复制骨架（必做）

- 把本目录下的 `example.html` **整文件复制**到工作区，命名为 `{项目名}.html`
- **禁止从空白 HTML 重写**——骨架已包含 6 段结构、token 变量、`data-od-id` 锚点、响应式断点
- 复制后保留 `<style>` 块所有 CSS 不动，先改 `:root` 里的 CSS 变量映射到 DESIGN.md

## 3. 段落清单（按顺序）

骨架强制包含以下 6 段，**少一段都不允许**：

1. **Hero** — logo / 主标题（tagline 输入）/ 副标题 1-2 句 / 主 CTA / 次 CTA
   - 主标题字号 `clamp(44px, 6vw, 76px)`，行高 `1.05`，字距 `-0.02em`
   - hero 段上下 padding 用 `hero_density` 参数（默认 96px）
2. **Features** — 3-6 个特性卡片
   - 每个：编号（mono 字体）/ 标题 / 1-2 句 body
   - **必须有内容差异**——禁止 3 张完全对称的卡片
3. **Social proof** — `proof_count` 个 logo 或评价
   - 若 `proof_count = 0` 跳过本段
   - **禁止编造**「10,000+ happy customers」这类装饰性 stats
4. **Pricing** — 2-3 档（仅当 `has_pricing = true`）
   - 中间档标 "Recommended"，用 accent 色边框
   - 每档：名称 / 价格 / 4-6 项 feature list
5. **Footer CTA** — 大块 accent 色背景的最终行动召唤
6. **Footer** — 极简版权 + 链接

## 4. 应用 DESIGN.md（硬约束）

- **所有颜色必须来自 DESIGN.md tokens**，不得凭空发明 hex
- 字体：display 字体用于 hero / pricing 标题，body 字体用于其它
- accent 色**全页用 ≤ 3 次**（hero CTA + pricing 推荐档边框 + footer CTA 整段）
- 不要堆阴影——若 DESIGN.md 没明确允许，全程不加 box-shadow

## 5. 调用 craft（硬约束）

按 `od.craft.requires` 拉取的 4 个工艺文件：
- `typography` —— 字间距、行高、孤儿寡母、tabular-nums
- `color` —— oklch 优先、不发明色、对比度 ≥ 4.5
- `anti-ai-slop` —— **禁用清单**：Inter / Roboto / Fraunces / 紫渐变 / Bento grid / 左 border accent / Lorem ipsum / 「John Doe」「100% uptime」类编造数字
- `laws-of-ux` —— Fitts / Hick / Miller / 错误恢复

## 6. 自检（必做，逐项打勾）

交付前确认：
- [ ] 所有文字内容**真实可信**，无 lorem ipsum 无「John Doe」无编造的「10,000+」类 stats
- [ ] 每个 hex 值都能在 DESIGN.md tokens 里找到来源
- [ ] 响应式：1440 / 768 / 375 三个断点心算预演通过
- [ ] accent 色全页使用 ≤ 3 处
- [ ] 每个核心元素带 `data-od-id="<slug>"` 注释（hero / features / pricing / footer 等）
- [ ] 字体不是 Inter / Roboto / Fraunces / Space Grotesk
- [ ] 没有紫渐变 / mesh gradient / 左 border accent 卡片
- [ ] 假数据每条至少 5 字段（pricing 卡片至少 4 项 feature）

## 7. 写文件

只输出**单个 self-contained** `{项目名}.html`：
- 所有 CSS 内联在 `<head>` 的 `<style>` 块
- 字体走 Google Fonts CDN（含 system-ui fallback）
- 不引外部 JS
- 语义化 HTML：`<header>` / `<main>` / `<section>` / `<footer>`

**禁止**生成单独的 .css / .js 文件 / README。

---

## 给 skill 编写者的注释

本 skill 是最简但完整的范式。结构：

```
saas-landing/
├── SKILL.md       ← 本文件（指令）
└── example.html   ← 可复制的成品骨架（300+ 行）
```

要点：
- `od:` frontmatter 块声明三轴依赖（design-system / craft）+ 可调参数 + 必填输入。Agent 读到此块自动按依赖拉取其它资源
- `data-od-id` 标注让前端 comment mode 可定位元素做局部 patch
- DESIGN.md 是协作者不是覆盖——本 skill 给 agent 权力按 brief 微调，但不允许凭空发明新 token

---
name: infinite-canvas-output
description: >
  将设计产出以「无限画布」HTML 形式交付，三层架构：
  第一层项目介绍、第二层设计系统、第三层设计稿。
  输出设计/原型/布局/架构相关内容时，默认使用无限画布交付。
---

# Infinite Canvas Output Skill

将设计产出以无限画布 HTML 交付。

**LOCALIZATION RULE**: When instantiating the canvas template, the agent MUST
translate every value in `UI_STRINGS` to the user's conversation language.
Machine fields (element id, class, data-* attributes) remain in English.
The `<html lang>` attribute must match the user's language.

## 三层架构

画布从上到下分三排，每排通过 `addSection()` 创建。

```
┌─────────────────────────────────────────────────────┐
│  Row 1: PROJECT CONTEXT                              │
│  项目名 · 定位 · 标签 · 流程 · 便签 · 自由排布       │
├─────────────────────────────────────────────────────┤
│  Row 2: DESIGN SYSTEM                                │
│  色板 · 字体 · 组件样例 · 自由排布                    │
├─────────────────────────────────────────────────────┤
│  Row 3: DESIGN DELIVERABLES                           │
│  [Page A]    [Page B]    [Page C]                     │
│                                                       │
└─────────────────────────────────────────────────────┘
```

---

### Row 1: Project Context（项目介绍）

这一排要让人一眼看懂项目是什么、给谁用、解决什么问题。

不要求全部塞进卡片。你可以自由混合以下元素类型：

- **大标题**：项目名直接铺在画布上，大字、有存在感，不需要装进卡片里
- **描述文字**：项目一句话定位、核心价值，跟标题放一起，自然排版
- **标签（tag）**：核心关键词用标签呈现（如"5个核心界面"、"AI小白学生"、"游戏化"），散落在标题下方
- **流程图 / 链路图**：核心用户流程、信息架构，用简图表达，不需要卡片包裹
- **卡片**：需要结构化展示的内容（如用户画像、竞品对比、需求列表）才用卡片

布局是自由的。大标题 + 描述可以占一个大区域，标签排版在附近区域，整体有合理的对齐关系，流程图放在下方或右侧。追求的是设计看板的感觉，不是表格。

Agent 根据项目实际情况自主决定用哪些元素、怎么排布。唯一的硬性要求是**回答清楚三个核心问题**。

### Row 2: Design System（设计系统）

展示本次设计使用的视觉规范。**所有内容必须包裹在 `addDesignSystemCard` 卡片内**，不得散落在画布上。

**必须展示（各占一张卡片）**：
- **色板卡片**：用 `addColorSwatch` 生成色块，外层用 `addDesignSystemCard` 包裹
- **字体排版卡片**：用 `addTypeSample` 生成字号阶梯，外层用 `addDesignSystemCard` 包裹
- **组件样例卡片**：按钮、输入框、卡片等核心组件，用 `addDesignSystemCard` 包裹

可选扩展（同样用卡片包裹）：
- 间距 / 网格标注卡片
- 交互状态枚举卡片
- 图标风格说明卡片

**布局**：3–4 张卡片横排，共享同一 Y 起始值，间距 20–40px。视觉调性描述文字可单独放在卡片上方。

所有 token 必须来自 `used_design_system` 的 DESIGN.md，不得凭记忆编造。项目用到的维度就展示，没用到的不凑数。

### Row 3: Design Deliverables（设计稿）

按交互链路从左到右排列所有页面。这是核心交付物。

- 页面从左到右按用户实际操作流程排列

### Figma 可编辑性

Row 3 的页面设计稿必须：
- 页面内部不使用画布特效（无发光、无模糊背景、无渐变叠加）
- 页面内部不使用 emoji 作为图标、头像或产品图占位——用 SVG 线性图标或 CSS 图形
- 保持干净的矩形结构，便于截图后导入 Figma
- 页面尺寸使用标准分辨率（如 375x812, 390x844 等）
- 不在页面上叠加画布 UI

---

## 工作流

1. 读需求 → 提取项目背景、用户、功能需求
2. 定义设计系统 → 色板、字体、间距、组件
3. 规划页面交互链路 → 排列顺序 + 跳转关系
4. 读取模板 → `assets/infinite-canvas-template.html`
5. 生成 HTML → 按三层架构填充内容
6. 调整初始视图 → 首屏能看到 Row 1 完整内容

## 模板 API

### `addSection(rowY, label)`
创建一排的标题标注（如 "01 · PROJECT CONTEXT"），返回该排的 Y 基准值。

### `addTitle(x, y, text, options)`
在画布上创建大标题文字。`options` 支持 fontSize、fontWeight、color。用于 Row 1 的项目名等不需要卡片包裹的文字。

### `addText(x, y, text, options)`
在画布上创建正文段落。用于项目描述、定位说明等自由排布的文字内容。

### `addTag(x, y, label, options)`
创建标签元素。用于关键词、特征标注等。可设置颜色和样式。

### `addContextCard(x, y, w, h, title, content)`
创建项目背景卡片。`content` 支持 HTML。用于需要结构化展示的内容。

### `addDesignSystemCard(x, y, w, h, type, data)`
创建设计系统卡片。`type` 支持：`color` / `typography` / `spacing` / `components` / `custom`。

### `addColorSwatch(x, y, colors)`
创建色块矩阵。`colors` 为颜色数组，每项含 name、hex、token。不需要卡片包裹。

### `addTypeSample(x, y, samples)`
创建字体样例展示。`samples` 为字号阶梯数组，直接渲染真实字体效果。

### `addPage(x, y, w, h, label, htmlContent)`
创建 Row 3 的页面设计稿。`htmlContent` 为页面内部完整的 HTML。

### `addNote(x, y, tag, text)`
创建便签（辅助说明、设计灵感、待确认事项）。

### `addDiagram(x, y, w, h, htmlContent)`
创建流程图 / 链路图。`htmlContent` 为图表内容。用于用户流程、信息架构等。

---

## 布局辅助函数（防重叠）

**所有元素定位必须使用以下函数，禁止硬编码 Y 坐标猜高度。**

### `below(el, gap)`
返回元素 `el` 底边 + `gap` px 的 Y 值。默认 gap=20。用于纵向链式排列。

### `rightOf(el, gap)`
返回元素 `el` 右边 + `gap` px 的 X 值。默认 gap=20。用于横向链式排列。

### `maxY(els, gap)`
返回一组元素中最大底边 + `gap` px 的 Y 值。默认 gap=20。用于跨行衔接——将一行所有元素传入，得到下一行安全起始 Y。

### `maxX(els, gap)`
返回一组元素中最大右边 + `gap` px 的 X 值。默认 gap=20。

### 使用规范

```
❌ 禁止：硬编码猜测
addTitle(100, 90, '标题', { fontSize: 52 });
addText(100, 160, '描述文字...');   // 160 是猜的，标题可能比预期高

✅ 必须：基于实际渲染高度
const title = addTitle(100, 90, '标题', { fontSize: 52 });
const desc = addText(100, below(title, 12), '描述文字...');
const cardsY = below(desc, 24);
```

**核心原则**：
1. 每个 `add*` 调用的返回值必须保存到变量
2. 同行内元素共享同一个 Y 值（该 Y 值由上方元素 `below()` 得出）
3. 跨行衔接用 `maxY([该行所有元素], 80)` 获取下一行起始 Y
4. 横向排列的元素可以用 `rightOf()` 链式获取 X，也可以用固定 X（宽度已知时）
5. Row 间距建议 60–100px，同行元素间距建议 16–32px

## 排版审美

- **字体选择**：避免 AI 默认精选（Inter/Roboto/Space Grotesk），选有辨识度的字体。design-system 明示的除外
- **文字排版**：注意行高、字间距、段间距的呼吸感
- **背景氛围**：不要纯色背景，用噪点纹理 / 渐变网格 / 几何图案创造氛围
- **视觉层次**：标题和正文要有明显的粗细 / 大小对比
- **整体构图**：三层架构的元素排列要有疏密节奏，不要机械等距，重要元素可以更大更突出

## 元素尺寸与文字量

画布元素的宽度和文字量直接影响可读性，遵守以下约束：

| 元素类型 | 最小宽度 | 推荐宽度 | 文字量参考 |
|---------|---------|---------|-----------|
| 卡片（contextCard / dsCard） | 220px | 280–360px | 标题 2–8 字，正文 20–120 字 |
| 便签（note） | 200px | 220–300px | 标签 2–4 字，正文 15–60 字 |
| 文字段落（text） | 200px | 320–520px | 单段 20–150 字 |
| 标签（tag） | — | 自适应 | 2–8 字 |
| 大标题（title） | — | 自适应 | 2–20 字 |

- 中文每行至少 10 个字才有阅读节奏，宽度低于 200px 会导致逐字折行
- 卡片内文字过多时优先拆分为多张卡片，而非在一张卡片里堆内容
- 留白比塞满更重要——宁可多一张卡片，不要一张卡片写满

## 配色

- 不发明颜色。用项目品牌色或 oklch 定义和谐色
- 模板默认暗色画布背景（中性灰，饱和度=0），页面内部可自定义亮色/暗色
- `--accent` 用于排标题、选中态

## 文件命名与版本

- App 类（双交付）：`V{N} {项目名}-无限画布.html` + `V{N} {项目名}-可交互原型.html`
- Web 类 / Deck 类（单文件）：`V{N} {项目名}.html`
- `{N}` 从 1 起递增，无前导零、无小数位（V1 / V2 / V3）
- 每次迭代递增版本，不覆盖旧文件

## 注意事项

- 单文件交付，不依赖外部库
- 图片用 picsum 占位或用户提供的 URL
- 浏览器直接打开即可使用
- 页面和其它元素可自由拖动

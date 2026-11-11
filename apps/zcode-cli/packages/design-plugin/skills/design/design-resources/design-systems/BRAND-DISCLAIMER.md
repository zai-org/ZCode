# 第三方品牌商标声明 — BRAND-DISCLAIMER.md

> 本目录（`design-systems/`）下的 149 个品牌视觉规范，仅作为 AI 设计 agent 的视觉风格参考，**不代表与各品牌的官方合作或授权关系**。

---

## 一、声明范围

`design-systems/` 下的每个子目录（如 `apple/` / `linear-app/` / `stripe/` / `notion/` 等）含有的 `DESIGN.md` 文件，是基于公开可观察的品牌视觉特征（产品官网截图、营销物料、公开品牌指南等）整理出的**第三方非官方解读**。

---

## 二、商标归属

以下品牌名称及其相关商标、Logo、字体、配色方案等**归各自所有者所有**：

```
（按字母序，仅举其中较常见者）
agentic · airbnb · airtable · ant · apple · application · arc · artistic ·
atelier-zero · bento · binance · bmw · bmw-m · bold · brutalism · bugatti ·
canva · chatgpt · claude · codepen · coinbase · cursor · dribbble · figma ·
glassmorphism · github · google · ibm · linear-app · linkedin · loom · meta ·
microsoft · midjourney · netflix · notion · openai · perplexity · raycast ·
react · spotify · stripe · supabase · tailwind · tencent · tesla · vercel ·
vue · webflow · zoom · ... 
```

**完整 149 个品牌列表**通过 `ls design-systems/` 获得。

---

## 三、合法使用边界

使用 `design-systems/<brand>/DESIGN.md` 生成设计稿时，**允许**：

- ✅ 将该品牌的视觉风格作为审美参考（颜色、字体、间距等设计语言层面）
- ✅ 在内部设计探索 / 学习 / 原型阶段使用
- ✅ 生成"风格类似但内容不同"的设计稿（不混淆产品身份）

**禁止**：

- ❌ 在生成的设计稿中**直接使用该品牌的 Logo / 商标 / 注册标识**（除非已获得授权）
- ❌ 把生成的设计稿以**该品牌名义**对外发布（比如做一个使用 Linear 视觉风格的稿，却挂上 Linear 品牌名说是 Linear 的产品）
- ❌ 用于**仿冒、混淆、欺诈**等违法用途
- ❌ 用于与该品牌存在**直接商业竞争**且可能造成市场混淆的产品

---

## 四、Agent 输出时的硬规则

当 `TASK_ROUTER` 选定某个 `design-systems/<brand>/` 作为本次任务的视觉来源时，**生成的 HTML 必须**：

1. **在 footer 或 HTML 注释中加入一行 attribution**，例如：
   ```html
   <!-- Style inspired by [Brand Name], not affiliated. -->
   ```
   或者在页面 footer 小字区显示：
   ```
   Style inspired by [Brand Name] · Not an official [Brand] product.
   ```

2. **不得在设计稿可见区域使用该品牌的 Logo / 商标**——除非用户明确证明其拥有合法授权

3. **若用户要求生成涉及该品牌的内容时，Agent 必须主动提示**：
   ```
   提醒：你正在使用 [Brand] 的视觉风格做参考，但生成的稿件不是 [Brand]
   官方产品。请勿对外宣称这是 [Brand] 的设计。
   ```

---

## 五、争议处理

如果 [Brand] 的所有者认为本仓库 `design-systems/<brand>/` 的内容存在不当使用或要求移除：

1. 通过 GitHub Issue 或本仓库维护方联系
2. 维护方将在 **7 个工作日内**响应并移除对应内容
3. 不会进行法律对抗——这是个人 / 学习 / 设计参考性质的整理，尊重品牌方的诉求

---

## 六、致谢

本 `design-systems/` 目录的初始内容来源于开源项目 [open-design.ai](https://github.com/OpenCoworkAI/open-codesign)，遵循 MIT 协议。详细 attribution 见 [`../NOTICE.md`](../NOTICE.md)。

---

**版本**：v1.0
**生效日期**：2026-05-18
**维护**：新增品牌时，请检查并更新本声明的「商标归属」清单与「合法使用边界」条款

# Streaming Markdown Reveal（当前事实）

Assistant 正文的流式视觉效果：**逐字 / 逐词浮现**（中日文按字，拉丁文按词）。正文事实源仍是 `ConversationSnapshot.rows`，
渲染入口 `packages/ui/src/v4/ConversationRowView.tsx` → `MessageResponse`
（`packages/ui/src/components/ai-elements/message.tsx`）。

## 唯一硬约束：不生成第二份正文

2026-05 到 2026-07 做过三代实现（`useStreamingTextReveal` → `streaming-markdown-animation`
→ `typewriterController` + `Intl.Segmenter`），全部撤回，其中一代的 auto-follow 修复当天被 revert。
三代栽在同一件事：都维护了一份随时间变长的 `visibleText`。

```
visibleText 逐步变长
   → 元素高度逐帧增长
   → 持续触发 ResizeObserver
   → 撞进虚拟滚动测高补偿与底部跟随裁决
   → 滚动位置被反复改写
另有：snapshot 回填时非前缀变化吞掉开头；切 session 整段重播。
```

所以现在这一代的分界点是：**DOM 里的文本从第一帧就是完整的，只有透明度在变。**

|                    | 历史三代 | 当前       |
| ------------------ | -------- | ---------- |
| DOM 文本           | 逐步变长 | 一次性完整 |
| 元素高度           | 逐帧增长 | 恒定       |
| 虚拟滚动测高       | 持续扰动 | 不参与     |
| copy / 搜索 / 恢复 | 可能半截 | 始终完整   |

`opacity: 0` 不影响 `innerText`（只有 `display:none` / `visibility:hidden` 会），
所以「等完成 → 读全文 → 断言」的 E2E 不受动画影响。

## 为什么不用 Streamdown 内置动画

Streamdown 2.5 的 `animated` + `isAnimating` 会给每个词包 `<span data-sd-animate>`，
但动画规则在 `streamdown/styles.css` 里，本项目从未引入，所以 span 生成了却没有任何规则消费。
补上样式表也不行：完成态走 `static` 时它的 `prevContentLength` 恒为 0，
固定 stagger 40ms 没有封顶，1000 词的末尾要 40 秒后才可见；而且它不能自适应调速。

## 实现

一个 rehype 插件，只在 `streaming === true` 时追加到 `messageRehypePlugins` 末尾。
完成态与历史消息走 `static`，没有插件、没有 span。

### 每条消息一个插件实例，函数名必须唯一

插件是有状态的：每条消息的 `MessageResponse` 用 `useRef` 持有自己的进度和浮现时钟，
插件函数通过闭包读写它。Streamdown 的 unified processor 缓存是模块级的（整个 App 共用一份，
LRU 100 条），key 由 rehype / remark 插件的函数 `name` 拼成，不看函数引用。

Bugfix（2026-11-06）：插件实例原来都叫 `streamingRevealRehypePlugin`。第一条流式消息建好 processor
后，之后每一条流式消息都命中同一个缓存，拿到的是第一条消息的插件实例和它已结束的状态
（`incremental = false`），所有字都被当成 `settled` 直接出现。表现为 App 启动后只有第一条消息
有动画，之后所有轮次、所有会话都没有。现在每个实例用递增序号命名（`streamingRevealRehypePlugin$N`），
与 Streamdown 自带动画插件（`rehypeAnimate$N`）的做法一致。代价是每条流式消息在缓存里多一条
processor，受 LRU 上限约束。这依赖 Streamdown 没有写进文档的缓存规则，**升级 streamdown 时必须重跑 SWR01**，
它的第二轮用例会在实例再次被共用时失败。

### 切分单元

- `Intl.Segmenter` 的 `word` 粒度，模块级缓存实例；无 Segmenter 时回退
  `/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu`。
- 拉丁文按单词。含汉字、平假名、片假名的片段再按码点拆成单字：ICU 词典分词会把
  「拍板」「决策」切成一块，两个字一起出现，没有逐字的打字感。
- 跳过 `pre` / `svg` / `math` 下的文本：代码块的高亮是异步的，逐字会与高亮打架。
  这些文本仍计入偏移，前缀比较与渲染顺序一致。
- 行内 code（不在 `pre` 里的 `code`）整个元素算一个单元：`data-zcode-reveal` 和延迟直接写在
  `<code>` 上，行内 code 渲染器透传属性，底色和文字一起按排期淡入。不能跳过它，否则它一挂载就全亮，
  左边的字还在淡入，看起来是行内 code 先出来。行内公式此时还是 `code.math-inline`，
  随后被 rehype-katex（排在本插件之后）整个替换，只计偏移、不排期。
- 列表圆点和序号是 `li::marker` 伪元素，不是文本节点，包不到 span。插件给新挂载的 `li`
  写 `data-zcode-reveal-marker`，延迟取这个 `li` 第一个单元的排期，圆点和第一个字一起淡入，见下面「CSS」。
- 已知边界：行内 code 还在流式增长时，显示出底色后新增的字直接出现；引用块左边框、表格边框、
  分割线、任务列表复选框随元素挂载直接出现，不参与排期。

### 每个单元都包 span

流式期间 block 内的每个非空白单元都包一个 span，纯空白保留为文本节点：

```html
<span data-zcode-reveal="settled">已</span>
<span data-zcode-reveal="new" style="--zcode-reveal-delay:12.0ms">新</span>
```

不能只包新单元。`hast-util-to-jsx-runtime` 按「标签名 + 同级序号」生成 React key
（`span-0`、`span-1`…）。只包新单元时，下一帧新单元拿到的 `span-0` 正是上一帧旧单元的 DOM 元素，
React 只改文字，新单元不会重新开始淡入。全部包住之后，正文纯追加时旧单元的 span 位置不变、
DOM 保留；新单元出现在末尾，拿到新 key，一定是新挂载的元素。

代价：流式期间整条消息每个单元一个 span，中文按字切分后 span 数约是按词时的两倍。
完成态切到 `static` 后整棵 markdown 重建，span 全部消失。

### 进度按 block 记录

Streamdown 在 `streaming` 模式下按 block 渲染，每个 block 用自己的内容单独跑一遍 rehype，
插件拿到的树只是一个 block。所以进度不能是整条消息的一个长度：

- 插件记下当前 block 的渲染文本（`pending`）。
- 判定已浮现长度：与最近已提交的 block 文本（`committed`，最多 16 条）取最长公共前缀。
  只认旧版本：旧文本在公共前缀之后剩下的尾巴不超过 8 个字符，且尾巴里只有空白和标点。
  同一个 block 的下一版只会改写末尾的空白和标点（尾随空白被裁掉、remend 补全）；
  尾巴里有字词，就是另一段碰巧以相同的词开头，不算进度。
- 提交时用同一条规则删除被覆盖的旧版本，不能只按严格前缀删。
- Bugfix（2026-11-05）：最初只要求「旧文本除末尾 8 个字符外都是当前文本的前缀」。短于 8 个字符的
  旧文本对任何公共前缀都成立：有序列表第一帧 `\n列表项三\n` 被当成无序列表旧条目 `\n列表项一\n`
  的新版本（公共前缀 `\n列表项`），「列表项」三个字和序号不经淡入直接出现；相邻短标题「Step 1」
  「Step 2」同理。这个旧条目本该在无序列表变成 `\n列表项一 revealClock\n` 时删除，但提交时
  只按严格前缀删，尾随换行被改写后删不掉。规则宁严勿宽：误判成「不是旧版本」时，已挂载的单元
  key 不变、不会重播，只多占几个排期位置；误判成「是旧版本」则新单元直接出现。
- 新段落的公共前缀约为 0，从第一个单元开始浮现。
- 判定看单元的开头：开头在进度之前的单元，是上一帧已挂载的同一个元素被延长
  （拉丁文 token 常把一个词拆成几段送达，key 按同级序号不变）。`@starting-style`
  不会对已挂载的元素重播，所以标 `settled`，不占排期位置；延长出的字母跟着它当前的透明度显示。

前面的 block 被 Streamdown 的 memo 冻结，不再跑插件，所以只需要记最近若干条。

### 增量判定（消息级）

- 只有纯追加（`next.startsWith(prev)`）且单帧增量不超过 600 字符才算 live delta。
- 非前缀变化（snapshot 回填、切 session、模型重写）或增量过大（中途挂载、恢复）时，
  整条消息的词都标 `settled`，**不动画**，也绝不按旧进度裁剪正文。
- 文本没变的重渲染（主题等其它 prop 变化）保留上一次判定。
- 已知边界：流式中途重新挂载一条不超过 600 字符的消息（切走再切回）时，判定无法区分
  「新消息的第一帧」与「中途挂载的短消息」，整段会淡入一次。超过 600 字符的不受影响。

### 提交时序

```
MessageResponse render（判定 incremental，读进度）
  → commit → Streamdown effect: startTransition(更新 block 列表)
           → MessageResponse effect: commit 上一次 transition 记下的 pending
  → transition render：尾部 Block 跑插件，读 committed，写 pending
```

render 期间只读进度，提交放在 effect 里。StrictMode 双渲染重复推入的文本在提交时去重。
被打断丢弃的 transition 渲染可能让少数单元不经淡入直接出现，这只影响视觉，不影响正文。

## 节奏：跨帧的浮现时钟

上游 30ms 合并只是把 token 攒成一批，不会让输出变均匀。模型和网络本身是突发的，
合并后更容易成块。所以要有真正的缓冲：一个跨帧的浮现时钟，把突发铺平。

缓冲只体现在每个单元的 `transition-delay` 上。DOM 文本仍然从第一帧起完整，
不用 rAF、不用 timer。

```
状态（跨帧保存，commit 后转正）：
  clock = 最后一个已排定单元的开始时间（performance.now 时间线）
  rate  = 到达速度（单元/ms）的 EWMA；gap = 相邻两批到达间隔的 EWMA
          两批间隔超过 300ms 视为停顿，不更新

本帧新到 count 个单元，now = 排期时刻：
  e         = 1 / rate（还没有参照时按 30ms / count 估）       // 每个单元的到达间隔
  lag       = clamp(max(6 × e, 1.5 × gap), 80, 250)             // 目标滞后：缓冲约 6 个单元
  tail      = max(clock, now)
  available = min(now + 250 − tail, max(now + lag − tail, 15))
  interval  = min(40, available / count)
  start     = max(now, clock + interval)                        // 接在上一批后面
  delay(i)  = start + i × interval − now
  clock     = start + (count − 1) × interval
```

```
到达    ▇▇▇▇▇▇▇▇ ··········空档·········· ▇▇▇▇▇
浮现    需 要 你 拍 板 的 决 策 时 问 你 · 下一批接着出现
        ├──────── 缓冲填满空档，间隔均匀 ────────┤
```

Bugfix：最初 lag 固定 250ms。一个单元是一个汉字或一个英文单词，中文 1 个 token 约 1–1.5 个字，
常见模型每秒 30–60 个单元，快模型超过 100。只要每秒超过 25 个单元，队列就一直顶在 250ms 上限，
再加 300ms 淡入，快模型上字要约 460ms 后才到 90% 不透明，看起来就是渲染跟不上。
现在目标滞后按到达速度缩放，缓冲约 6 个单元，不管多快都跟得紧。

Bugfix：滞后自适应的第一版把淡入时长也一起缩放（`clamp(8 × e, 120, 300)`）。真实模型实测
约每秒 150 个单元（一条约 510 个单元的回复 3.4 秒流完），时长全部压到 120ms 下限：
ease-out 下 30ms 就到 38%、90ms 到 91%，每个字只有 2–3 帧在渐变，肉眼看就是没有动画，
所有模型都受影响。「能不能看出淡入」只取决于单个字有几帧在渐变，和吐字速度无关，
所以淡入时长固定 300ms，只缩放滞后。

排期模拟（30ms 一帧，每帧到达量 ±50% 抖动；可见渐变帧数 = 单个字低于 90% 不透明的帧数）：

| 单元/秒 | 到 90% 不透明 | 同时半透明的单元数 | 可见渐变帧数 |
| ------: | ------------: | -----------------: | -----------: |
|      60 |         318ms |                 20 |            7 |
|     150 |         290ms |                 45 |            7 |
|     300 |         289ms |                 89 |            7 |

对比：滞后固定 250ms 时每秒 150 个单元要 460ms；时长也自适应时是 157ms，但可见渐变只有 2 帧。

- 吐得慢（慢于每 40ms 一个单元）：间隔取上限 40ms，逐字可辨，滞后接近 0。
- 吐得快：目标滞后缩到约 6 个单元的到达时间（最少 80ms）；淡入始终 300ms。
- 队列已经超过目标滞后时，每批至少铺开 15ms，逐步回落，不同时起跳。
- `1.5 × gap` 保证滞后能盖住两批之间的空档：手机 replayable 150ms 一帧时，滞后不会小于帧间隔，
  不会出现「一批放完、停住、下一批」的断续。
- 停顿后紧跟突发：前一批只排到滞后上限之前，后一批仍有时间铺开，不会挤成一块。
  突发按停顿前的速度排期：快模型停顿后的整句会在约 80ms 内铺开，比慢模型紧凑，这是有意的取舍。
- 250ms 硬上限同时封住单帧大批量的累计延迟：Streamdown 内置动画没有封顶，1000 词 × 40ms
  = 末尾 40 秒后才可见。

淡入时长统一取 `:root` 的 `--zcode-reveal-duration`（300ms），不写在单元上；排期只写延迟。

排期时序：

- 同一轮渲染里多个 block 有新单元时，后面的 block 接着前面的排（`pendingSchedules`）。
- 同一个 block 内容在提交前又渲染一次（transition 被打断后重来）时，沿用已排的期，
  否则它会接在自己后面再排一遍，延迟翻倍。
- 提交与进度一起放在 MessageResponse 的 effect 里，见上面的提交时序。

已知代价：

- **回复结束时，还没轮到的尾巴直接出现。** `streaming` 变为 false 后切到 `static` 重建，span 消失。
  尾巴长度等于当时的滞后：慢模型接近 0，快模型约 80ms，最长 250ms。消除它需要让 UI 等动画播完
  再切 static，即用时间同步状态，不采用。
- **排期有少量偏差。** delay 从排期时刻算，transition 从挂载后第一次样式计算算；
  Streamdown 的 block 更新走 `startTransition`，两者之间的耗时不固定。
- 单元在延迟期间会在下一帧变成 `settled`，`--zcode-reveal-delay` 被移除。按 CSS Transitions
  规范，已经创建的 transition（包括延迟阶段）不受之后 delay 变化影响；SWR01 实测验证这一点。
- 如果 E2E 证明延迟中被打断，或节奏抖动肉眼可见，改用 rAF：只写视觉标记，不经过 React state，
  进度按经过的时间计算，后台窗口切回时直接追上。

## CSS

```css
[data-zcode-reveal] {
  transition: opacity var(--zcode-reveal-duration) … var(--zcode-reveal-delay, 0ms);
}
@starting-style {
  [data-zcode-reveal="new"] {
    opacity: 0;
  }
}
[data-zcode-reveal-marker]::marker {
  transition: color var(--zcode-reveal-duration) … var(--zcode-reveal-marker-delay, 0ms);
}
@starting-style {
  [data-zcode-reveal-marker="new"]::marker {
    color: transparent;
  }
}
```

用 transition + `@starting-style`，不用 `@keyframes`：词在下一帧（30ms）就从 `new` 变成
`settled`，keyframes 选择器不再命中时动画会被立即移除，淡入只播一帧。transition 只要
`transition-property` 仍含 opacity 就会跑完；`@starting-style` 只作用于元素首次挂载，
已挂载元素上的 `new` 不会重播。刻意不加 `will-change`：每个单元一个 span，提升合成层反而拖垮长消息。

列表圆点：`::marker` 只支持少数属性，opacity 无效，所以改 color。Electron 44.7（Chrome 152）
探针确认：color 过渡在 `::marker` 上可用，延迟期内改成 `settled` 不取消，能覆盖 Tailwind 分层的
`marker:text-foreground-subtlest`，颜色从透明插值过去、中间不会先变黑。marker 的延迟用单独的
变量名，避免 `li` 上的值被子元素里的词继承；时长与正文共用 `--zcode-reveal-duration`。

历史：2026-06 曾在 `li::marker` 上用 keyframes 做过圆点淡入（`b55e915d387`），重写打字机时
随之删除（`67a2a559136`），之后圆点一直随 `li` 挂载直接出现。

## 动效口径

`DESIGN.md` 的 Motion 要求 fast、low-drama、不装饰。正文、预览卡片、变更摘要、chat loading
的时长与缓动集中在 `:root` 上：

| 变量                      | 值                              | 用途                                       |
| ------------------------- | ------------------------------- | ------------------------------------------ |
| `--zcode-reveal-duration` | 300ms                           | 逐字 / 逐词浮现、列表圆点                  |
| `--zcode-reveal-ease`     | `ease-out`                      | 逐字 / 逐词浮现、列表圆点                  |
| `--zcode-enter-duration`  | 260ms                           | 整块入场（预览卡片、变更摘要、loading 行） |
| `--zcode-enter-ease`      | `cubic-bezier(0.16, 1, 0.3, 1)` | 整块入场                                   |

逐字浮现的时长固定 300ms，不随吐字速度变化；吐字速度只影响起跳延迟（滞后），见「节奏」。

单个单元的淡入能不能被看出来，取决于任一时刻有多少帧的单元还处在渐变中，曲线比时长影响更大。
上游 30ms 一帧时，各组合里低于 90% 不透明的帧数：

| 时长  | `cubic-bezier(0.16, 1, 0.3, 1)` | `ease-out` |
| ----- | ------------------------------- | ---------- |
| 180ms | 2（首帧即 69%）                 | —          |
| 200ms | 2                               | 4          |
| 300ms | 3                               | 7          |

急起曲线首帧就接近全亮，看起来就是直接出现。所以逐字浮现单独用 300ms + `ease-out`；
整块入场是一次性的，保留急起曲线。原先整块入场是 900ms，已收敛到 260ms。
所有动画在 `prefers-reduced-motion: reduce` 下关闭。

## 边界

动画只能是可丢弃的视觉层：不改变 copy、搜索、恢复、虚拟滚动测高或最终 row 内容。
正在流式的那一轮作为 live tail 留在普通文档流（不进 virtualizer），这是动画的唯一作用区；
一旦溢出到已进入虚拟历史的轮次，就会重现 SSV05/SSV06 记录过的「重播淡入」「整片闪空」。

验收用例：`packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-streaming-word-reveal.test.ts`（SWR01）。

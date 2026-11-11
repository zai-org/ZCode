# Conversation Session Decision Workflow Board

目标：把每个尚未 covered 的 case 放到同一张状态板里，追踪 answer draft、decision worksheet、source coverage、roadmap 和下一步动作。

生成命令：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --workflow-board-md
```

## 当前状态

| 指标 | 当前值 |
| --- | ---: |
| Workflow case | 89 |
| Draft-ready case | 0 |
| Worksheet-ready case | 0 |
| Source-backfill-needed case | 0 |
| Roadmap ready-to-write | 35 |
| Roadmap implemented | 18 |

## Next Action Counts

| Next action | Case count |
| --- | ---: |
| 填写 N01.1 | 1 |
| 填写 N02.1 | 1 |
| 填写 N03.1 | 1 |
| 填写 N04.1 | 1 |
| 补齐 | 53 |
| 填写 N06.1 | 1 |
| 填写 N07.1 | 1 |
| 填写 N08.1 | 1 |
| 填写 N09.1 | 1 |
| 填写 S01.1 | 1 |
| 填写 S02.1 | 1 |
| 填写 S03.1 | 1 |
| 填写 S04.1 | 1 |
| 填写 S05.1 | 1 |
| 填写 S06.1 | 1 |
| 填写 S07.1 | 1 |
| 填写 D01.1 | 1 |
| 填写 D02.1 | 1 |
| 填写 D03.1 | 1 |
| 填写 D04.1 | 1 |
| 填写 D05.1 | 1 |
| 填写 L01.1 | 1 |
| 填写 L02.1 | 1 |
| 填写 L03.1 | 1 |
| 填写 L04.1 | 1 |
| 填写 L05.1 | 1 |
| 填写 L06.1 | 1 |
| 填写 L07.1 | 1 |
| 填写 L08.1 | 1 |
| 填写 W01.1 | 1 |
| 填写 W02.1 | 1 |
| 填写 W03.1 | 1 |
| 填写 W04.1 | 1 |
| 填写 W05.1 | 1 |
| 填写 X01.1 | 1 |
| 填写 X02.1 | 1 |
| 填写 X03.1 | 1 |

## Board

| Case | Group | Answer draft | Worksheet | Source coverage | Roadmap | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| N01 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N01.1 |
| N02 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N02.1 |
| N03 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N03.1 |
| N04 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N04.1 |
| N05 | P0-2 模型/API 请求故障 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| N06 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N06.1 |
| N07 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N07.1 |
| N08 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N08.1 |
| N09 | P0-2 模型/API 请求故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 N09.1 |
| S01 | P0-3 SSE 流式故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 S01.1 |
| S02 | P0-3 SSE 流式故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 S02.1 |
| S03 | P0-3 SSE 流式故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 S03.1 |
| S04 | P0-3 SSE 流式故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 S04.1 |
| S05 | P0-3 SSE 流式故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 S05.1 |
| S06 | P0-3 SSE 流式故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 S06.1 |
| S07 | P0-3 SSE 流式故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 S07.1 |
| D01 | P1-1 文件系统/存储故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 D01.1 |
| D02 | P1-1 文件系统/存储故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 D02.1 |
| D03 | P1-1 文件系统/存储故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 D03.1 |
| D04 | P1-1 文件系统/存储故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 D04.1 |
| D05 | P1-1 文件系统/存储故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 D05.1 |
| L01 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L01.1 |
| L02 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L02.1 |
| L03 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L03.1 |
| L04 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L04.1 |
| L05 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L05.1 |
| L06 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L06.1 |
| L07 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L07.1 |
| L08 | P1-2 App 生命周期/进程故障 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 L08.1 |
| W01 | P2-1 Workspace / Tool 外部变化 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 W01.1 |
| W02 | P2-1 Workspace / Tool 外部变化 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 W02.1 |
| W03 | P2-1 Workspace / Tool 外部变化 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 W03.1 |
| W04 | P2-1 Workspace / Tool 外部变化 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 W04.1 |
| W05 | P2-1 Workspace / Tool 外部变化 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 W05.1 |
| X01 | P2-2 跨 Session 故障隔离 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 X01.1 |
| X02 | P2-2 跨 Session 故障隔离 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 X02.1 |
| X03 | P2-2 跨 Session 故障隔离 | placeholder-only | blocked | decision-needed | blocked-by-product-decision | 填写 X03.1 |
| A08 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| A09 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| A10 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| A11 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| A12 | 未分组 | missing | not-in-decision-protocol | missing | ready-to-write | 补齐 |
| B06 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| B07 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| B08 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| B13 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| B14 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| B16 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| C05 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| C08 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| C09 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| D06 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| D11 | 未分组 | missing | not-in-decision-protocol | missing | ready-to-write | 补齐 |
| D18 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| D20 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| D22 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| E06 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| E08 | 未分组 | missing | not-in-decision-protocol | missing | ready-to-write | 补齐 |
| F01 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| F03 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| F07 | 未分组 | missing | not-in-decision-protocol | missing | ready-to-write | 补齐 |
| F09 | 未分组 | missing | not-in-decision-protocol | missing | ready-to-write | 补齐 |
| G11 | 未分组 | missing | not-in-decision-protocol | missing | ready-to-write | 补齐 |
| G12 | 未分组 | missing | not-in-decision-protocol | missing | ready-to-write | 补齐 |
| H08 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| H09 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| H12 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| H15 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| H16 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| I43 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I44 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I45 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I46 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I47 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I48 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I49 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I50 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I51 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I52 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I53 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I54 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I57 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I58 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I59 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I60 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I62 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I63 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |
| I64 | 未分组 | missing | not-in-decision-protocol | partial | implemented | 补齐 |
| I65 | 未分组 | missing | not-in-decision-protocol | planned | ready-to-write | 补齐 |

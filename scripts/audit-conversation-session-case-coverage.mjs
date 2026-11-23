#!/usr/bin/env node
/* eslint-disable max-lines -- 会话 case 审计需要集中维护 catalog、coverage、fault、backlog 与 worksheet 的一致性口径。 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFormalAdmissionAuditIntegration,
  getCoverageAuditExitCode,
} from "./lib/conversation-session-formal-admission-audit.mjs";
import { inspectCoverageMatrices } from "./lib/retired-app-unit-evidence.mjs";
import { inspectConversationSessionFormalAdmission } from "./lib/conversation-session-formal-admission.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveFormalAdmissionRoot() {
  const override =
    process.env.ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT?.trim();
  if (!override) {
    return REPO_ROOT;
  }
  // 修复原因：该 override 只用于 node:test 的真实 CLI 集成测试。若生产进程也能注入，
  // audit 可被指向空目录并静默跳过正式用例；NODE_ENV=test 不是可信测试进程证明。
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      "ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT is test-only and requires NODE_TEST_CONTEXT",
    );
  }
  return resolve(override);
}

// 修复原因：本审计依赖 catalog、coverage matrix 与 roadmap 的即时统计，
// E2E case 转正期间会频繁出现短暂不一致；它必须由显式 audit 命令触发，
// 不能挂在默认 Vitest 单测里阻塞每次提交。
const DOCS = {
  mainCatalog: "docs/conversation-session-case-catalog.md",
  coverageMatrix: "docs/testing/conversation-session-e2e-coverage-matrix.md",
  environmentFaultCatalog:
    "docs/testing/conversation-session-environment-fault-catalog.md",
  faultCoverageMatrix:
    "docs/testing/conversation-session-fault-e2e-coverage-matrix.md",
  decisionBacklog: "docs/testing/conversation-session-decision-backlog.md",
  decisionE2ERoadmap:
    "docs/testing/conversation-session-decision-e2e-roadmap.md",
};

const DECISION_ANSWERS_PATH =
  "docs/testing/conversation-session-decision-answers.md";

const GENERATED_MARKDOWN_DOCS = {
  decisionAnswerTemplate:
    "docs/testing/conversation-session-next-decision-answer-template.md",
  decisionAnswersStatus:
    "docs/testing/conversation-session-decision-answers-status.md",
  decisionBackfillPlan:
    "docs/testing/conversation-session-decision-backfill-plan.md",
  decisionReviewQueue:
    "docs/testing/conversation-session-decision-review-queue.md",
  decisionWorkflowBoard:
    "docs/testing/conversation-session-decision-workflow-board.md",
  nextDecisionReview:
    "docs/testing/conversation-session-next-decision-review.md",
};
const MAIN_AUTOMATION_SPEC_PATH_PREFIXES = [
  "packages/desktop/test/e2e/",
  // 修复原因：App 单测退役后不能继续接纳已删 UI 文件；正文退役说明不会移除机器索引。
  // A12 的自动化缺口记为 missing，保留的 CLI 证据仍按下列明确路径接纳。
  "apps/zcode-cli/packages/core/tests/",
  // 修复原因：普通 retry UI 退役后，K10/K11 的稳定命令门禁证据只保留在
  // bootstrap 原生命令 focused suite；精确放行该文件，避免把其它补充证据误计入 formal E2E。
  "apps/zcode-cli/packages/bootstrap/tests/v4-native-fork-edit-retry.test.ts",
  // 修复原因：I69 验证的是 Agent Gateway raw epoch/gap 控制流，无法由 renderer WDIO
  // 稳定制造；只接纳对应 focused suite，避免把整个 bootstrap tests 目录冒充 E2E 证据。
  "apps/zcode-cli/packages/bootstrap/tests/v4-gateway.test.ts",
];

const DECISION_E2E_ROADMAP_STATUSES = [
  "blocked-by-product-decision",
  "ready-to-write",
  "implemented",
  "ignored",
  "invalid",
];
const COMPACT_FAULT_ALIAS_BY_CASE_ID = {
  F09: "C01",
  G11: "C02",
  G12: "C03",
};
// 修复原因：planned 也是尚未 covered 的 accepted case；如果不进入 roadmap
// 集合，审计会静默漏掉已有候选步骤但尚无独立断言的自动化缺口。
const ROADMAP_SOURCE_STATUSES = [
  "undefined",
  "decision-needed",
  "missing",
  "planned",
  "failing",
  "partial",
  "ignored",
  "invalid",
];

const DECISION_WORKSHEETS = {
  compact: {
    idPattern: /^(?:F09|G11|G12)$/,
    path: "docs/testing/conversation-session-compact-decision-worksheet.md",
  },
  networkSse: {
    idPattern: /^(?:N\d{2}|S\d{2})$/,
    path: "docs/testing/conversation-session-network-sse-decision-worksheet.md",
  },
  recoveryIsolation: {
    idPattern: /^(?:D\d{2}|L\d{2}|W\d{2}|X\d{2})$/,
    path: "docs/testing/conversation-session-recovery-isolation-decision-worksheet.md",
  },
};

// F09/G11/G12 批次已于 2026-07-05 裁决完成并回写（catalog accepted、coverage missing、
// fault alias accepted/missing、roadmap ready-to-write），协议题从审计面退役。
// 结论记录：docs/conversation-product-protocol.md「Pending Product Boundaries」、
// compact decision worksheet 的裁决记录与主 catalog F09/G11/G12/N06 行。
const COMPACT_PROTOCOL_CASE_IDS = [];
const NETWORK_SSE_PROTOCOL_CASE_IDS = [
  // N05 已完成产品裁决并回写 fault catalog；不再占用 decision-needed 协议题。
  ...buildNumberedIds("N", 1, 4),
  ...buildNumberedIds("N", 6, 9),
  ...buildNumberedIds("S", 1, 7),
];
const RECOVERY_ISOLATION_PROTOCOL_CASE_IDS = [
  ...buildNumberedIds("D", 1, 5),
  ...buildNumberedIds("L", 1, 8),
  ...buildNumberedIds("W", 1, 5),
  ...buildNumberedIds("X", 1, 3),
];
const EXPECTED_COMPACT_PROTOCOL_IDS = COMPACT_PROTOCOL_CASE_IDS.flatMap(
  (caseId) => [1, 2, 3, 4].map((index) => `${caseId}.${index}`),
);
const EXPECTED_NETWORK_SSE_PROTOCOL_IDS = buildSingleQuestionIds(
  NETWORK_SSE_PROTOCOL_CASE_IDS,
);
const EXPECTED_RECOVERY_ISOLATION_PROTOCOL_IDS = buildSingleQuestionIds(
  RECOVERY_ISOLATION_PROTOCOL_CASE_IDS,
);
const REVIEW_GROUPS = [
  {
    caseIds: COMPACT_PROTOCOL_CASE_IDS,
    key: "compact",
    label: "P0-1 Compact 故障",
    rank: 1,
    worksheetKey: "compact",
  },
  {
    caseIds: buildNumberedIds("N", 1, 9),
    key: "modelApi",
    label: "P0-2 模型/API 请求故障",
    rank: 2,
    worksheetKey: "networkSse",
  },
  {
    caseIds: buildNumberedIds("S", 1, 7),
    key: "sse",
    label: "P0-3 SSE 流式故障",
    rank: 3,
    worksheetKey: "networkSse",
  },
  {
    caseIds: buildNumberedIds("D", 1, 5),
    key: "filesystem",
    label: "P1-1 文件系统/存储故障",
    rank: 4,
    worksheetKey: "recoveryIsolation",
  },
  {
    caseIds: buildNumberedIds("L", 1, 8),
    key: "lifecycle",
    label: "P1-2 App 生命周期/进程故障",
    rank: 5,
    worksheetKey: "recoveryIsolation",
  },
  {
    caseIds: buildNumberedIds("W", 1, 5),
    key: "workspaceTool",
    label: "P2-1 Workspace / Tool 外部变化",
    rank: 6,
    worksheetKey: "recoveryIsolation",
  },
  {
    caseIds: buildNumberedIds("X", 1, 3),
    key: "crossSession",
    label: "P2-2 跨 Session 故障隔离",
    rank: 7,
    worksheetKey: "recoveryIsolation",
  },
];
const DECISION_PROTOCOLS = {
  compact: {
    caseIds: COMPACT_PROTOCOL_CASE_IDS,
    expectedQuestionIds: EXPECTED_COMPACT_PROTOCOL_IDS,
    statsHeading: "## 当前统计",
    statsLabels: {
      answered: "answered",
      cases: "Compact case",
      questions: "Compact 协议题",
      unanswered: "unanswered",
    },
    worksheetKey: "compact",
  },
  networkSse: {
    caseIds: NETWORK_SSE_PROTOCOL_CASE_IDS,
    expectedQuestionIds: EXPECTED_NETWORK_SSE_PROTOCOL_IDS,
    statsHeading: "## 当前统计",
    statsLabels: {
      answered: "answered",
      cases: "Network/SSE case",
      questions: "Network/SSE 协议题",
      unanswered: "unanswered",
    },
    worksheetKey: "networkSse",
  },
  recoveryIsolation: {
    caseIds: RECOVERY_ISOLATION_PROTOCOL_CASE_IDS,
    expectedQuestionIds: EXPECTED_RECOVERY_ISOLATION_PROTOCOL_IDS,
    statsHeading: "## 当前统计",
    statsLabels: {
      answered: "answered",
      cases: "Recovery/Isolation case",
      questions: "Recovery/Isolation 协议题",
      unanswered: "unanswered",
    },
    worksheetKey: "recoveryIsolation",
  },
};

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const jsonOutput = args.has("--json");
const check = args.has("--check");
const reviewQueueMarkdownOutput = args.has("--review-queue-md");
const reviewNextMarkdownOutput = args.has("--review-next-md");
const answerTemplateMarkdownOutput = args.has("--answer-template-md");
const answersStatusMarkdownOutput = args.has("--answers-status-md");
const backfillPlanMarkdownOutput = args.has("--backfill-plan-md");
const backfillPatchMarkdownOutput = args.has("--backfill-patch-md");
const backfillPlanJsonOutput = args.has("--backfill-json");
const workflowBoardMarkdownOutput = args.has("--workflow-board-md");
const requireComplete = args.has("--require-complete");
const [rawDecisionAnswersPath] = readOptionValues(rawArgs, "--answers-path");
// CI 在审计失败时于 WDIO 前退出、没有 E2E 报告；MR 增量 job 读这份 JSON 判断是否标记 Draft。
const [jsonOutPath] = readOptionValues(rawArgs, "--json-out");
const decisionAnswersPath =
  rawDecisionAnswersPath?.trim() || DECISION_ANSWERS_PATH;
const usesCustomDecisionAnswersPath =
  resolve(REPO_ROOT, decisionAnswersPath) !==
  resolve(REPO_ROOT, DECISION_ANSWERS_PATH);
const requireBackfillClean =
  !usesCustomDecisionAnswersPath || args.has("--require-backfill-clean");
const reviewCaseIds = readOptionValues(rawArgs, "--review-case").flatMap(
  (value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
);
const reviewLimit = readNumberOption(rawArgs, "--review-limit");

function readOptionValues(values, optionName) {
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === optionName) {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        result.push(next);
        index += 1;
      }
      continue;
    }
    if (value.startsWith(`${optionName}=`)) {
      result.push(value.slice(optionName.length + 1));
    }
  }
  return result;
}

function readNumberOption(values, optionName) {
  const [rawValue] = readOptionValues(values, optionName);
  if (!rawValue) {
    return null;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildNumberedIds(prefix, start, end) {
  return Array.from(
    { length: end - start + 1 },
    (_, index) => `${prefix}${String(start + index).padStart(2, "0")}`,
  );
}

function buildSingleQuestionIds(caseIds) {
  return caseIds.map((caseId) => `${caseId}.1`);
}

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownRows(markdown) {
  const rows = [];
  for (const [lineIndex, line] of markdown.split(/\r?\n/).entries()) {
    const cells = splitMarkdownRow(line);
    if (!cells || isSeparatorRow(cells)) {
      continue;
    }
    rows.push({ cells, line: lineIndex + 1, raw: line });
  }
  return rows;
}

function stripInlineCode(value) {
  return value.replace(/`/g, "").trim();
}

function isPendingProductDecision(value) {
  return ["", "TBD", "待产品确认", "待确认"].includes(stripInlineCode(value));
}

function normalizeNumber(value) {
  const normalized = stripInlineCode(value).replace(/,/g, "");
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRowsById(markdown, idPattern) {
  const rows = new Map();
  for (const row of parseMarkdownRows(markdown)) {
    const id = stripInlineCode(row.cells[0] ?? "");
    if (!idPattern.test(id)) {
      continue;
    }
    rows.set(id, { cells: row.cells, id, line: row.line, raw: row.raw });
  }
  return rows;
}

function formatMarkdownPatchCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function formatMarkdownPatchRow(cells) {
  return `| ${cells.map((cell) => formatMarkdownPatchCell(cell)).join(" | ")} |`;
}

function buildMarkdownRowPatch(row, updates) {
  if (!row) {
    return {
      expectedLine: null,
      replacementLine: null,
    };
  }

  const nextCells = [...row.cells];
  for (const [columnIndex, value] of updates) {
    if (columnIndex < 0 || columnIndex >= nextCells.length) {
      continue;
    }
    nextCells[columnIndex] = value;
  }

  return {
    expectedLine: row.raw,
    replacementLine: formatMarkdownPatchRow(nextCells),
  };
}

function parseAutomationSpecs(markdown) {
  const specs = new Map();
  for (const row of parseMarkdownRows(markdown)) {
    const abbreviation = stripInlineCode(row.cells[0] ?? "");
    const specPath = stripInlineCode(row.cells[1] ?? "");
    if (
      !/^[A-Z]{2}$/.test(abbreviation) ||
      !isMainAutomationSpecPath(specPath)
    ) {
      continue;
    }
    specs.set(abbreviation, { abbreviation, line: row.line, path: specPath });
  }
  return specs;
}

function isMainAutomationSpecPath(specPath) {
  // 修复原因：auto compact retry 的稳定证据拆到 core runtime 单测后，
  // 主路径 coverage audit 不能再只承认 desktop E2E 文件。
  return MAIN_AUTOMATION_SPEC_PATH_PREFIXES.some((prefix) =>
    specPath.startsWith(prefix),
  );
}

function parseAutomationCell(value) {
  return stripInlineCode(value)
    .split(/[、,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDecisionAnswerDraft(source) {
  const answers = new Map();
  const duplicates = [];
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:[-*]\s*)?([A-Z]\d{2}\.\d+)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const questionId = match[1];
    const productDecision = stripInlineCode(match[2] ?? "");
    const entry = {
      line: lineIndex + 1,
      productDecision,
      questionId,
    };
    if (answers.has(questionId)) {
      duplicates.push({
        previousLine: answers.get(questionId).line,
        ...entry,
      });
    }
    answers.set(questionId, entry);
  }
  return { answers, duplicates };
}

function summarizeDecisionAnswerDraft(source, questionDetailsByCase) {
  const { answers, duplicates } = parseDecisionAnswerDraft(source);
  const knownQuestionIds = new Set(
    Object.values(questionDetailsByCase).flatMap((questions) =>
      questions.map((question) => question.questionId),
    ),
  );
  const answered = [];
  const pending = [];
  const unknown = [];
  const knownAnswerIds = new Set();
  for (const answer of answers.values()) {
    if (!knownQuestionIds.has(answer.questionId)) {
      unknown.push(answer);
      continue;
    }
    knownAnswerIds.add(answer.questionId);
    if (isPendingProductDecision(answer.productDecision)) {
      pending.push(answer);
    } else {
      answered.push(answer);
    }
  }
  const missingQuestionIds = [...knownQuestionIds]
    .filter((questionId) => !knownAnswerIds.has(questionId))
    .sort((left, right) => left.localeCompare(right));

  return {
    answered: answered.length,
    answeredQuestionIds: answered
      .map((answer) => answer.questionId)
      .sort((left, right) => left.localeCompare(right)),
    answersByQuestionId: Object.fromEntries(
      [...answers.values()]
        .sort((left, right) => left.questionId.localeCompare(right.questionId))
        .map((answer) => [
          answer.questionId,
          {
            line: answer.line,
            productDecision: answer.productDecision,
          },
        ]),
    ),
    duplicateQuestionIds: duplicates
      .map((answer) => answer.questionId)
      .sort((left, right) => left.localeCompare(right)),
    duplicates,
    expectedQuestions: knownQuestionIds.size,
    missingQuestionIds,
    missingQuestions: missingQuestionIds.length,
    pending: pending.length,
    pendingQuestionIds: pending
      .map((answer) => answer.questionId)
      .sort((left, right) => left.localeCompare(right)),
    totalDraftRows: answers.size,
    unknown,
    unknownQuestionIds: unknown
      .map((answer) => answer.questionId)
      .sort((left, right) => left.localeCompare(right)),
  };
}

function buildDecisionAnswerReadiness(reviewQueueCases, decisionAnswerDraft) {
  const answeredQuestionIds = new Set(decisionAnswerDraft.answeredQuestionIds);
  const pendingQuestionIds = new Set(decisionAnswerDraft.pendingQuestionIds);
  const cases = reviewQueueCases.map((item) => {
    const questionIds = item.unansweredQuestions;
    const answered = questionIds.filter((questionId) =>
      answeredQuestionIds.has(questionId),
    );
    const pending = questionIds.filter((questionId) =>
      pendingQuestionIds.has(questionId),
    );
    const missing = questionIds.filter(
      (questionId) =>
        !answeredQuestionIds.has(questionId) &&
        !pendingQuestionIds.has(questionId),
    );
    const status =
      answered.length === questionIds.length
        ? "ready-to-backfill"
        : answered.length > 0
          ? "partial"
          : pending.length > 0
            ? "placeholder-only"
            : "missing";

    return {
      answeredQuestionIds: answered,
      caseId: item.caseId,
      group: item.group,
      missingQuestionIds: missing,
      pendingQuestionIds: pending,
      questionCount: questionIds.length,
      status,
    };
  });

  return {
    cases,
    missingCaseIds: cases
      .filter((item) => item.status === "missing")
      .map((item) => item.caseId),
    missingCases: cases.filter((item) => item.status === "missing").length,
    partialCaseIds: cases
      .filter((item) => item.status === "partial")
      .map((item) => item.caseId),
    partialCases: cases.filter((item) => item.status === "partial").length,
    placeholderOnlyCaseIds: cases
      .filter((item) => item.status === "placeholder-only")
      .map((item) => item.caseId),
    placeholderOnlyCases: cases.filter(
      (item) => item.status === "placeholder-only",
    ).length,
    readyCaseIds: cases
      .filter((item) => item.status === "ready-to-backfill")
      .map((item) => item.caseId),
    readyCases: cases.filter((item) => item.status === "ready-to-backfill")
      .length,
    totalCases: cases.length,
  };
}

function getDecisionWorkflowNextAction(item) {
  if (["missing", "placeholder-only", "partial"].includes(item.answerStatus)) {
    // 缺口 case 可能不在 decision protocol 中，missingQuestions 为空时不要生成带尾空格的聚合 key。
    return item.pendingQuestions.length > 0
      ? `填写 ${item.pendingQuestions.join(", ")}`
      : item.missingQuestions.length > 0
        ? `补齐 ${item.missingQuestions.join(", ")}`
        : "补齐";
  }
  if (
    item.answerStatus === "ready-to-backfill" &&
    item.worksheetStatus !== "ready"
  ) {
    return "回写 decision worksheet";
  }
  if (
    item.worksheetStatus === "ready" &&
    ["undefined", "decision-needed"].includes(item.sourceStatus)
  ) {
    return "回写 catalog / coverage matrix";
  }
  if (
    item.sourceStatus === "missing" &&
    item.roadmapStatus === "ready-to-write"
  ) {
    return `写 E2E：${item.specPath}`;
  }
  if (["failing", "partial"].includes(item.sourceStatus)) {
    return "修实现或补强断言";
  }
  if (["ignored", "invalid"].includes(item.sourceStatus)) {
    return "确认剪枝状态已同步";
  }
  return "检查状态同步";
}

function buildDecisionWorkflowBoard(
  roadmapRows,
  decisionAnswerReadiness,
  readyDecisionCaseIds,
  blockedDecisionCaseIds,
  mainCoverageRows,
  faultCoverageRows,
) {
  const answerReadinessByCase = new Map(
    decisionAnswerReadiness.cases.map((item) => [item.caseId, item]),
  );
  const readyDecisionCaseIdSet = new Set(readyDecisionCaseIds);
  const blockedDecisionCaseIdSet = new Set(blockedDecisionCaseIds);

  const cases = [...roadmapRows.entries()]
    .map(([caseId, row]) => {
      const group = getReviewGroup(caseId);
      const answerReadiness = answerReadinessByCase.get(caseId);
      const sourceStatus =
        getRoadmapSourceStatus(caseId, mainCoverageRows, faultCoverageRows) ||
        "unknown";
      const item = {
        answerStatus: answerReadiness?.status ?? "missing",
        answeredQuestions: answerReadiness?.answeredQuestionIds ?? [],
        caseId,
        group: group.key,
        groupLabel: group.label,
        missingQuestions: answerReadiness?.missingQuestionIds ?? [],
        pendingQuestions: answerReadiness?.pendingQuestionIds ?? [],
        priority: group.rank,
        roadmapStatus: stripInlineCode(row.cells[5] ?? ""),
        sourceStatus,
        specPath: stripInlineCode(row.cells[2] ?? ""),
        worksheetStatus: readyDecisionCaseIdSet.has(caseId)
          ? "ready"
          : blockedDecisionCaseIdSet.has(caseId)
            ? "blocked"
            : "not-in-decision-protocol",
      };
      return {
        ...item,
        nextAction: getDecisionWorkflowNextAction(item),
      };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.caseId.localeCompare(right.caseId);
    });

  // 这里按 Board 明细的业务顺序聚合，避免中文文案字典序变化导致生成文档只因统计表顺序漂移而 stale。
  const nextActionCounts = new Map();
  for (const item of cases) {
    nextActionCounts.set(
      item.nextAction,
      (nextActionCounts.get(item.nextAction) ?? 0) + 1,
    );
  }

  return {
    cases,
    nextActionCounts: Object.fromEntries(nextActionCounts.entries()),
    total: cases.length,
  };
}

function getDecisionBackfillSourceAction(caseId, sourceStatus) {
  if (["undefined", "decision-needed"].includes(sourceStatus)) {
    const aliasId = COMPACT_FAULT_ALIAS_BY_CASE_ID[caseId];
    const source = aliasId
      ? `main catalog / coverage matrix 的 ${caseId} 与 fault alias ${aliasId}`
      : `environment fault catalog / fault coverage matrix 的 ${caseId}`;
    return `把 ${source} 从 ${sourceStatus} 回写为 accepted + missing，进入可写 E2E 状态`;
  }
  if (sourceStatus === "missing") {
    return "source 已经是 missing，直接写 E2E";
  }
  if (["ignored", "invalid"].includes(sourceStatus)) {
    return `source 已是 ${sourceStatus}，确认剪枝理由已同步`;
  }
  if (["failing", "partial"].includes(sourceStatus)) {
    return `source 已是 ${sourceStatus}，优先修实现或补强断言`;
  }
  return `检查 source coverage 状态：${sourceStatus}`;
}

function getDecisionBackfillRoadmapAction(roadmapStatus, sourceStatus) {
  if (
    roadmapStatus === "blocked-by-product-decision" &&
    ["undefined", "decision-needed"].includes(sourceStatus)
  ) {
    return "产品结论回写到 source 后，把 roadmap 状态改为 ready-to-write";
  }
  if (roadmapStatus === "ready-to-write") {
    return "roadmap 已 ready-to-write";
  }
  return `检查 roadmap 状态：${roadmapStatus}`;
}

function buildDecisionWorksheetTargets(item, answersByQuestionId) {
  const worksheetPath = DECISION_WORKSHEETS[item.worksheetKey]?.path ?? "";
  return item.unansweredQuestionDetails.map((question) => ({
    caseId: item.caseId,
    columns: {
      Status: "answered",
      产品结论: answersByQuestionId[question.questionId]?.productDecision ?? "",
    },
    path: worksheetPath,
    questionId: question.questionId,
    rowKind: "decision-protocol-question",
  }));
}

function enrichWorksheetTarget(target, worksheetQuestionRows) {
  const row = worksheetQuestionRows.get(target.questionId);
  const patch = buildMarkdownRowPatch(row, [
    [2, target.columns.Status],
    [3, target.columns.产品结论],
  ]);
  return {
    ...target,
    current: {
      Status: stripInlineCode(row?.cells[2] ?? ""),
      产品结论: stripInlineCode(row?.cells[3] ?? ""),
    },
    expectedLine: patch.expectedLine,
    line: row?.line ?? null,
    replacementLine: patch.replacementLine,
  };
}

function enrichCaseTarget(target, rowMap, columnIndex) {
  const row = rowMap.get(target.caseId);
  const effectiveColumnIndex =
    columnIndex === "last" ? (row?.cells.length ?? 1) - 1 : columnIndex;
  const patch = buildMarkdownRowPatch(row, [[effectiveColumnIndex, target.to]]);
  return {
    ...target,
    current: stripInlineCode(row?.cells[effectiveColumnIndex] ?? ""),
    expectedLine: patch.expectedLine,
    line: row?.line ?? null,
    replacementLine: patch.replacementLine,
  };
}

function enrichE2ETarget(target) {
  if (!target) {
    return null;
  }
  return {
    ...target,
    current: null,
    line: null,
  };
}

function toPatchReplacement(target) {
  if (
    !target?.path ||
    !target.expectedLine ||
    !target.replacementLine ||
    !target.line
  ) {
    return null;
  }
  return {
    caseId: target.caseId,
    expectedLine: target.expectedLine,
    line: target.line,
    path: target.path,
    questionId: target.questionId,
    replacementLine: target.replacementLine,
    rowKind: target.rowKind,
    sourceCaseId: target.sourceCaseId,
  };
}

function toPatchCreateOrUpdate(target) {
  if (!target?.path || target.action !== "create-or-update") {
    return null;
  }
  return {
    action: target.action,
    caseId: target.caseId,
    path: target.path,
    rowKind: target.rowKind,
  };
}

function buildBackfillPatchPlan(readyCases) {
  const filesByPath = new Map();
  let replaceLineCount = 0;
  let createOrUpdateCount = 0;

  const ensureFile = (path) => {
    if (!filesByPath.has(path)) {
      filesByPath.set(path, {
        createOrUpdate: [],
        path,
        replacements: [],
      });
    }
    return filesByPath.get(path);
  };

  for (const item of readyCases) {
    const replaceTargets = [
      ...item.worksheetTargets,
      ...item.sourceTargets,
      ...(item.roadmapTarget ? [item.roadmapTarget] : []),
    ];
    for (const target of replaceTargets) {
      const replacement = toPatchReplacement(target);
      if (!replacement) {
        continue;
      }
      ensureFile(replacement.path).replacements.push(replacement);
      replaceLineCount += 1;
    }

    const createOrUpdate = toPatchCreateOrUpdate(item.e2eTarget);
    if (createOrUpdate) {
      ensureFile(createOrUpdate.path).createOrUpdate.push(createOrUpdate);
      createOrUpdateCount += 1;
    }
  }

  return {
    createOrUpdateCount,
    files: [...filesByPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    replaceLineCount,
  };
}

function buildDecisionSourceTargets(caseId, sourceStatus, targetRows) {
  if (!["undefined", "decision-needed"].includes(sourceStatus)) {
    return [];
  }

  const aliasId = COMPACT_FAULT_ALIAS_BY_CASE_ID[caseId];
  if (aliasId) {
    return [
      enrichCaseTarget(
        {
          caseId,
          column: "Review",
          from: "undefined",
          path: DOCS.mainCatalog,
          rowKind: "main-catalog-case",
          to: "accepted",
        },
        targetRows.mainCaseRows,
        5,
      ),
      enrichCaseTarget(
        {
          caseId,
          column: "覆盖状态",
          from: "undefined",
          path: DOCS.coverageMatrix,
          rowKind: "main-coverage-case",
          to: "missing",
        },
        targetRows.mainCoverageRows,
        1,
      ),
      enrichCaseTarget(
        {
          caseId: aliasId,
          column: "Review",
          from: "decision-needed",
          path: DOCS.environmentFaultCatalog,
          rowKind: "fault-catalog-alias",
          sourceCaseId: caseId,
          to: "accepted",
        },
        targetRows.environmentProductRows,
        "last",
      ),
      enrichCaseTarget(
        {
          caseId: aliasId,
          column: "覆盖状态",
          from: "decision-needed",
          path: DOCS.faultCoverageMatrix,
          rowKind: "fault-coverage-alias",
          sourceCaseId: caseId,
          to: "missing",
        },
        targetRows.faultCoverageRows,
        1,
      ),
    ];
  }

  return [
    enrichCaseTarget(
      {
        caseId,
        column: "Review",
        from: "decision-needed",
        path: DOCS.environmentFaultCatalog,
        rowKind: "fault-catalog-case",
        to: "accepted",
      },
      targetRows.environmentProductRows,
      "last",
    ),
    enrichCaseTarget(
      {
        caseId,
        column: "覆盖状态",
        from: "decision-needed",
        path: DOCS.faultCoverageMatrix,
        rowKind: "fault-coverage-case",
        to: "missing",
      },
      targetRows.faultCoverageRows,
      1,
    ),
  ];
}

function buildDecisionRoadmapTarget(
  caseId,
  roadmapStatus,
  sourceStatus,
  targetRows,
) {
  if (
    roadmapStatus !== "blocked-by-product-decision" ||
    !["undefined", "decision-needed"].includes(sourceStatus)
  ) {
    return null;
  }
  return enrichCaseTarget(
    {
      caseId,
      column: "状态",
      from: roadmapStatus,
      path: DOCS.decisionE2ERoadmap,
      rowKind: "decision-e2e-roadmap-case",
      to: "ready-to-write",
    },
    targetRows.decisionE2ERoadmapRows,
    5,
  );
}

function buildDecisionE2ETarget(caseId, specPath) {
  if (!specPath) {
    return null;
  }
  return {
    action: "create-or-update",
    caseId,
    path: specPath,
    rowKind: "e2e-spec",
  };
}

function buildDecisionBackfillPlan(summary, targetRows) {
  const answersByQuestionId = summary.decisionAnswerDraft.answersByQuestionId;
  const workflowItemsByCase = new Map(
    summary.decisionWorkflowBoard.cases.map((item) => [item.caseId, item]),
  );
  const readyCaseIds = new Set(summary.decisionAnswerReadiness.readyCaseIds);
  const readyCases = summary.decisionReviewQueue.cases
    .filter((item) => readyCaseIds.has(item.caseId))
    .map((item) => {
      const workflowItem = workflowItemsByCase.get(item.caseId);
      const sourceStatus = workflowItem?.sourceStatus ?? "unknown";
      const roadmapStatus = workflowItem?.roadmapStatus ?? "unknown";
      const specPath = workflowItem?.specPath ?? "";
      const worksheetTargets = buildDecisionWorksheetTargets(
        item,
        answersByQuestionId,
      ).map((target) =>
        enrichWorksheetTarget(target, targetRows.worksheetQuestionRows),
      );
      const sourceTargets = buildDecisionSourceTargets(
        item.caseId,
        sourceStatus,
        targetRows,
      );
      const roadmapTarget = buildDecisionRoadmapTarget(
        item.caseId,
        roadmapStatus,
        sourceStatus,
        targetRows,
      );
      const e2eTarget = enrichE2ETarget(
        buildDecisionE2ETarget(item.caseId, specPath),
      );
      return {
        actions: [
          {
            action: `将 ${item.unansweredQuestions.join(", ")} 的 Status 改为 answered，并把本 case 产品结论写入 产品结论 列`,
            step: 1,
            target: "decision worksheet",
            targets: worksheetTargets,
          },
          {
            action: getDecisionBackfillSourceAction(item.caseId, sourceStatus),
            step: 2,
            target: "source coverage",
            targets: sourceTargets,
          },
          {
            action: getDecisionBackfillRoadmapAction(
              roadmapStatus,
              sourceStatus,
            ),
            step: 3,
            target: "decision E2E roadmap",
            targets: roadmapTarget ? [roadmapTarget] : [],
          },
          {
            action: specPath ? `写入或更新 ${specPath}` : "补充建议 spec 路径",
            step: 4,
            target: "E2E spec",
            targets: e2eTarget ? [e2eTarget] : [],
          },
        ],
        caseId: item.caseId,
        e2eTarget,
        group: item.group,
        groupLabel: item.groupLabel,
        questions: item.unansweredQuestionDetails.map((question) => ({
          backfillTarget: question.backfillTarget,
          productDecision:
            answersByQuestionId[question.questionId]?.productDecision ?? "",
          questionId: question.questionId,
          reviewPrompt: question.reviewPrompt,
        })),
        roadmapTarget,
        roadmapStatus,
        sourceTargets,
        sourceStatus,
        specPath,
        worksheetTargets,
        worksheetKey: item.worksheetKey,
      };
    });
  const incompleteCases = summary.decisionAnswerReadiness.cases
    .filter((item) => ["partial", "placeholder-only"].includes(item.status))
    .map((item) => ({
      answered: item.answeredQuestionIds.length,
      caseId: item.caseId,
      missing: item.missingQuestionIds.length,
      missingQuestionIds: item.missingQuestionIds,
      nextAction:
        item.pendingQuestionIds.length > 0
          ? `填写 ${item.pendingQuestionIds.join(", ")}`
          : `补充 ${item.missingQuestionIds.join(", ")}`,
      pending: item.pendingQuestionIds.length,
      pendingQuestionIds: item.pendingQuestionIds,
      questionCount: item.questionCount,
      status: item.status,
    }));

  return {
    answersPath: summary.decisionAnswerDraft.sourcePath,
    incompleteCases,
    missingCaseIds: summary.decisionAnswerReadiness.missingCaseIds,
    patchPlan: buildBackfillPatchPlan(readyCases),
    readyCases,
    stats: {
      answeredQuestions: summary.decisionAnswerDraft.answered,
      missingCases: summary.decisionAnswerReadiness.missingCases,
      missingQuestionRows: summary.decisionAnswerDraft.missingQuestions,
      partialCases: summary.decisionAnswerReadiness.partialCases,
      pendingPlaceholders: summary.decisionAnswerDraft.pending,
      placeholderOnlyCases:
        summary.decisionAnswerReadiness.placeholderOnlyCases,
      readyToBackfillCases: readyCases.length,
    },
  };
}

function formatDecisionBackfillTargetRow(target) {
  const sourceLabel = target.sourceCaseId
    ? ` (source ${target.sourceCaseId})`
    : "";
  return `${target.questionId ?? target.caseId ?? "unknown"} / ${target.rowKind ?? "unknown"}${sourceLabel}`;
}

function formatDecisionBackfillTargetMutation(target) {
  if (target.columns) {
    return Object.entries(target.columns)
      .map(([column, value]) => `${column}=${value}`)
      .join("; ");
  }
  if (target.column) {
    return `${target.column}: ${target.from ?? ""} -> ${target.to ?? ""}`;
  }
  if (target.action) {
    return target.action;
  }
  return "检查 target";
}

function formatDecisionBackfillTargetCurrent(target) {
  if (target.current === null || target.current === undefined) {
    return "";
  }
  if (typeof target.current === "object") {
    return Object.entries(target.current)
      .map(([column, value]) => `${column}=${value}`)
      .join("; ");
  }
  return String(target.current);
}

function parseStatsTableAfterHeading(markdown, heading) {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex < 0) {
    return new Map();
  }

  const rest = markdown.slice(headingIndex + heading.length);
  const nextHeadingIndex = rest.search(/\n##\s+/);
  const section =
    nextHeadingIndex >= 0 ? rest.slice(0, nextHeadingIndex) : rest;
  const stats = new Map();

  for (const row of parseMarkdownRows(section)) {
    if (
      row.cells.length < 2 ||
      row.cells[0] === "范围" ||
      row.cells[0] === "指标"
    ) {
      continue;
    }
    const value = normalizeNumber(row.cells[1]);
    if (value !== null) {
      stats.set(stripInlineCode(row.cells[0]), value);
    }
  }

  return stats;
}

function countBy(rows, cellIndex) {
  const counts = new Map();
  for (const row of rows.values()) {
    const value = stripInlineCode(row.cells[cellIndex] ?? "");
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function countByLastCell(rows) {
  const counts = new Map();
  for (const row of rows.values()) {
    const value = stripInlineCode(row.cells.at(-1) ?? "");
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function sortedIds(rows) {
  return [...rows.keys()].sort((left, right) => left.localeCompare(right));
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function diffIds(left, right) {
  const rightSet = new Set(right);
  return left.filter((id) => !rightSet.has(id));
}

function getCount(counts, key) {
  return counts.get(key) ?? 0;
}

function getReviewGroup(caseId) {
  return (
    REVIEW_GROUPS.find((group) => group.caseIds.includes(caseId)) ?? {
      caseIds: [],
      key: "unknown",
      label: "未分组",
      rank: Number.MAX_SAFE_INTEGER,
      worksheetKey: "unknown",
    }
  );
}

function getRoadmapSourceStatus(caseId, mainCoverageRows, faultCoverageRows) {
  const faultAliasId = COMPACT_FAULT_ALIAS_BY_CASE_ID[caseId];
  const faultStatus = faultAliasId
    ? stripInlineCode(faultCoverageRows.get(faultAliasId)?.cells[1] ?? "")
    : stripInlineCode(faultCoverageRows.get(caseId)?.cells[1] ?? "");
  const mainStatus = stripInlineCode(
    mainCoverageRows.get(caseId)?.cells[1] ?? "",
  );

  return faultStatus || mainStatus;
}

function getExpectedRoadmapCaseIds(mainCoverageRows, faultCoverageRows) {
  const mainIds = sortedIds(mainCoverageRows).filter((id) =>
    ROADMAP_SOURCE_STATUSES.includes(
      stripInlineCode(mainCoverageRows.get(id)?.cells[1] ?? ""),
    ),
  );
  const faultIds = sortedIds(faultCoverageRows)
    .filter((id) =>
      ROADMAP_SOURCE_STATUSES.includes(
        stripInlineCode(faultCoverageRows.get(id)?.cells[1] ?? ""),
      ),
    )
    .map((id) => {
      const compactSource = Object.entries(COMPACT_FAULT_ALIAS_BY_CASE_ID).find(
        ([, aliasId]) => aliasId === id,
      )?.[0];
      return compactSource ?? id;
    });

  return sortedUnique([...mainIds, ...faultIds]);
}

function isRoadmapStatusAlignedWithCoverage(status, sourceStatus) {
  if (["undefined", "decision-needed"].includes(sourceStatus)) {
    return status === "blocked-by-product-decision";
  }
  if (["missing", "planned"].includes(sourceStatus)) {
    return status === "ready-to-write";
  }
  if (["failing", "partial"].includes(sourceStatus)) {
    return status === "implemented";
  }
  if (sourceStatus === "ignored") {
    return status === "ignored";
  }
  if (sourceStatus === "invalid") {
    return status === "invalid";
  }
  return false;
}

function buildDecisionReviewQueue(
  blockedCaseIds,
  unansweredQuestionsByCase,
  questionDetailsByCase,
) {
  return blockedCaseIds
    .map((caseId) => {
      const group = getReviewGroup(caseId);
      const unansweredQuestions = unansweredQuestionsByCase[caseId] ?? [];
      const questionDetails = questionDetailsByCase[caseId] ?? [];
      return {
        caseId,
        group: group.key,
        groupLabel: group.label,
        priority: group.rank,
        unansweredQuestionDetails: unansweredQuestions.map(
          (questionId) =>
            questionDetails.find(
              (question) => question.questionId === questionId,
            ) ?? { questionId },
        ),
        unansweredQuestionCount: unansweredQuestions.length,
        unansweredQuestions,
        worksheetKey: group.worksheetKey,
      };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      if (left.unansweredQuestionCount !== right.unansweredQuestionCount) {
        return left.unansweredQuestionCount - right.unansweredQuestionCount;
      }
      return left.caseId.localeCompare(right.caseId);
    });
}

function escapeMarkdownTableCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function getDecisionReviewQueueScope(summary, errors) {
  if (reviewCaseIds.length > 0) {
    const knownItems = new Map(
      summary.decisionReviewQueue.cases.map((item) => [item.caseId, item]),
    );
    const unknownCaseIds = reviewCaseIds.filter(
      (caseId) => !knownItems.has(caseId),
    );
    if (unknownCaseIds.length > 0) {
      errors.push(
        `review queue requested unknown or non-blocked case(s): ${unknownCaseIds.join(", ")}`,
      );
    }
    return {
      command: `node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md --review-case ${reviewCaseIds.join(",")}`,
      description: `指定 case：${reviewCaseIds.join(", ")}`,
      items: reviewCaseIds
        .map((caseId) => knownItems.get(caseId))
        .filter(Boolean),
      title: "Conversation Session Focused Decision Review",
    };
  }

  if (reviewNextMarkdownOutput) {
    return {
      command:
        "node scripts/audit-conversation-session-case-coverage.mjs --check --review-next-md",
      description: `下一批 review：${summary.decisionReviewQueue.nextCaseIds.join(", ") || "none"}`,
      items: summary.decisionReviewQueue.nextCases,
      title: "Conversation Session Next Decision Review",
    };
  }

  if (reviewLimit !== null) {
    return {
      command: `node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md --review-limit ${reviewLimit}`,
      description: `按队列顺序前 ${reviewLimit} 个 case`,
      items: summary.decisionReviewQueue.cases.slice(0, reviewLimit),
      title: "Conversation Session Limited Decision Review",
    };
  }

  return {
    command:
      "node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md",
    description: "全部待产品决策 case",
    items: summary.decisionReviewQueue.cases,
    title: "Conversation Session Decision Review Queue",
  };
}

function getFullDecisionReviewQueueScope(summary) {
  return {
    command:
      "node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md",
    description: "全部待产品决策 case",
    items: summary.decisionReviewQueue.cases,
    title: "Conversation Session Decision Review Queue",
  };
}

function getNextDecisionReviewQueueScope(summary) {
  return {
    command:
      "node scripts/audit-conversation-session-case-coverage.mjs --check --review-next-md",
    description: `下一批 review：${summary.decisionReviewQueue.nextCaseIds.join(", ") || "none"}`,
    items: summary.decisionReviewQueue.nextCases,
    title: "Conversation Session Next Decision Review",
  };
}

function getDefaultDecisionAnswerTemplateScope(summary) {
  return {
    command:
      "node scripts/audit-conversation-session-case-coverage.mjs --check --answer-template-md",
    description: `下一批 review：${summary.decisionReviewQueue.nextCaseIds.join(", ") || "none"}`,
    items: summary.decisionReviewQueue.nextCases,
    title: "Conversation Session Decision Answer Template",
  };
}

function getDecisionAnswerTemplateScope(summary, errors) {
  if (reviewCaseIds.length > 0 || reviewLimit !== null) {
    const reviewScope = getDecisionReviewQueueScope(summary, errors);
    return {
      ...reviewScope,
      command: reviewScope.command.replace(
        "--review-queue-md",
        "--answer-template-md",
      ),
      title: "Conversation Session Decision Answer Template",
    };
  }

  return {
    ...getDefaultDecisionAnswerTemplateScope(summary),
  };
}

function renderDecisionReviewQueueMarkdown(summary, scope) {
  const lines = [
    `# ${scope.title}`,
    "",
    "目标：把当前仍待产品决策的会话区 case 按固定顺序展开，产品确认后再回写 catalog、coverage matrix 和 E2E。",
    "",
    "生成命令：",
    "",
    "```bash",
    scope.command,
    "```",
    "",
    "## 当前状态",
    "",
    "| 指标 | 当前值 |",
    "| --- | ---: |",
    `| Product case 总数 | ${summary.uniqueProduct.total} |`,
    `| 已覆盖 | ${summary.uniqueProduct.covered} |`,
    `| 待产品决策 / 自动化 | ${summary.uniqueProduct.decisionNeeded} |`,
    `| 协议题总数 | ${summary.decisionProtocols.questions} |`,
    `| 协议题 unanswered | ${summary.decisionProtocols.unanswered} |`,
    `| Ready case | ${summary.decisionReadiness.readyCases} |`,
    `| Blocked case | ${summary.decisionReadiness.blockedCases} |`,
    `| 下一批 review | ${summary.decisionReviewQueue.nextCaseIds.join(", ") || "none"} |`,
    `| 当前输出范围 | ${scope.description} |`,
    `| 当前输出 case | ${scope.items.length} |`,
    "",
    "## 使用方式",
    "",
    "1. 按本文件顺序 review case。",
    "2. 对每个 `Question` 写下明确产品结论。",
    "3. 回到对应 decision worksheet，把 `产品结论` 从 `待确认` 改成明确结论，并把 `Status` 改成 `answered`。",
    "4. 按 `回写目标` 更新源 catalog / fault catalog / coverage matrix。",
    "5. 产品语义明确后，再写对应 E2E，最后运行 `pnpm audit:conversation-session-coverage`。",
    "",
    "## Review Queue",
  ];

  let previousGroup = null;
  for (const item of scope.items) {
    if (item.group !== previousGroup) {
      lines.push("", `### ${item.groupLabel}`);
      previousGroup = item.group;
    }

    lines.push(
      "",
      `#### ${item.caseId}`,
      "",
      `- worksheet: \`${item.worksheetKey}\``,
      `- unanswered questions: ${item.unansweredQuestionCount}`,
      "",
      "| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |",
      "| --- | --- | --- | --- |",
    );

    for (const question of item.unansweredQuestionDetails) {
      lines.push(
        `| ${escapeMarkdownTableCell(question.questionId)} | ${escapeMarkdownTableCell(question.reviewPrompt)} | ${escapeMarkdownTableCell(question.candidateAnswer)} | ${escapeMarkdownTableCell(question.backfillTarget)} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderDecisionAnswerTemplateMarkdown(summary, scope) {
  const lines = [
    `# ${scope.title}`,
    "",
    "目标：给产品确认使用的可填写模板。回复时保留 `Case` 和 `Question` 编号，我会按编号回写 worksheet、catalog、coverage matrix，再进入 E2E。",
    "",
    "生成命令：",
    "",
    "```bash",
    scope.command,
    "```",
    "",
    "## 当前状态",
    "",
    "| 指标 | 当前值 |",
    "| --- | ---: |",
    `| Product case 总数 | ${summary.uniqueProduct.total} |`,
    `| 已覆盖 | ${summary.uniqueProduct.covered} |`,
    `| 待产品决策 / 自动化 | ${summary.uniqueProduct.decisionNeeded} |`,
    `| 当前模板范围 | ${scope.description} |`,
    `| 当前模板 case | ${scope.items.length} |`,
    "",
    "## 填写规则",
    "",
    "1. 每个 `Question` 都要给明确产品结论；不要继续写 `待确认`。",
    "2. 如果选候选答案之外的方案，写在 `补充` 里。",
    "3. 结论要能转成 UI / network / runtime / file 的稳定断言。",
    "4. 如果某个问题要剪枝，写清楚“不需要覆盖”的原因。",
    "",
    "## Answer Template",
  ];

  for (const item of scope.items) {
    lines.push(
      "",
      `### ${item.caseId}`,
      "",
      `- worksheet: \`${item.worksheetKey}\``,
    );

    for (const question of item.unansweredQuestionDetails) {
      lines.push(
        "",
        `#### ${question.questionId}`,
        "",
        `- 需要确认：${question.reviewPrompt}`,
        `- 候选答案/验证关键词：${question.candidateAnswer}`,
        `- 回写目标：${question.backfillTarget}`,
        "- 产品结论：",
        "- 补充：",
      );
    }
  }

  lines.push("", "## 可直接回复的精简格式", "", "```text");

  for (const item of scope.items) {
    lines.push(`${item.caseId}:`);
    for (const question of item.unansweredQuestionDetails) {
      lines.push(`- ${question.questionId} = `);
    }
    lines.push("");
  }

  lines.push("```");

  return `${lines.join("\n")}\n`;
}

function renderDecisionAnswersStatusMarkdown(summary) {
  const lines = [
    "# Conversation Session Decision Answers Status",
    "",
    "目标：检查产品答案草稿是否已经足够回写。这里的 ready 只代表 answers 草稿已填齐，不代表 catalog/coverage 已完成回写。",
    "",
    "生成命令：",
    "",
    "```bash",
    "node scripts/audit-conversation-session-case-coverage.mjs --check --answers-status-md",
    "```",
    "",
    "## 当前状态",
    "",
    "| 指标 | 当前值 |",
    "| --- | ---: |",
    `| Expected questions | ${summary.decisionAnswerDraft.expectedQuestions} |`,
    `| Draft rows | ${summary.decisionAnswerDraft.totalDraftRows} |`,
    `| Answered questions | ${summary.decisionAnswerDraft.answered} |`,
    `| Pending placeholders | ${summary.decisionAnswerDraft.pending} |`,
    `| Missing question rows | ${summary.decisionAnswerDraft.missingQuestions} |`,
    `| Unknown questions | ${summary.decisionAnswerDraft.unknownQuestionIds.length} |`,
    `| Duplicate questions | ${summary.decisionAnswerDraft.duplicateQuestionIds.length} |`,
    `| Ready-to-backfill cases | ${summary.decisionAnswerReadiness.readyCases} |`,
    `| Placeholder-only cases | ${summary.decisionAnswerReadiness.placeholderOnlyCases} |`,
    `| Partial cases | ${summary.decisionAnswerReadiness.partialCases} |`,
    `| Missing cases | ${summary.decisionAnswerReadiness.missingCases} |`,
    "",
    "## Case Status",
    "",
    "| Case | Status | Answered | Pending placeholder | Missing |",
    "| --- | --- | ---: | ---: | ---: |",
  ];

  for (const item of summary.decisionAnswerReadiness.cases) {
    lines.push(
      `| ${item.caseId} | ${item.status} | ${item.answeredQuestionIds.length}/${item.questionCount} | ${item.pendingQuestionIds.length} | ${item.missingQuestionIds.length} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderDecisionBackfillPlanMarkdown(summary) {
  const plan = summary.decisionBackfillPlan;

  const lines = [
    "# Conversation Session Decision Backfill Plan",
    "",
    "目标：把 answers 草稿中已经填齐的产品结论转换成回写清单。这里不自动修改 catalog/coverage，只列出下一步该回写的事实。",
    "",
    `answers 输入：\`${summary.decisionAnswerDraft.sourcePath}\``,
    "",
    "生成命令：",
    "",
    "```bash",
    "node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-plan-md",
    "```",
    "",
    "## 当前状态",
    "",
    "| 指标 | 当前值 |",
    "| --- | ---: |",
    `| Answered questions | ${plan.stats.answeredQuestions} |`,
    `| Pending placeholders | ${plan.stats.pendingPlaceholders} |`,
    `| Missing question rows | ${plan.stats.missingQuestionRows} |`,
    `| Ready-to-backfill cases | ${plan.stats.readyToBackfillCases} |`,
    `| Placeholder-only cases | ${plan.stats.placeholderOnlyCases} |`,
    `| Partial cases | ${plan.stats.partialCases} |`,
    `| Missing cases | ${plan.stats.missingCases} |`,
    "",
    "## Ready To Backfill",
    "",
  ];

  if (plan.readyCases.length === 0) {
    lines.push(
      "No ready-to-backfill cases yet. Fill all questions for a case in `conversation-session-decision-answers.md` first.",
    );
  }

  for (const item of plan.readyCases) {
    lines.push(
      "",
      `### ${item.caseId}`,
      "",
      `- worksheet: \`${item.worksheetKey}\``,
      "",
      "| Step | Target | Action |",
      "| ---: | --- | --- |",
    );

    for (const action of item.actions) {
      const actionText =
        action.target === "E2E spec" && item.specPath
          ? `写入或更新 \`${escapeMarkdownTableCell(item.specPath)}\``
          : escapeMarkdownTableCell(action.action);
      lines.push(`| ${action.step} | ${action.target} | ${actionText} |`);
    }

    lines.push(
      "",
      "| Question | 产品结论 | 需要确认 | 回写目标 |",
      "| --- | --- | --- | --- |",
    );

    for (const question of item.questions) {
      lines.push(
        `| ${escapeMarkdownTableCell(question.questionId)} | ${escapeMarkdownTableCell(question.productDecision)} | ${escapeMarkdownTableCell(question.reviewPrompt)} | ${escapeMarkdownTableCell(question.backfillTarget)} |`,
      );
    }

    lines.push(
      "",
      "#### Backfill Targets",
      "",
      "| Step | Path | Line | Row | Current | Mutation |",
      "| ---: | --- | ---: | --- | --- | --- |",
    );

    for (const action of item.actions) {
      if (action.targets.length === 0) {
        lines.push(
          `| ${action.step} |  |  | ${action.target} |  | ${escapeMarkdownTableCell(action.action)} |`,
        );
        continue;
      }
      for (const target of action.targets) {
        lines.push(
          `| ${action.step} | ${escapeMarkdownTableCell(target.path ?? "")} | ${target.line ?? ""} | ${escapeMarkdownTableCell(formatDecisionBackfillTargetRow(target))} | ${escapeMarkdownTableCell(formatDecisionBackfillTargetCurrent(target))} | ${escapeMarkdownTableCell(formatDecisionBackfillTargetMutation(target))} |`,
        );
      }
    }
  }

  lines.push(
    "",
    "## Incomplete Cases",
    "",
    "| Case | Status | Answered | Pending placeholder | Missing | Next action |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  );

  for (const item of plan.incompleteCases) {
    lines.push(
      `| ${item.caseId} | ${item.status} | ${item.answered}/${item.questionCount} | ${item.pending} | ${item.missing} | ${escapeMarkdownTableCell(item.nextAction)} |`,
    );
  }

  lines.push(
    "",
    "## Missing Cases",
    "",
    plan.missingCaseIds.join(", ") || "none",
  );

  return `${lines.join("\n")}\n`;
}

function renderDecisionBackfillPatchMarkdown(summary) {
  const plan = summary.decisionBackfillPlan;
  const patchPlan = plan.patchPlan;
  const lines = [
    "# Conversation Session Decision Backfill Patch Preview",
    "",
    "目标：把 ready-to-backfill case 的回写动作按文件聚合成行级 patch 预览。这里不自动修改文件。",
    "",
    `answers 输入：\`${summary.decisionAnswerDraft.sourcePath}\``,
    "",
    "生成命令：",
    "",
    "```bash",
    "node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-patch-md",
    "```",
    "",
    "## 当前状态",
    "",
    "| 指标 | 当前值 |",
    "| --- | ---: |",
    `| Ready-to-backfill cases | ${plan.stats.readyToBackfillCases} |`,
    `| Patch files | ${patchPlan.files.length} |`,
    `| Replace lines | ${patchPlan.replaceLineCount} |`,
    `| Create/update specs | ${patchPlan.createOrUpdateCount} |`,
    "",
    "## Patch Files",
    "",
  ];

  if (patchPlan.files.length === 0) {
    lines.push(
      "No patch preview yet. Fill all questions for a case in `conversation-session-decision-answers.md` first.",
    );
  }

  for (const file of patchPlan.files) {
    lines.push("", `### ${file.path}`, "");

    if (file.replacements.length > 0) {
      lines.push(
        "| Line | Case | Row kind | Expected | Replacement |",
        "| ---: | --- | --- | --- | --- |",
      );
      for (const replacement of file.replacements) {
        const caseLabel = replacement.questionId
          ? `${replacement.caseId}/${replacement.questionId}`
          : replacement.sourceCaseId
            ? `${replacement.sourceCaseId}->${replacement.caseId}`
            : replacement.caseId;
        lines.push(
          `| ${replacement.line} | ${escapeMarkdownTableCell(caseLabel)} | ${escapeMarkdownTableCell(replacement.rowKind)} | ${escapeMarkdownTableCell(replacement.expectedLine)} | ${escapeMarkdownTableCell(replacement.replacementLine)} |`,
        );
      }
    }

    if (file.createOrUpdate.length > 0) {
      lines.push("| Action | Case | Row kind |", "| --- | --- | --- |");
      for (const item of file.createOrUpdate) {
        lines.push(
          `| ${escapeMarkdownTableCell(item.action)} | ${escapeMarkdownTableCell(item.caseId)} | ${escapeMarkdownTableCell(item.rowKind)} |`,
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderDecisionWorkflowBoardMarkdown(summary) {
  const lines = [
    "# Conversation Session Decision Workflow Board",
    "",
    "目标：把每个尚未 covered 的 case 放到同一张状态板里，追踪 answer draft、decision worksheet、source coverage、roadmap 和下一步动作。",
    "",
    "生成命令：",
    "",
    "```bash",
    "node scripts/audit-conversation-session-case-coverage.mjs --check --workflow-board-md",
    "```",
    "",
    "## 当前状态",
    "",
    "| 指标 | 当前值 |",
    "| --- | ---: |",
    `| Workflow case | ${summary.decisionWorkflowBoard.total} |`,
    `| Draft-ready case | ${summary.decisionBackfillWorkflow.draftReadyCases} |`,
    `| Worksheet-ready case | ${summary.decisionBackfillWorkflow.worksheetReadyCases} |`,
    `| Source-backfill-needed case | ${summary.decisionBackfillWorkflow.worksheetReadyStillDecisionNeededCases} |`,
    `| Roadmap ready-to-write | ${summary.decisionE2ERoadmap.readyToWrite} |`,
    `| Roadmap implemented | ${summary.decisionE2ERoadmap.implemented} |`,
    "",
    "## Next Action Counts",
    "",
    "| Next action | Case count |",
    "| --- | ---: |",
  ];

  const nextActionEntries = Object.entries(
    summary.decisionWorkflowBoard.nextActionCounts,
  );
  if (nextActionEntries.length === 0) {
    lines.push("| none | 0 |");
  }
  for (const [nextAction, count] of nextActionEntries) {
    lines.push(`| ${escapeMarkdownTableCell(nextAction)} | ${count} |`);
  }

  lines.push(
    "",
    "## Board",
    "",
    "| Case | Group | Answer draft | Worksheet | Source coverage | Roadmap | Next action |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const item of summary.decisionWorkflowBoard.cases) {
    lines.push(
      `| ${item.caseId} | ${escapeMarkdownTableCell(item.groupLabel)} | ${item.answerStatus} | ${item.worksheetStatus} | ${item.sourceStatus} | ${item.roadmapStatus} | ${escapeMarkdownTableCell(item.nextAction)} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function buildGeneratedMarkdownDocs(summary) {
  return [
    {
      content: renderDecisionReviewQueueMarkdown(
        summary,
        getFullDecisionReviewQueueScope(summary),
      ),
      key: "decisionReviewQueue",
      path: GENERATED_MARKDOWN_DOCS.decisionReviewQueue,
    },
    {
      content: renderDecisionReviewQueueMarkdown(
        summary,
        getNextDecisionReviewQueueScope(summary),
      ),
      key: "nextDecisionReview",
      path: GENERATED_MARKDOWN_DOCS.nextDecisionReview,
    },
    {
      content: renderDecisionAnswerTemplateMarkdown(
        summary,
        getDefaultDecisionAnswerTemplateScope(summary),
      ),
      key: "decisionAnswerTemplate",
      path: GENERATED_MARKDOWN_DOCS.decisionAnswerTemplate,
    },
    {
      content: renderDecisionAnswersStatusMarkdown(summary),
      key: "decisionAnswersStatus",
      path: GENERATED_MARKDOWN_DOCS.decisionAnswersStatus,
    },
    {
      content: renderDecisionBackfillPlanMarkdown(summary),
      key: "decisionBackfillPlan",
      path: GENERATED_MARKDOWN_DOCS.decisionBackfillPlan,
    },
    {
      content: renderDecisionWorkflowBoardMarkdown(summary),
      key: "decisionWorkflowBoard",
      path: GENERATED_MARKDOWN_DOCS.decisionWorkflowBoard,
    },
  ];
}

async function checkGeneratedMarkdownDocs(summary, errors) {
  const missing = [];
  const stale = [];

  for (const doc of buildGeneratedMarkdownDocs(summary)) {
    let current;
    try {
      current = await readFile(resolve(REPO_ROOT, doc.path), "utf8");
    } catch {
      missing.push(doc.path);
      errors.push(`generated markdown doc missing: ${doc.path}`);
      continue;
    }

    // 修复原因：Windows checkout 会把生成文档换成 CRLF；内容审计只比较语义文本，
    // 不能把工作树换行策略误报为 generated markdown stale。
    if (normalizeGeneratedMarkdown(current) !== normalizeGeneratedMarkdown(doc.content)) {
      stale.push(doc.path);
      errors.push(`generated markdown doc is stale: ${doc.path}`);
    }
  }

  return {
    checked: Object.keys(GENERATED_MARKDOWN_DOCS).length,
    missing,
    missingCount: missing.length,
    stale,
    staleCount: stale.length,
  };
}

function normalizeGeneratedMarkdown(markdown) {
  return markdown.replace(/\r\n/g, "\n");
}

function pushStatMismatch(errors, context, label, expected, actual) {
  if (actual !== expected) {
    errors.push(
      `${context} stat "${label}" expected ${expected}, found ${actual ?? "missing"}`,
    );
  }
}

function parseDecisionProtocol(source, config, errors) {
  const rows = parseRowsById(source, /^[A-Z]\d{2}\.\d+$/);
  const questionIds = sortedIds(rows);
  const missing = diffIds(config.expectedQuestionIds, questionIds);
  const extra = diffIds(questionIds, config.expectedQuestionIds);
  if (missing.length > 0) {
    errors.push(
      `${config.worksheetKey} decision protocol missing questions: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    errors.push(
      `${config.worksheetKey} decision protocol has unknown questions: ${extra.join(", ")}`,
    );
  }

  const caseIds = [];
  const completeQuestionIds = [];
  const questionDetailsByCase = {};
  for (const [id, row] of rows) {
    const expectedCaseId = id.split(".")[0];
    const caseId = stripInlineCode(row.cells[1] ?? "");
    const status = stripInlineCode(row.cells[2] ?? "");
    const productDecision = stripInlineCode(row.cells[3] ?? "");
    const reviewPrompt = stripInlineCode(row.cells[4] ?? "");
    const candidateAnswer = stripInlineCode(row.cells[5] ?? "");
    const backfillTarget = stripInlineCode(row.cells[6] ?? "");
    caseIds.push(caseId);
    questionDetailsByCase[caseId] = [
      ...(questionDetailsByCase[caseId] ?? []),
      {
        backfillTarget,
        candidateAnswer,
        productDecision,
        questionId: id,
        reviewPrompt,
        status,
      },
    ];
    if (caseId !== expectedCaseId) {
      errors.push(
        `${id} belongs to ${expectedCaseId} but ${config.worksheetKey} decision protocol maps it to ${caseId}`,
      );
    }
    if (!reviewPrompt || !candidateAnswer || !backfillTarget) {
      errors.push(
        `${id} is missing review prompt, candidate answer, or backfill target`,
      );
    }
    if (!["answered", "unanswered"].includes(status)) {
      errors.push(
        `${id} has invalid ${config.worksheetKey} decision protocol status ${status || "missing"}`,
      );
    }
    if (status === "answered" && isPendingProductDecision(productDecision)) {
      errors.push(`${id} is answered but has no product decision`);
    }
    if (status === "unanswered" && !isPendingProductDecision(productDecision)) {
      errors.push(
        `${id} is unanswered but already has product decision: ${productDecision}`,
      );
    }
    if (status === "answered" && !isPendingProductDecision(productDecision)) {
      completeQuestionIds.push(id);
    }
  }

  const statusCounts = countBy(rows, 2);
  const completeQuestionIdSet = new Set(completeQuestionIds);
  const questionsByCase = new Map();
  for (const id of config.expectedQuestionIds) {
    const caseId = id.split(".")[0];
    questionsByCase.set(caseId, [...(questionsByCase.get(caseId) ?? []), id]);
  }
  const blockedCaseIds = [];
  const readyCaseIds = [];
  const unansweredByCase = {};
  for (const caseId of config.caseIds) {
    const expectedCaseQuestionIds = questionsByCase.get(caseId) ?? [];
    const unansweredQuestionIds = expectedCaseQuestionIds.filter(
      (id) => !completeQuestionIdSet.has(id),
    );
    if (unansweredQuestionIds.length > 0) {
      blockedCaseIds.push(caseId);
      unansweredByCase[caseId] = unansweredQuestionIds;
    } else {
      readyCaseIds.push(caseId);
    }
  }

  return {
    answered: getCount(statusCounts, "answered"),
    blockedCaseIds,
    cases: sortedUnique(caseIds).length,
    completeQuestions: completeQuestionIds.length,
    expected: config.expectedQuestionIds.length,
    extra,
    missing,
    questionDetailsByCase,
    questions: rows.size,
    readyCaseIds,
    unanswered: getCount(statusCounts, "unanswered"),
    unansweredByCase,
  };
}

async function fileExists(path) {
  try {
    await access(resolve(REPO_ROOT, path));
    return true;
  } catch {
    return false;
  }
}

function hasRunnableTestDeclaration(source) {
  return /\b(?:it|test)\s*\(/.test(source);
}

function findSkipOrOnlyMarkers(source) {
  const markers = [];
  const pattern = /\b(?:describe|it|test)\.(?:skip|only)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    markers.push(match[0].replace(/\s*\($/, ""));
  }
  return markers;
}

async function main() {
  const formalAdmissionRoot = resolveFormalAdmissionRoot();
  const decisionWorksheetEntries = Object.entries(DECISION_WORKSHEETS);
  const [
    mainCatalog,
    coverageMatrix,
    environmentFaultCatalog,
    faultCoverageMatrix,
    decisionBacklog,
    decisionE2ERoadmap,
    decisionAnswers,
    ...decisionWorksheetSources
  ] = await Promise.all(
    [
      ...Object.values(DOCS),
      decisionAnswersPath,
      ...decisionWorksheetEntries.map(([, worksheet]) => worksheet.path),
    ].map((path) => readFile(resolve(REPO_ROOT, path), "utf8")),
  );

  const errors = await inspectCoverageMatrices(REPO_ROOT);
  const formalAdmission =
    await inspectConversationSessionFormalAdmission(formalAdmissionRoot);
  const formalAdmissionAudit =
    buildFormalAdmissionAuditIntegration(formalAdmission);
  errors.push(...formalAdmissionAudit.errors);
  const automationSpecs = parseAutomationSpecs(coverageMatrix);
  const faultAutomationSpecs = parseAutomationSpecs(faultCoverageMatrix);
  const mainCaseRows = parseRowsById(mainCatalog, /^[A-J]\d{2}$/);
  const pruningRows = parseRowsById(mainCatalog, /^K\d{2}$/);
  const mainCoverageRows = parseRowsById(coverageMatrix, /^[A-J]\d{2}$/);
  const pruningCoverageRows = parseRowsById(coverageMatrix, /^K\d{2}$/);
  const environmentProductRows = parseRowsById(
    environmentFaultCatalog,
    /^[NSCDLWX]\d{2}$/,
  );
  const environmentInfraRows = parseRowsById(
    environmentFaultCatalog,
    /^T\d{2}$/,
  );
  const faultCoverageRows = parseRowsById(
    faultCoverageMatrix,
    /^[NSCDLWX]\d{2}$/,
  );
  const decisionBacklogRows = parseRowsById(
    decisionBacklog,
    /^(?:F09|G11|G12|N\d{2}|S\d{2}|D\d{2}|L\d{2}|W\d{2}|X\d{2})$/,
  );
  const decisionE2ERoadmapRows = parseRowsById(
    decisionE2ERoadmap,
    // 修复原因：H08 这类已确认但缺自动化的 A-J 主路径 case 只进入 E2E roadmap，
    // 不进入 decision backlog；否则会被误当成仍待产品决策。
    /^(?:[A-J]\d{2}|[NSCDLWX]\d{2})$/,
  );

  const mainStatusCounts = countBy(mainCaseRows, 5);
  const coverageStatusCounts = countBy(mainCoverageRows, 1);
  const environmentStatusCounts = countByLastCell(environmentProductRows);
  const environmentInfraStatusCounts = countByLastCell(environmentInfraRows);
  const faultCoverageStatusCounts = countBy(faultCoverageRows, 1);

  const mainIds = sortedIds(mainCaseRows);
  const coverageIds = sortedIds(mainCoverageRows);
  const missingCoverageIds = diffIds(mainIds, coverageIds);
  const extraCoverageIds = diffIds(coverageIds, mainIds);
  if (missingCoverageIds.length > 0) {
    errors.push(
      `coverage matrix missing main cases: ${missingCoverageIds.join(", ")}`,
    );
  }
  if (extraCoverageIds.length > 0) {
    errors.push(
      `coverage matrix has unknown main cases: ${extraCoverageIds.join(", ")}`,
    );
  }

  for (const id of mainIds) {
    const catalogStatus = stripInlineCode(mainCaseRows.get(id)?.cells[5] ?? "");
    const coverageStatus = stripInlineCode(
      mainCoverageRows.get(id)?.cells[1] ?? "",
    );
    if (!coverageStatus) {
      continue;
    }
    if (catalogStatus === "undefined" && coverageStatus !== "undefined") {
      errors.push(
        `${id} is undefined in catalog but ${coverageStatus} in coverage matrix`,
      );
    }
    if (catalogStatus === "accepted" && coverageStatus === "undefined") {
      errors.push(
        `${id} is accepted in catalog but undefined in coverage matrix`,
      );
    }
  }

  const coverageEvidenceRows = new Map([
    ...mainCoverageRows,
    ...pruningCoverageRows,
  ]);
  const referencedAutomation = new Set();
  for (const [id, row] of coverageEvidenceRows) {
    const coverageStatus = stripInlineCode(row.cells[1] ?? "");
    const automationIds = parseAutomationCell(row.cells[2] ?? "");
    const shouldHaveAutomation = ["covered", "failing", "partial"].includes(
      coverageStatus,
    );
    if (shouldHaveAutomation && automationIds.length === 0) {
      errors.push(`${id} is ${coverageStatus} but has no automation evidence`);
    }
    if (coverageStatus === "undefined" && automationIds.length > 0) {
      errors.push(
        `${id} is undefined but has automation evidence: ${automationIds.join(", ")}`,
      );
    }
    for (const automationId of automationIds) {
      referencedAutomation.add(automationId);
      if (!automationSpecs.has(automationId)) {
        errors.push(
          `${id} references unknown automation abbreviation ${automationId}`,
        );
      }
    }
  }

  const missingSpecFiles = [];
  const specFilesWithoutTests = [];
  const specFilesWithSkipOrOnly = [];
  for (const spec of automationSpecs.values()) {
    const absolutePath = resolve(REPO_ROOT, spec.path);
    if (!(await fileExists(spec.path))) {
      missingSpecFiles.push(spec.path);
      continue;
    }
    const specSource = await readFile(absolutePath, "utf8");
    if (!hasRunnableTestDeclaration(specSource)) {
      specFilesWithoutTests.push(spec.path);
    }
    const markers = findSkipOrOnlyMarkers(specSource);
    if (markers.length > 0) {
      specFilesWithSkipOrOnly.push({ markers, path: spec.path });
    }
  }
  for (const path of missingSpecFiles) {
    errors.push(`automation spec file does not exist: ${path}`);
  }
  for (const path of specFilesWithoutTests) {
    errors.push(`automation spec file has no it/test declaration: ${path}`);
  }
  for (const { markers, path } of specFilesWithSkipOrOnly) {
    errors.push(
      `automation spec file contains skip/only marker(s) ${markers.join(", ")}: ${path}`,
    );
  }

  const faultReferencedAutomation = new Set();
  const faultCoverageIds = sortedIds(faultCoverageRows);
  const environmentProductIds = sortedIds(environmentProductRows);
  const missingFaultCoverageIds = diffIds(
    environmentProductIds,
    faultCoverageIds,
  );
  const extraFaultCoverageIds = diffIds(
    faultCoverageIds,
    environmentProductIds,
  );
  if (missingFaultCoverageIds.length > 0) {
    errors.push(
      `fault coverage matrix missing product fault cases: ${missingFaultCoverageIds.join(", ")}`,
    );
  }
  if (extraFaultCoverageIds.length > 0) {
    errors.push(
      `fault coverage matrix has unknown product fault cases: ${extraFaultCoverageIds.join(", ")}`,
    );
  }

  for (const id of environmentProductIds) {
    const environmentStatus = stripInlineCode(
      environmentProductRows.get(id)?.cells.at(-1) ?? "",
    );
    const coverageStatus = stripInlineCode(
      faultCoverageRows.get(id)?.cells[1] ?? "",
    );
    const automationIds = parseAutomationCell(
      faultCoverageRows.get(id)?.cells[2] ?? "",
    );
    if (!coverageStatus) {
      continue;
    }
    if (
      environmentStatus === "decision-needed" &&
      coverageStatus !== "decision-needed"
    ) {
      errors.push(
        `${id} is decision-needed in environment catalog but ${coverageStatus} in fault coverage matrix`,
      );
    }
    if (
      environmentStatus !== "decision-needed" &&
      coverageStatus === "decision-needed"
    ) {
      errors.push(
        `${id} is ${environmentStatus} in environment catalog but still decision-needed in fault coverage matrix`,
      );
    }
    if (coverageStatus === "decision-needed" && automationIds.length > 0) {
      errors.push(
        `${id} is decision-needed but has fault automation evidence: ${automationIds.join(", ")}`,
      );
    }
    if (
      ["covered", "failing", "partial"].includes(coverageStatus) &&
      automationIds.length === 0
    ) {
      errors.push(
        `${id} is ${coverageStatus} in fault coverage matrix but has no automation evidence`,
      );
    }
    for (const automationId of automationIds) {
      faultReferencedAutomation.add(automationId);
      if (!faultAutomationSpecs.has(automationId)) {
        errors.push(
          `${id} references unknown fault automation abbreviation ${automationId}`,
        );
      }
    }
  }

  const faultMissingSpecFiles = [];
  const faultSpecFilesWithoutTests = [];
  const faultSpecFilesWithSkipOrOnly = [];
  for (const spec of faultAutomationSpecs.values()) {
    const absolutePath = resolve(REPO_ROOT, spec.path);
    if (!(await fileExists(spec.path))) {
      faultMissingSpecFiles.push(spec.path);
      continue;
    }
    const specSource = await readFile(absolutePath, "utf8");
    if (!hasRunnableTestDeclaration(specSource)) {
      faultSpecFilesWithoutTests.push(spec.path);
    }
    const markers = findSkipOrOnlyMarkers(specSource);
    if (markers.length > 0) {
      faultSpecFilesWithSkipOrOnly.push({ markers, path: spec.path });
    }
  }
  for (const path of faultMissingSpecFiles) {
    errors.push(`fault automation spec file does not exist: ${path}`);
  }
  for (const path of faultSpecFilesWithoutTests) {
    errors.push(
      `fault automation spec file has no it/test declaration: ${path}`,
    );
  }
  for (const { markers, path } of faultSpecFilesWithSkipOrOnly) {
    errors.push(
      `fault automation spec file contains skip/only marker(s) ${markers.join(", ")}: ${path}`,
    );
  }

  const mainUndefinedIds = mainIds.filter(
    (id) =>
      stripInlineCode(mainCaseRows.get(id)?.cells[5] ?? "") === "undefined",
  );
  const aliasSourceIds = sortedIds(environmentProductRows)
    .filter((id) => id.startsWith("C"))
    .map((id) =>
      stripInlineCode(environmentProductRows.get(id)?.cells[1] ?? ""),
    );
  const missingAliasSources = diffIds(mainUndefinedIds, aliasSourceIds);
  if (missingAliasSources.length > 0) {
    errors.push(
      `environment compact aliases missing undefined sources: ${missingAliasSources.join(", ")}`,
    );
  }

  const environmentAliasRows = aliasSourceIds.length;
  const environmentProductRowCount = environmentProductRows.size;
  const newExternalProductCases =
    environmentProductRowCount - environmentAliasRows;
  const newExternalDecisionNeededCases = environmentProductIds.filter(
    (id) =>
      !id.startsWith("C") &&
      stripInlineCode(environmentProductRows.get(id)?.cells.at(-1) ?? "") ===
        "decision-needed",
  ).length;
  const newExternalCoveredCases = faultCoverageIds.filter(
    (id) =>
      !id.startsWith("C") &&
      stripInlineCode(faultCoverageRows.get(id)?.cells[1] ?? "") === "covered",
  ).length;
  const environmentDecisionUniqueIds = sortedIds(environmentProductRows)
    .filter(
      (id) =>
        stripInlineCode(environmentProductRows.get(id)?.cells.at(-1) ?? "") ===
        "decision-needed",
    )
    .map((id) =>
      id.startsWith("C")
        ? stripInlineCode(environmentProductRows.get(id)?.cells[1] ?? "")
        : id,
    );
  const expectedDecisionBacklogIds = sortedUnique([
    ...mainUndefinedIds,
    ...environmentDecisionUniqueIds,
  ]);
  const decisionBacklogIds = sortedIds(decisionBacklogRows);
  const missingDecisionBacklogIds = diffIds(
    expectedDecisionBacklogIds,
    decisionBacklogIds,
  );
  const extraDecisionBacklogIds = diffIds(
    decisionBacklogIds,
    expectedDecisionBacklogIds,
  );
  if (missingDecisionBacklogIds.length > 0) {
    errors.push(
      `decision backlog missing decision-needed cases: ${missingDecisionBacklogIds.join(", ")}`,
    );
  }
  if (extraDecisionBacklogIds.length > 0) {
    errors.push(
      `decision backlog has cases that are not currently decision-needed: ${extraDecisionBacklogIds.join(", ")}`,
    );
  }

  const expectedDecisionE2ERoadmapIds = getExpectedRoadmapCaseIds(
    mainCoverageRows,
    faultCoverageRows,
  );
  const decisionE2ERoadmapIds = sortedIds(decisionE2ERoadmapRows);
  const missingDecisionE2ERoadmapIds = diffIds(
    expectedDecisionE2ERoadmapIds,
    decisionE2ERoadmapIds,
  );
  const extraDecisionE2ERoadmapIds = diffIds(
    decisionE2ERoadmapIds,
    expectedDecisionE2ERoadmapIds,
  );
  if (missingDecisionE2ERoadmapIds.length > 0) {
    errors.push(
      `decision E2E roadmap missing non-covered cases: ${missingDecisionE2ERoadmapIds.join(", ")}`,
    );
  }
  if (extraDecisionE2ERoadmapIds.length > 0) {
    errors.push(
      `decision E2E roadmap has cases that are already covered or unknown: ${extraDecisionE2ERoadmapIds.join(", ")}`,
    );
  }
  const decisionE2ERoadmapStatusCounts = countBy(decisionE2ERoadmapRows, 5);
  for (const [id, row] of decisionE2ERoadmapRows) {
    const specPath = stripInlineCode(row.cells[2] ?? "");
    const fixture = stripInlineCode(row.cells[3] ?? "");
    const assertionSurfaces = stripInlineCode(row.cells[4] ?? "");
    const status = stripInlineCode(row.cells[5] ?? "");
    if (!DECISION_E2E_ROADMAP_STATUSES.includes(status)) {
      errors.push(
        `${id} has invalid decision E2E roadmap status ${status || "missing"}`,
      );
    }
    if (!specPath || !fixture || !assertionSurfaces) {
      errors.push(
        `${id} is missing decision E2E roadmap spec, fixture/harness, or assertion surfaces`,
      );
    }
    const sourceStatus = getRoadmapSourceStatus(
      id,
      mainCoverageRows,
      faultCoverageRows,
    );
    if (
      sourceStatus &&
      !isRoadmapStatusAlignedWithCoverage(status, sourceStatus)
    ) {
      errors.push(
        `${id} roadmap status ${status || "missing"} does not match coverage status ${sourceStatus}`,
      );
    }
  }

  const decisionWorksheetRows = new Map();
  const decisionWorksheetCounts = {};
  for (const [index, [key, worksheet]] of decisionWorksheetEntries.entries()) {
    const worksheetRows = parseRowsById(
      decisionWorksheetSources[index] ?? "",
      worksheet.idPattern,
    );
    const worksheetIds = sortedIds(worksheetRows);
    decisionWorksheetCounts[key] = worksheetIds.length;
    for (const id of worksheetIds) {
      decisionWorksheetRows.set(id, worksheetRows.get(id));
    }
  }
  const decisionWorksheetIds = sortedIds(decisionWorksheetRows);
  const missingDecisionWorksheetIds = diffIds(
    expectedDecisionBacklogIds,
    decisionWorksheetIds,
  );
  const extraDecisionWorksheetIds = diffIds(
    decisionWorksheetIds,
    expectedDecisionBacklogIds,
  );
  if (missingDecisionWorksheetIds.length > 0) {
    errors.push(
      `decision worksheets missing decision-needed cases: ${missingDecisionWorksheetIds.join(", ")}`,
    );
  }
  if (extraDecisionWorksheetIds.length > 0) {
    errors.push(
      `decision worksheets have cases that are not currently decision-needed: ${extraDecisionWorksheetIds.join(", ")}`,
    );
  }

  const decisionProtocolSummaries = {};
  const worksheetQuestionRows = new Map();
  for (const [key, protocol] of Object.entries(DECISION_PROTOCOLS)) {
    const worksheetIndex = decisionWorksheetEntries.findIndex(
      ([worksheetKey]) => worksheetKey === protocol.worksheetKey,
    );
    const worksheetSource = decisionWorksheetSources[worksheetIndex] ?? "";
    for (const [questionId, row] of parseRowsById(
      worksheetSource,
      /^[A-Z]\d{2}\.\d+$/,
    )) {
      worksheetQuestionRows.set(questionId, row);
    }
    const protocolSummary = parseDecisionProtocol(
      worksheetSource,
      protocol,
      errors,
    );
    const protocolStats = parseStatsTableAfterHeading(
      worksheetSource,
      protocol.statsHeading,
    );
    pushStatMismatch(
      errors,
      `${key} decision worksheet`,
      protocol.statsLabels.cases,
      protocolSummary.cases,
      protocolStats.get(protocol.statsLabels.cases),
    );
    pushStatMismatch(
      errors,
      `${key} decision worksheet`,
      protocol.statsLabels.questions,
      protocolSummary.questions,
      protocolStats.get(protocol.statsLabels.questions),
    );
    pushStatMismatch(
      errors,
      `${key} decision worksheet`,
      protocol.statsLabels.answered,
      protocolSummary.answered,
      protocolStats.get(protocol.statsLabels.answered),
    );
    pushStatMismatch(
      errors,
      `${key} decision worksheet`,
      protocol.statsLabels.unanswered,
      protocolSummary.unanswered,
      protocolStats.get(protocol.statsLabels.unanswered),
    );
    decisionProtocolSummaries[key] = protocolSummary;
  }
  const decisionProtocolSummaryValues = Object.values(
    decisionProtocolSummaries,
  );
  const decisionProtocolCaseIds = sortedUnique(
    decisionProtocolSummaryValues.flatMap((protocol) => [
      ...protocol.blockedCaseIds,
      ...protocol.readyCaseIds,
    ]),
  );
  const missingDecisionProtocolCaseIds = diffIds(
    expectedDecisionBacklogIds,
    decisionProtocolCaseIds,
  );
  const extraDecisionProtocolCaseIds = diffIds(
    decisionProtocolCaseIds,
    expectedDecisionBacklogIds,
  );
  if (missingDecisionProtocolCaseIds.length > 0) {
    errors.push(
      `decision protocols missing decision-needed cases: ${missingDecisionProtocolCaseIds.join(", ")}`,
    );
  }
  if (extraDecisionProtocolCaseIds.length > 0) {
    errors.push(
      `decision protocols have cases that are not currently decision-needed: ${extraDecisionProtocolCaseIds.join(", ")}`,
    );
  }

  const coverageMissingAccepted = mainIds.filter((id) => {
    const catalogStatus = stripInlineCode(mainCaseRows.get(id)?.cells[5] ?? "");
    const coverageStatus = stripInlineCode(
      mainCoverageRows.get(id)?.cells[1] ?? "",
    );
    return catalogStatus === "accepted" && coverageStatus !== "covered";
  }).length;
  const faultCoverageMissingAccepted = environmentProductIds.filter((id) => {
    const environmentStatus = stripInlineCode(
      environmentProductRows.get(id)?.cells.at(-1) ?? "",
    );
    const coverageStatus = stripInlineCode(
      faultCoverageRows.get(id)?.cells[1] ?? "",
    );
    return environmentStatus === "accepted" && coverageStatus !== "covered";
  }).length;
  const readyDecisionCaseIds = sortedUnique(
    decisionProtocolSummaryValues.flatMap((protocol) => protocol.readyCaseIds),
  );
  const blockedDecisionCaseIds = sortedUnique(
    decisionProtocolSummaryValues.flatMap(
      (protocol) => protocol.blockedCaseIds,
    ),
  );
  const unansweredQuestionsByCase = Object.assign(
    {},
    ...decisionProtocolSummaryValues.map(
      (protocol) => protocol.unansweredByCase,
    ),
  );
  const questionDetailsByCase = Object.assign(
    {},
    ...decisionProtocolSummaryValues.map(
      (protocol) => protocol.questionDetailsByCase,
    ),
  );
  const decisionAnswerDraft = summarizeDecisionAnswerDraft(
    decisionAnswers,
    questionDetailsByCase,
  );
  decisionAnswerDraft.sourcePath = decisionAnswersPath;
  decisionAnswerDraft.usesCustomPath = usesCustomDecisionAnswersPath;
  if (decisionAnswerDraft.unknownQuestionIds.length > 0) {
    errors.push(
      `decision answer draft has unknown questions: ${decisionAnswerDraft.unknownQuestionIds.join(", ")}`,
    );
  }
  if (decisionAnswerDraft.duplicateQuestionIds.length > 0) {
    errors.push(
      `decision answer draft has duplicate questions: ${decisionAnswerDraft.duplicateQuestionIds.join(", ")}`,
    );
  }
  if (decisionAnswerDraft.missingQuestionIds.length > 0) {
    errors.push(
      `decision answer draft is missing question placeholders: ${decisionAnswerDraft.missingQuestionIds.join(", ")}`,
    );
  }
  const decisionReviewQueue = buildDecisionReviewQueue(
    blockedDecisionCaseIds,
    unansweredQuestionsByCase,
    questionDetailsByCase,
  );
  const decisionAnswerReadiness = buildDecisionAnswerReadiness(
    decisionReviewQueue,
    decisionAnswerDraft,
  );
  const draftReadyNotWorksheetReadyCaseIds =
    decisionAnswerReadiness.readyCaseIds.filter(
      (caseId) => !readyDecisionCaseIds.includes(caseId),
    );
  if (requireBackfillClean && draftReadyNotWorksheetReadyCaseIds.length > 0) {
    errors.push(
      `decision answer draft has ready cases that still need worksheet/source backfill: ${draftReadyNotWorksheetReadyCaseIds.join(", ")}`,
    );
  }
  const worksheetReadyStillDecisionNeededCaseIds = readyDecisionCaseIds.filter(
    (caseId) => expectedDecisionBacklogIds.includes(caseId),
  );
  if (worksheetReadyStillDecisionNeededCaseIds.length > 0) {
    errors.push(
      `decision worksheet has answered cases that still need source catalog/coverage backfill: ${worksheetReadyStillDecisionNeededCaseIds.join(", ")}`,
    );
  }
  const decisionWorkflowBoard = buildDecisionWorkflowBoard(
    decisionE2ERoadmapRows,
    decisionAnswerReadiness,
    readyDecisionCaseIds,
    blockedDecisionCaseIds,
    mainCoverageRows,
    faultCoverageRows,
  );

  const summary = {
    files: DOCS,
    formalAdmission: formalAdmissionAudit.json,
    main: {
      accepted: getCount(mainStatusCounts, "accepted"),
      cases: mainCaseRows.size,
      pruningRules: pruningRows.size,
      undefined: getCount(mainStatusCounts, "undefined"),
    },
    coverage: {
      automationAbbreviations: automationSpecs.size,
      cases: mainCoverageRows.size,
      covered: getCount(coverageStatusCounts, "covered"),
      failing: getCount(coverageStatusCounts, "failing"),
      missingAccepted: coverageMissingAccepted,
      partial: getCount(coverageStatusCounts, "partial"),
      pruningRules: pruningCoverageRows.size,
      referencedAutomationAbbreviations: referencedAutomation.size,
      referencedSpecFilesWithSkipOrOnly: specFilesWithSkipOrOnly.length,
      referencedSpecFilesWithTests:
        automationSpecs.size -
        missingSpecFiles.length -
        specFilesWithoutTests.length,
      undefined: getCount(coverageStatusCounts, "undefined"),
    },
    environment: {
      accepted: getCount(environmentStatusCounts, "accepted"),
      aliasesToMainUndefined: environmentAliasRows,
      decisionNeeded: getCount(environmentStatusCounts, "decision-needed"),
      infra: environmentInfraRows.size,
      infraStatusInfra: getCount(environmentInfraStatusCounts, "infra"),
      newExternalCoveredCases,
      newExternalDecisionNeededCases,
      newExternalProductCases,
      productRows: environmentProductRowCount,
    },
    faultCoverage: {
      automationAbbreviations: faultAutomationSpecs.size,
      cases: faultCoverageRows.size,
      covered: getCount(faultCoverageStatusCounts, "covered"),
      decisionNeeded: getCount(faultCoverageStatusCounts, "decision-needed"),
      failing: getCount(faultCoverageStatusCounts, "failing"),
      ignored: getCount(faultCoverageStatusCounts, "ignored"),
      invalid: getCount(faultCoverageStatusCounts, "invalid"),
      missingAccepted: faultCoverageMissingAccepted,
      partial: getCount(faultCoverageStatusCounts, "partial"),
      referencedAutomationAbbreviations: faultReferencedAutomation.size,
      referencedSpecFilesWithSkipOrOnly: faultSpecFilesWithSkipOrOnly.length,
      referencedSpecFilesWithTests:
        faultAutomationSpecs.size -
        faultMissingSpecFiles.length -
        faultSpecFilesWithoutTests.length,
    },
    decisionBacklog: {
      appLifecycleFaults: decisionBacklogIds.filter((id) => id.startsWith("L"))
        .length,
      cases: decisionBacklogRows.size,
      compactMainUndefined: mainUndefinedIds.length,
      crossSessionFaults: decisionBacklogIds.filter((id) => id.startsWith("X"))
        .length,
      expected: expectedDecisionBacklogIds.length,
      filesystemFaults: decisionBacklogIds.filter((id) => id.startsWith("D"))
        .length,
      missing: missingDecisionBacklogIds,
      modelApiFaults: decisionBacklogIds.filter((id) => id.startsWith("N"))
        .length,
      sseFaults: decisionBacklogIds.filter((id) => id.startsWith("S")).length,
      workspaceToolFaults: decisionBacklogIds.filter((id) => id.startsWith("W"))
        .length,
      extra: extraDecisionBacklogIds,
    },
    decisionE2ERoadmap: {
      blockedByProductDecision: getCount(
        decisionE2ERoadmapStatusCounts,
        "blocked-by-product-decision",
      ),
      cases: decisionE2ERoadmapRows.size,
      expected: expectedDecisionE2ERoadmapIds.length,
      extra: extraDecisionE2ERoadmapIds,
      ignored: getCount(decisionE2ERoadmapStatusCounts, "ignored"),
      implemented: getCount(decisionE2ERoadmapStatusCounts, "implemented"),
      invalid: getCount(decisionE2ERoadmapStatusCounts, "invalid"),
      missing: missingDecisionE2ERoadmapIds,
      readyToWrite: getCount(decisionE2ERoadmapStatusCounts, "ready-to-write"),
    },
    decisionWorksheets: {
      cases: decisionWorksheetRows.size,
      compact: decisionWorksheetCounts.compact ?? 0,
      expected: expectedDecisionBacklogIds.length,
      extra: extraDecisionWorksheetIds,
      missing: missingDecisionWorksheetIds,
      networkSse: decisionWorksheetCounts.networkSse ?? 0,
      recoveryIsolation: decisionWorksheetCounts.recoveryIsolation ?? 0,
    },
    compactDecisionProtocol: decisionProtocolSummaries.compact,
    decisionProtocols: {
      answered: decisionProtocolSummaryValues.reduce(
        (total, protocol) => total + protocol.answered,
        0,
      ),
      cases: decisionProtocolSummaryValues.reduce(
        (total, protocol) => total + protocol.cases,
        0,
      ),
      completeQuestions: decisionProtocolSummaryValues.reduce(
        (total, protocol) => total + protocol.completeQuestions,
        0,
      ),
      expected: decisionProtocolSummaryValues.reduce(
        (total, protocol) => total + protocol.expected,
        0,
      ),
      questions: decisionProtocolSummaryValues.reduce(
        (total, protocol) => total + protocol.questions,
        0,
      ),
      unanswered: decisionProtocolSummaryValues.reduce(
        (total, protocol) => total + protocol.unanswered,
        0,
      ),
    },
    decisionReadiness: {
      blockedCaseIds: blockedDecisionCaseIds,
      blockedCases: blockedDecisionCaseIds.length,
      extra: extraDecisionProtocolCaseIds,
      missing: missingDecisionProtocolCaseIds,
      readyCaseIds: readyDecisionCaseIds,
      readyCases: readyDecisionCaseIds.length,
      totalCases: decisionProtocolCaseIds.length,
      questionDetailsByCase,
      unansweredQuestionsByCase,
    },
    decisionAnswerDraft,
    decisionAnswerReadiness,
    decisionBackfillWorkflow: {
      backfillCleanRequired: requireBackfillClean,
      draftReadyCaseIds: decisionAnswerReadiness.readyCaseIds,
      draftReadyCases: decisionAnswerReadiness.readyCases,
      draftReadyNotWorksheetReadyCaseIds,
      draftReadyNotWorksheetReadyCases:
        draftReadyNotWorksheetReadyCaseIds.length,
      worksheetReadyCaseIds: readyDecisionCaseIds,
      worksheetReadyCases: readyDecisionCaseIds.length,
      worksheetReadyStillDecisionNeededCaseIds,
      worksheetReadyStillDecisionNeededCases:
        worksheetReadyStillDecisionNeededCaseIds.length,
    },
    decisionWorkflowBoard,
    decisionReviewQueue: {
      cases: decisionReviewQueue,
      nextCaseIds: decisionReviewQueue.slice(0, 3).map((item) => item.caseId),
      nextCases: decisionReviewQueue.slice(0, 3),
      total: decisionReviewQueue.length,
    },
    networkSseDecisionProtocol: decisionProtocolSummaries.networkSse,
    recoveryIsolationDecisionProtocol:
      decisionProtocolSummaries.recoveryIsolation,
    uniqueProduct: {
      covered:
        getCount(coverageStatusCounts, "covered") + newExternalCoveredCases,
      decisionNeeded:
        getCount(mainStatusCounts, "undefined") +
        newExternalDecisionNeededCases,
      total: mainCaseRows.size + newExternalProductCases,
    },
    errors,
  };
  summary.completionGate = {
    blockedCaseIds: blockedDecisionCaseIds,
    coverageComplete:
      summary.uniqueProduct.decisionNeeded === 0 &&
      summary.coverage.missingAccepted === 0 &&
      summary.faultCoverage.missingAccepted === 0 &&
      summary.decisionE2ERoadmap.blockedByProductDecision === 0 &&
      summary.decisionReadiness.blockedCases === 0,
    covered: summary.uniqueProduct.covered,
    decisionNeeded: summary.uniqueProduct.decisionNeeded,
    faultMissingAccepted: summary.faultCoverage.missingAccepted,
    mainMissingAccepted: summary.coverage.missingAccepted,
    productTotal: summary.uniqueProduct.total,
    required: requireComplete,
  };
  summary.decisionBackfillPlan = buildDecisionBackfillPlan(summary, {
    decisionE2ERoadmapRows,
    environmentProductRows,
    faultCoverageRows,
    mainCaseRows,
    mainCoverageRows,
    worksheetQuestionRows,
  });
  if (requireComplete && !summary.completionGate.coverageComplete) {
    errors.push(
      `conversation session coverage is incomplete: ${summary.completionGate.decisionNeeded} product decision case(s) remain (${summary.completionGate.blockedCaseIds.join(", ") || "none"})`,
    );
  }

  const coverageStats = parseStatsTableAfterHeading(
    coverageMatrix,
    "## 当前统计",
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "Catalog A-J 总 case",
    summary.main.cases,
    coverageStats.get("Catalog A-J 总 case"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "accepted case",
    summary.main.accepted,
    coverageStats.get("accepted case"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "undefined case",
    summary.main.undefined,
    coverageStats.get("undefined case"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "covered",
    summary.coverage.covered,
    coverageStats.get("covered"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "failing probe",
    summary.coverage.failing,
    coverageStats.get("failing probe"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "partial",
    summary.coverage.partial,
    coverageStats.get("partial"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "missing accepted case",
    summary.coverage.missingAccepted,
    coverageStats.get("missing accepted case"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "自动化缩写",
    summary.coverage.automationAbbreviations,
    coverageStats.get("自动化缩写"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "被引用自动化缩写",
    summary.coverage.referencedAutomationAbbreviations,
    coverageStats.get("被引用自动化缩写"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "有测试声明的 spec",
    summary.coverage.referencedSpecFilesWithTests,
    coverageStats.get("有测试声明的 spec"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "含 skip/only 的 spec",
    summary.coverage.referencedSpecFilesWithSkipOrOnly,
    coverageStats.get("含 skip/only 的 spec"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "关键剪枝规则 K",
    summary.main.pruningRules,
    coverageStats.get("关键剪枝规则 K"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "外部故障新增产品 case",
    summary.environment.newExternalProductCases,
    coverageStats.get("外部故障新增产品 case"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "外部故障引用已有 undefined",
    summary.environment.aliasesToMainUndefined,
    coverageStats.get("外部故障引用已有 undefined"),
  );
  pushStatMismatch(
    errors,
    "coverage matrix",
    "外部故障 infra case",
    summary.environment.infra,
    coverageStats.get("外部故障 infra case"),
  );

  const environmentStats = parseStatsTableAfterHeading(
    environmentFaultCatalog,
    "## 当前统计",
  );
  pushStatMismatch(
    errors,
    "environment catalog",
    "产品 fault row",
    summary.environment.productRows,
    environmentStats.get("产品 fault row"),
  );
  pushStatMismatch(
    errors,
    "environment catalog",
    "其中：新增外部故障产品 case",
    summary.environment.newExternalProductCases,
    environmentStats.get("其中：新增外部故障产品 case"),
  );
  pushStatMismatch(
    errors,
    "environment catalog",
    "其中：主路径 undefined 别名",
    summary.environment.aliasesToMainUndefined,
    environmentStats.get("其中：主路径 undefined 别名"),
  );
  pushStatMismatch(
    errors,
    "environment catalog",
    "测试基础设施 case",
    summary.environment.infra,
    environmentStats.get("测试基础设施 case"),
  );
  pushStatMismatch(
    errors,
    "environment catalog",
    "accepted",
    summary.environment.accepted,
    environmentStats.get("accepted"),
  );
  pushStatMismatch(
    errors,
    "environment catalog",
    "decision-needed",
    summary.environment.decisionNeeded,
    environmentStats.get("decision-needed"),
  );
  pushStatMismatch(
    errors,
    "environment catalog",
    "infra",
    summary.environment.infraStatusInfra,
    environmentStats.get("infra"),
  );

  const faultCoverageStats = parseStatsTableAfterHeading(
    faultCoverageMatrix,
    "## 当前统计",
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "产品 fault row",
    summary.faultCoverage.cases,
    faultCoverageStats.get("产品 fault row"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "decision-needed",
    summary.faultCoverage.decisionNeeded,
    faultCoverageStats.get("decision-needed"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "missing accepted fault",
    summary.faultCoverage.missingAccepted,
    faultCoverageStats.get("missing accepted fault"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "covered",
    summary.faultCoverage.covered,
    faultCoverageStats.get("covered"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "failing probe",
    summary.faultCoverage.failing,
    faultCoverageStats.get("failing probe"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "partial",
    summary.faultCoverage.partial,
    faultCoverageStats.get("partial"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "ignored",
    summary.faultCoverage.ignored,
    faultCoverageStats.get("ignored"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "invalid",
    summary.faultCoverage.invalid,
    faultCoverageStats.get("invalid"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "自动化缩写",
    summary.faultCoverage.automationAbbreviations,
    faultCoverageStats.get("自动化缩写"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "被引用自动化缩写",
    summary.faultCoverage.referencedAutomationAbbreviations,
    faultCoverageStats.get("被引用自动化缩写"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "有测试声明的 spec",
    summary.faultCoverage.referencedSpecFilesWithTests,
    faultCoverageStats.get("有测试声明的 spec"),
  );
  pushStatMismatch(
    errors,
    "fault coverage matrix",
    "含 skip/only 的 spec",
    summary.faultCoverage.referencedSpecFilesWithSkipOrOnly,
    faultCoverageStats.get("含 skip/only 的 spec"),
  );

  const decisionBacklogStats = parseStatsTableAfterHeading(
    decisionBacklog,
    "## 当前统计",
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "待产品决策 unique case",
    summary.decisionBacklog.expected,
    decisionBacklogStats.get("待产品决策 unique case"),
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "主路径 compact undefined",
    summary.decisionBacklog.compactMainUndefined,
    decisionBacklogStats.get("主路径 compact undefined"),
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "模型/API 请求故障",
    summary.decisionBacklog.modelApiFaults,
    decisionBacklogStats.get("模型/API 请求故障"),
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "SSE 流式故障",
    summary.decisionBacklog.sseFaults,
    decisionBacklogStats.get("SSE 流式故障"),
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "文件系统/存储故障",
    summary.decisionBacklog.filesystemFaults,
    decisionBacklogStats.get("文件系统/存储故障"),
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "App 生命周期/进程故障",
    summary.decisionBacklog.appLifecycleFaults,
    decisionBacklogStats.get("App 生命周期/进程故障"),
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "Workspace / Tool 外部变化",
    summary.decisionBacklog.workspaceToolFaults,
    decisionBacklogStats.get("Workspace / Tool 外部变化"),
  );
  pushStatMismatch(
    errors,
    "decision backlog",
    "跨 Session 故障隔离",
    summary.decisionBacklog.crossSessionFaults,
    decisionBacklogStats.get("跨 Session 故障隔离"),
  );

  const decisionE2ERoadmapStats = parseStatsTableAfterHeading(
    decisionE2ERoadmap,
    "## 当前统计",
  );
  pushStatMismatch(
    errors,
    "decision E2E roadmap",
    "Expected roadmap case",
    summary.decisionE2ERoadmap.expected,
    decisionE2ERoadmapStats.get("Expected roadmap case"),
  );
  pushStatMismatch(
    errors,
    "decision E2E roadmap",
    "Roadmap case",
    summary.decisionE2ERoadmap.cases,
    decisionE2ERoadmapStats.get("Roadmap case"),
  );
  pushStatMismatch(
    errors,
    "decision E2E roadmap",
    "blocked-by-product-decision",
    summary.decisionE2ERoadmap.blockedByProductDecision,
    decisionE2ERoadmapStats.get("blocked-by-product-decision"),
  );
  pushStatMismatch(
    errors,
    "decision E2E roadmap",
    "ready-to-write",
    summary.decisionE2ERoadmap.readyToWrite,
    decisionE2ERoadmapStats.get("ready-to-write"),
  );
  pushStatMismatch(
    errors,
    "decision E2E roadmap",
    "implemented",
    summary.decisionE2ERoadmap.implemented,
    decisionE2ERoadmapStats.get("implemented"),
  );
  pushStatMismatch(
    errors,
    "decision E2E roadmap",
    "ignored",
    summary.decisionE2ERoadmap.ignored,
    decisionE2ERoadmapStats.get("ignored"),
  );
  pushStatMismatch(
    errors,
    "decision E2E roadmap",
    "invalid",
    summary.decisionE2ERoadmap.invalid,
    decisionE2ERoadmapStats.get("invalid"),
  );

  const shouldRenderReviewQueueMarkdown =
    (reviewQueueMarkdownOutput || reviewNextMarkdownOutput) &&
    !answerTemplateMarkdownOutput;
  const reviewQueueScope = shouldRenderReviewQueueMarkdown
    ? getDecisionReviewQueueScope(summary, errors)
    : null;
  const answerTemplateScope = answerTemplateMarkdownOutput
    ? getDecisionAnswerTemplateScope(summary, errors)
    : null;
  const rendersMarkdown = Boolean(
    reviewQueueScope ||
    answerTemplateScope ||
    answersStatusMarkdownOutput ||
    backfillPlanMarkdownOutput ||
    backfillPatchMarkdownOutput ||
    workflowBoardMarkdownOutput,
  );
  summary.generatedMarkdownDocs =
    rendersMarkdown || usesCustomDecisionAnswersPath
      ? {
          checked: 0,
          missing: [],
          missingCount: 0,
          skipped: true,
          stale: [],
          staleCount: 0,
        }
      : await checkGeneratedMarkdownDocs(summary, errors);

  // 写在所有检查之后：errors 已是最终结果，内容与 --json 输出相同；不影响下面的文本输出。
  if (jsonOutPath) {
    const outPath = resolve(jsonOutPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  }

  if (backfillPlanJsonOutput) {
    console.log(JSON.stringify(summary.decisionBackfillPlan, null, 2));
  } else if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (reviewQueueScope) {
    process.stdout.write(
      renderDecisionReviewQueueMarkdown(summary, reviewQueueScope),
    );
  } else if (answerTemplateScope) {
    process.stdout.write(
      renderDecisionAnswerTemplateMarkdown(summary, answerTemplateScope),
    );
  } else if (answersStatusMarkdownOutput) {
    process.stdout.write(renderDecisionAnswersStatusMarkdown(summary));
  } else if (backfillPlanMarkdownOutput) {
    process.stdout.write(renderDecisionBackfillPlanMarkdown(summary));
  } else if (backfillPatchMarkdownOutput) {
    process.stdout.write(renderDecisionBackfillPatchMarkdown(summary));
  } else if (workflowBoardMarkdownOutput) {
    process.stdout.write(renderDecisionWorkflowBoardMarkdown(summary));
  } else {
    console.log("Conversation session case coverage audit");
    console.log(
      `main A-J: ${summary.main.cases} cases, ${summary.main.accepted} accepted, ${summary.main.undefined} undefined`,
    );
    for (const line of formalAdmissionAudit.text) {
      console.log(line);
    }
    console.log(
      `coverage: ${summary.coverage.covered} covered, ${summary.coverage.missingAccepted} missing accepted`,
    );
    console.log(
      `automation evidence: ${summary.coverage.automationAbbreviations} abbreviations, ${summary.coverage.referencedAutomationAbbreviations} referenced`,
    );
    console.log(
      `automation spec health: ${summary.coverage.referencedSpecFilesWithTests} with tests, ${summary.coverage.referencedSpecFilesWithSkipOrOnly} with skip/only`,
    );
    console.log(
      `environment: ${summary.environment.productRows} product rows (${summary.environment.newExternalProductCases} new, ${summary.environment.aliasesToMainUndefined} aliases), ${summary.environment.infra} infra`,
    );
    console.log(
      `fault coverage: ${summary.faultCoverage.covered} covered, ${summary.faultCoverage.missingAccepted} missing accepted, ${summary.faultCoverage.decisionNeeded} decision-needed`,
    );
    console.log(
      `decision backlog: ${summary.decisionBacklog.cases}/${summary.decisionBacklog.expected} decision-needed cases listed`,
    );
    console.log(
      `decision E2E roadmap: ${summary.decisionE2ERoadmap.cases}/${summary.decisionE2ERoadmap.expected} non-covered cases planned, ${summary.decisionE2ERoadmap.blockedByProductDecision} blocked-by-product-decision`,
    );
    console.log(
      `decision worksheets: ${summary.decisionWorksheets.cases}/${summary.decisionWorksheets.expected} decision-needed cases covered`,
    );
    console.log(
      `decision protocols: ${summary.decisionProtocols.questions} questions, ${summary.decisionProtocols.unanswered} unanswered`,
    );
    console.log(
      `decision answer draft: ${summary.decisionAnswerDraft.answered}/${summary.decisionAnswerDraft.expectedQuestions} answered, ${summary.decisionAnswerDraft.pending} pending placeholders, ${summary.decisionAnswerDraft.missingQuestions} missing rows`,
    );
    console.log(
      `decision answer readiness: ${summary.decisionAnswerReadiness.readyCases} ready-to-backfill, ${summary.decisionAnswerReadiness.placeholderOnlyCases} placeholder-only, ${summary.decisionAnswerReadiness.partialCases} partial, ${summary.decisionAnswerReadiness.missingCases} missing`,
    );
    console.log(
      `decision backfill workflow: ${summary.decisionBackfillWorkflow.draftReadyCases} draft-ready, ${summary.decisionBackfillWorkflow.worksheetReadyCases} worksheet-ready, ${summary.decisionBackfillWorkflow.worksheetReadyStillDecisionNeededCases} source-backfill-needed`,
    );
    console.log(
      `- compact: ${summary.compactDecisionProtocol.questions} questions, ${summary.compactDecisionProtocol.unanswered} unanswered`,
    );
    console.log(
      `- network/SSE: ${summary.networkSseDecisionProtocol.questions} questions, ${summary.networkSseDecisionProtocol.unanswered} unanswered`,
    );
    console.log(
      `- recovery/isolation: ${summary.recoveryIsolationDecisionProtocol.questions} questions, ${summary.recoveryIsolationDecisionProtocol.unanswered} unanswered`,
    );
    console.log(
      `decision readiness: ${summary.decisionReadiness.readyCases} ready, ${summary.decisionReadiness.blockedCases} blocked`,
    );
    console.log(
      `next review cases: ${summary.decisionReviewQueue.nextCaseIds.join(", ") || "none"}`,
    );
    console.log(
      `generated markdown docs: ${summary.generatedMarkdownDocs.checked} checked, ${summary.generatedMarkdownDocs.staleCount} stale, ${summary.generatedMarkdownDocs.missingCount} missing`,
    );
    console.log(
      `unique product: ${summary.uniqueProduct.total} total, ${summary.uniqueProduct.covered} covered, ${summary.uniqueProduct.decisionNeeded} decision-needed`,
    );
    console.log(
      `completion gate: ${summary.completionGate.covered}/${summary.completionGate.productTotal} covered, ${summary.completionGate.decisionNeeded} decision-needed, required=${summary.completionGate.required ? "yes" : "no"}`,
    );
    if (summary.errors.length > 0) {
      console.error(summary.errors.map((error) => `- ${error}`).join("\n"));
    }
  }

  const rendersFocusedOutput =
    backfillPlanJsonOutput ||
    jsonOutput ||
    reviewQueueScope ||
    answerTemplateScope ||
    answersStatusMarkdownOutput ||
    backfillPlanMarkdownOutput ||
    backfillPatchMarkdownOutput ||
    workflowBoardMarkdownOutput;
  if (rendersFocusedOutput && summary.errors.length > 0) {
    console.error(summary.errors.map((error) => `- ${error}`).join("\n"));
  }

  const exitCode = getCoverageAuditExitCode(check, summary.errors);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

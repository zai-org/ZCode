import React from "react";
import type { ApprovalPrompt } from "./app-model.js";
import { palette } from "./app-model.js";
import { decisionsForApproval } from "./app-approval.js";
import {
  approvalDecisionLabel,
  isOfficialCuaProjectApproval,
  approvalPermissionScopes,
  approvalRequestDescription,
  previewPermissionInput,
} from "./app-approval.js";
import { truncateDisplay, wordWrappedLineCount } from "./app-terminal-width.js";
import { QuestionPanel } from "./app-question-panel.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const APPROVAL_PANEL_CHROME_ROWS = 4;
const APPROVAL_FALLBACK_CONTENT_WIDTH = 80;
const APPROVAL_MIN_CONTENT_WIDTH = 8;
const APPROVAL_PREVIEW_MAX_CELLS = 120;

type ApprovalTextRow = {
  fg: string;
  height: number;
  key: string;
  text: string;
};

/**
 * 审批区：请求不属于当前主会话时（例如 CreateSession 建的后台会话），在面板上方标明来源。
 * 主会话的子代理和 workflow actor 已把 sessionId 改写为主会话，不标注；B 的子代理标注为 B。
 */
export function ApprovalArea({
  approval,
  contentWidth,
  copy,
  mainSessionId,
}: {
  approval: ApprovalPrompt;
  contentWidth?: number;
  copy: ReturnType<typeof import("@zcode/i18n").getZCodeCopy>["tui"];
  mainSessionId?: string;
}): React.ReactElement {
  const originSessionId = approvalOriginSessionId(approval.request.sessionId, mainSessionId);
  return h(
    React.Fragment,
    null,
    originSessionId
      ? h(
          "text",
          { style: { fg: palette.accent, height: 1, width: "100%" } },
          truncateDisplay(
            copy.approval.fromSession(originSessionId),
            normalizeApprovalContentWidth(contentWidth),
          ),
        )
      : null,
    h(ApprovalPanel, { approval, contentWidth }),
  );
}

/** 主会话未知时不猜测来源；只有确定不同才标注。 */
export function approvalOriginSessionId(
  requestSessionId: string,
  mainSessionId: string | undefined,
): string | undefined {
  return mainSessionId && requestSessionId !== mainSessionId ? requestSessionId : undefined;
}

export function ApprovalPanel({
  approval,
  contentWidth,
}: {
  approval: ApprovalPrompt;
  contentWidth?: number;
}): React.ReactElement {
  if (approval.questionState) {
    return h(QuestionPanel, { state: approval.questionState });
  }

  const rowContentWidth = normalizeApprovalContentWidth(contentWidth);
  const rows = approvalRows(approval, rowContentWidth);
  const panelHeight =
    APPROVAL_PANEL_CHROME_ROWS + rows.reduce((height, row) => height + row.height, 0);

  return h(
    "box",
    {
      title: `Approval required: ${approval.request.toolName}`,
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.warning,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        padding: 1,
        width: "100%",
      },
    },
    ...rows.map((row) =>
      h(
        "text",
        {
          key: row.key,
          style: {
            fg: row.fg,
            height: row.height,
            width: "100%",
            wrapMode: "word",
          },
        },
        row.text,
      ),
    ),
  );
}

function approvalRows(approval: ApprovalPrompt, contentWidth: number): ApprovalTextRow[] {
  const rows = [
    approvalTextRow(
      "reason",
      approvalRequestDescription(approval.request),
      palette.warning,
      contentWidth,
    ),
    approvalTextRow(
      "input",
      truncateDisplay(previewPermissionInput(approval.request.input), APPROVAL_PREVIEW_MAX_CELLS),
      palette.muted,
      contentWidth,
    ),
  ];

  for (const [index, scope] of approvalPermissionScopes(approval.request).entries()) {
    rows.push(
      approvalTextRow(
        `scope-${index}`,
        `${scope.kind === "prefix" ? "Command prefix" : "Exact command only"}: ${scope.text}`,
        palette.muted,
        contentWidth,
      ),
    );
  }

  if (isOfficialCuaProjectApproval(approval.request)) {
    rows.push(
      approvalTextRow(
        "computer-use-scope",
        "Do not ask again for official Computer Use actions in this project",
        palette.muted,
        contentWidth,
      ),
    );
  }

  for (const decision of decisionsForApproval(approval.request)) {
    rows.push(
      approvalTextRow(
        decision,
        `${approval.selectedDecision === decision ? ">" : " "} ${approvalDecisionLabel(decision, approval.request)}`,
        approval.selectedDecision === decision ? palette.accent : palette.text,
        contentWidth,
      ),
    );
  }

  rows.push(
    approvalTextRow(
      "help",
      "Up/Down choose, Enter confirms, Esc denies",
      palette.muted,
      contentWidth,
    ),
  );
  return rows;
}

function approvalTextRow(
  key: string,
  text: string,
  fg: string,
  contentWidth: number,
): ApprovalTextRow {
  return {
    fg,
    height: wordWrappedLineCount(text, contentWidth),
    key,
    text,
  };
}

function normalizeApprovalContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return APPROVAL_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(APPROVAL_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

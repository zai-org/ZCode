// 回归：独立 TUI 的审批入口在挂载期间一直有效（会话工具设计 0.5）。
// 原先入口只在单次提交内有效，CreateSession 建的后台会话在发起者回合之外询问时被直接拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import type { PermissionBrokerRequest, PermissionBrokerResult } from "@zcode/contracts";
import { TuiApp } from "../src/app.js";
import { approvalOriginSessionId } from "../src/app-approval-panel.js";
import type { TuiOptions, TuiRequestPermission } from "../src/types.js";

const MAIN = "sess_main";
const BACKGROUND = "sess_background";

function permissionRequest(sessionId: string, file: string): PermissionBrokerRequest {
  return {
    input: { content: "E2E", file_path: file },
    mode: "build",
    reason: "Tool has side effects and requires approval",
    requestedAt: new Date(0),
    requestId: `permission-${file}`,
    riskLevel: "medium",
    ruleId: "mode.build.sideEffect",
    sessionId: sessionId as PermissionBrokerRequest["sessionId"],
    toolCallId: `tool-${file}` as PermissionBrokerRequest["toolCallId"],
    toolName: "Write",
    traceId: "trace-1" as PermissionBrokerRequest["traceId"],
  };
}

test("labels only requests from another session, and never guesses without a main session", () => {
  assert.equal(approvalOriginSessionId(BACKGROUND, MAIN), BACKGROUND);
  assert.equal(approvalOriginSessionId(MAIN, MAIN), undefined);
  assert.equal(approvalOriginSessionId(BACKGROUND, undefined), undefined);
});

test("approvals raised outside any submit show their source session and resolve from the keyboard", async () => {
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  let registered: TuiRequestPermission | undefined;
  let unregistered = 0;
  let submits = 0;
  const options: TuiOptions = {
    getMainSessionId: () => MAIN,
    noColor: true,
    registerPermissionRequester: (requestPermission) => {
      registered = requestPermission;
      return () => {
        unregistered += 1;
      };
    },
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => {
      submits += 1;
      return { response: "done" };
    },
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      { height: 30, kittyKeyboard: true, otherModifiersMode: true, width: 100 },
    );
    await view.renderOnce();
  });

  // React 在 act 结束时才提交状态；先执行动作，再在下一个 act 里绘制。
  const step = async (action: () => unknown) => {
    await act(async () => {
      await action();
    });
    await act(async () => {
      await view!.renderOnce();
    });
  };

  try {
    assert.ok(view && registered);
    await step(() => view!.mockInput.typeText("keep this draft"));

    // 后台会话的询问：没有任何提交在进行。
    let background: Promise<PermissionBrokerResult> | undefined;
    await step(() => {
      background = registered!(permissionRequest(BACKGROUND, "background.txt"));
    });
    let frame = view.captureCharFrame();
    assert.match(frame, /From background session sess_background/);
    assert.match(frame, /Approval required: Write/);

    // 默认选中 Deny；上移两次到 Allow once 再确认。
    await step(() => view!.mockInput.pressArrow("up"));
    await step(() => view!.mockInput.pressArrow("up"));
    await step(() => view!.mockInput.pressEnter());
    const allowed = await background!;
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.permissionUpdates, undefined);

    // 主会话自己的询问不标注来源；Enter 直接确认默认的 Deny。
    let main: Promise<PermissionBrokerResult> | undefined;
    await step(() => {
      main = registered!(permissionRequest(MAIN, "main.txt"));
    });
    frame = view.captureCharFrame();
    assert.match(frame, /Approval required: Write/);
    assert.doesNotMatch(frame, /From background session/);
    await step(() => view!.mockInput.pressEnter());
    assert.equal((await main!).decision, "deny");

    // owner 关闭后台会话时 signal 中止：面板自动移除，请求以取消结束，不留给用户一个失效的询问。
    const controller = new AbortController();
    let cancelled: Promise<PermissionBrokerResult> | undefined;
    await step(() => {
      cancelled = registered!(permissionRequest(BACKGROUND, "cancelled.txt"), {
        signal: controller.signal,
      });
    });
    assert.match(view.captureCharFrame(), /From background session sess_background/);
    // 先挂上拒绝断言再中止，避免拒绝在断言前被当作未处理。
    const rejection = assert.rejects(cancelled!, /Permission request cancelled/);
    await step(() => controller.abort());
    await rejection;
    assert.doesNotMatch(view.captureCharFrame(), /Approval required|From background session/);

    // 审批面板消失后草稿还在，审批没有触发任何提交。
    assert.match(view.captureCharFrame(), /keep this draft/);
    assert.equal(submits, 0);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
  // 卸载即注销，之后的询问回到 fail closed。
  assert.equal(unregistered, 1);
});

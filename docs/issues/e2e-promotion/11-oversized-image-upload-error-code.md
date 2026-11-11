# 超限图片上传提示暴露内部错误码

Status: needs-triage

2026-10-17 转正回放确认。只记录业务缺陷，未修改业务实现。

- 用例：`packages/desktop/test/e2e/conversation-session/attachments/manual-review/pending/conversation-session-oversized-inline-image-attachment.test.ts` 的 T04。
- 复现：在草稿中粘贴一个无本机路径的 21 MiB PNG File。
- 实际：附件进入 `failed`，卡片的可访问提示和重试按钮标题均为“上传失败：oversized-inline-image-attachment”，没有说明图片过大、大小上限或文件名。
- 预期：T04 要求发送前显示图片过大错误，保留正文与附件，不创建用户消息、不发模型请求。
- 根因：`chatAttachmentErrors.ts` 使用内部错误码构造 `OversizedInlineImageAttachmentError`；`v4/composer/useComposerAttachments.ts` 的上传失败分支将错误 message 直接放入 `uploadError`，没有转换为附件大小的本地化提示。
- 运行证据：`pending-promotion-repair-upload-final-1-1-20261016-02001f1247` 的 `E2E_OVERSIZED_ATTACHMENT_STATE` 保留真实 DOM、失败状态和提示文字。同文件 T05 已通过，真实大图片本机路径发送不内联 base64。
- 规格：[附件边界 T04/T05](../../conversation-session-case-catalog.md)。保留原错误语义断言，不接受内部错误码作为面向用户的提示。

验收：同一粘贴操作显示可理解的图片超限提示；发送保持禁用，正文和附件保留，Provider 请求数不增加。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-913-pending-20261019` 的 T04 再次失败，`E2E_OVERSIZED_ATTACHMENT_STATE` 显示附件为 failed，alert 与重试按钮仍显示“上传失败：oversized-inline-image-attachment”。T05 本机路径发送通过。

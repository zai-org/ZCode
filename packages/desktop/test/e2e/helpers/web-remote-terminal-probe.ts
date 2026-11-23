export function buildTerminalProbeCommand(label: string, target: "local" | "linux-ssh"): string {
  // 本地终端可能是 PowerShell，不能依赖 printf/$$；远端 Linux 则不要求安装 Node。
  // 标记在输入中拆开，并在 cwd 之后输出，避免输入回显或旧 cwd 使等待提前完成。
  if (target === "local") {
    return `node -e "console.log('PTY_OWNER='+process.ppid);console.log(process.cwd());console.log('E2E_'+'MRO04_${label}')"`;
  }
  return `printf 'PTY_OWNER=%s\\n' "$$"; pwd; printf 'E2E_%s\\n' 'MRO04_${label}'`;
}

export async function findTerminalScrollbackMarker(root: HTMLElement, marker: string) {
  const viewport = root.querySelector<HTMLElement>(".xterm-viewport");
  const rows = root.querySelector<HTMLElement>(".xterm-rows");
  if (!viewport || !rows || !viewport.clientHeight)
    throw new Error("Terminal viewport unavailable");

  const initialScrollTop = viewport.scrollTop;
  const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
  const step = Math.max(1, Math.floor(viewport.clientHeight / 2));
  let inspected = 1;
  if (rows.textContent?.includes(marker)) {
    return { foundAt: initialScrollTop, initialScrollTop, maxScrollTop, inspected };
  }

  // xterm DOM 只包含当前可见行。重叠读取滚动区，避免跨可见区边界的标记被漏掉。
  try {
    for (let offset = 0; ; offset = Math.min(maxScrollTop, offset + step)) {
      viewport.scrollTop = offset;
      // scroll 事件触发 xterm 刷新；等滚动事件和下一帧的行渲染完成。
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      inspected += 1;
      if (rows.textContent?.includes(marker)) {
        return { foundAt: viewport.scrollTop, initialScrollTop, maxScrollTop, inspected };
      }
      if (offset >= maxScrollTop) break;
    }
    return { foundAt: null, initialScrollTop, maxScrollTop, inspected };
  } finally {
    viewport.scrollTop = initialScrollTop;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }
}

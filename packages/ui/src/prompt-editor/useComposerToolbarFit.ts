import { useLayoutEffect, useRef } from "react";

function toolbarOverflow(root: HTMLElement): number {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return 0;
  const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
  const contentWidth = content.getBoundingClientRect().width;
  const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 12;
  return Math.max(
    0,
    contentWidth - available.getBoundingClientRect().width,
    trailing
      ? contentWidth +
          trailing.getBoundingClientRect().width +
          gap -
          root.getBoundingClientRect().width
      : 0,
  );
}

/**
 * 仅拥有 DOM 布局投影；权限、Plan 和 CUA 业务状态仍由原有 hooks 管理。
 * iconOnly：单行输入框没有固定的工具栏宽度可测，直接按同一顺序收到最后一级（只留图标）。
 */
export function fitComposerToolbar(root: HTMLElement, { iconOnly = false } = {}) {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return;
  const controls = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
  // 每次从完整布局测量，避免各按钮独立 observer 互相抢空间，也覆盖语言与异步入口变化。
  delete root.dataset.composerModelIcon;
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  const overflow = iconOnly ? () => Number.POSITIVE_INFINITY : () => toolbarOverflow(root);
  // 扩展插槽（composer.status）最先收起；之后四档依次收起 Computer、mode、Plan、think 文字，不能合并裁决。
  for (const priority of ["extension", "0", "1", "2", "3"]) {
    if (overflow() <= 0) return;
    for (const control of controls) {
      if (control.dataset.composerCollapsePriority === priority) {
        control.dataset.composerCompact = "true";
      }
    }
  }
  if (overflow() <= 0) return;
  // 合并入口在最后一级仍保留绿条，不进入旧版独立 Think 的去绿条阶段。
  if (root.querySelector("[data-composer-combined-model]")) {
    root.dataset.composerModelIcon = "true";
    return;
  }
  if (root.querySelector(".composer-provider-prefix")) {
    root.dataset.composerProviderCompact = "true";
  }
  if (overflow() <= 0) return;
  const thought = root.querySelector<HTMLElement>("[data-composer-thought-control]");
  if (thought) thought.dataset.composerCompact = "icon";
  // think 去掉绿条后重新测量；只差这点宽度时应保留完整模型名。
  if (overflow() <= 0) return;
  root.dataset.composerModelIcon = "true";
}

export function useComposerToolbarFit({ iconOnly = false } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      if (iconOnly) {
        fitComposerToolbar(root, { iconOnly });
        return;
      }
      if (!root.parentElement || root.getBoundingClientRect().width <= 0) return;
      // 面板动画每次改宽都会通知 observer；完整布局已放得下时，克隆/插入副本只会徒增样式重算。
      // 已有压缩状态必须继续测量完整副本，才能在空间恢复、语言或模型变化时正确展开。
      if (
        !root.dataset.composerModelIcon &&
        !root.dataset.composerProviderCompact &&
        !root.querySelector("[data-composer-compact]") &&
        toolbarOverflow(root) <= 0
      )
        return;
      // 在不可见副本上尝试展开，避免真实按钮测量时来回移动、丢失 hover 或关闭 Tooltip。
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${root.getBoundingClientRect().width}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        fitComposerToolbar(probe);
        for (const key of ["composerModelIcon", "composerProviderCompact"]) {
          if (probe.dataset[key]) root.dataset[key] = probe.dataset[key];
          else delete root.dataset[key];
        }
        const live = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        const measured = probe.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        live.forEach((control, index) => {
          if (measured[index]?.dataset.composerCompact) {
            control.dataset.composerCompact = measured[index].dataset.composerCompact;
          } else delete control.dataset.composerCompact;
        });
      } finally {
        probe.remove();
      }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(root);
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]",
      ))
        resize?.observe(element);
      update();
    };
    // 不观察布局属性自身，防止写 data-composer-compact 引起递归测量。
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
    };
  }, [iconOnly]);
  return ref;
}

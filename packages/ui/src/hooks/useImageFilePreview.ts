import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isImagePreviewPath } from "@/lib/codeViewer.js";
import { parseMarkdownFileLinkTarget, resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";
import { isAbsoluteFilePath } from "@/lib/path.js";
import { logger } from "@/logger.js";

export interface ImageFilePreviewContext {
  workspacePath: string;
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

type PreviewState = { key: string; loading: boolean; error: boolean; src?: string };

/** 从当前 workspace 的 Host 读取原目标，绝不按展示文件名猜路径或调用本机文件 API。 */
export function useImageFilePreview(href: string, context?: ImageFilePreviewContext) {
  const services = useOptionalServices();
  const path = useMemo(() => {
    if (!context) return undefined;
    // 无目录段的显式 href 也是工作区相对目标；只补目标的 ./，绝不改用显示 label。
    const targetHref = !/[\\/:#]/.test(href) ? `./${href}` : href;
    // 原始 mention 没经过 rehype：/data/a.png 就是绝对路径，不能套用
    // Markdown 渲染器把 /a.png 当工作区根相对链接的启发式，否则会读错文件。
    const parsed = parseMarkdownFileLinkTarget(href);
    const target = isAbsoluteFilePath(parsed.path)
      ? parsed
      : resolveMarkdownFileLink(context.workspacePath, targetHref, {
          homePath: context.workspaceHomePath,
        });
    return target && isImagePreviewPath(target.path) ? target.path : undefined;
  }, [href, context?.workspacePath, context?.workspaceHomePath]);
  const workspaceKey = context?.workspaceIdentity?.trim() || context?.workspacePath || "";
  const key = JSON.stringify([workspaceKey, context?.workspaceRemoteSessionId ?? "", path]);
  const sequence = useRef(0);
  const pending = useRef(false);
  const [state, setState] = useState<PreviewState | null>(null);
  useEffect(() => {
    sequence.current += 1;
    pending.current = false;
    setState(null);
    return () => {
      sequence.current += 1;
      pending.current = false;
    };
  }, [key, services]);
  const open = useCallback(async () => {
    if (!path || !services || pending.current) return;
    const request = ++sequence.current;
    pending.current = true;
    setState({ key, loading: true, error: false });
    try {
      // ServiceProvider 已按本地/远端 workspace 绑定 Host；相同 path 不代表相同工作区。
      const result = await services.fileService.readMediaPreview({ path });
      if (request !== sequence.current) return;
      if (!result.mediaType.startsWith("image/")) throw new Error("Not an image preview");
      setState({
        key,
        loading: false,
        error: false,
        src: `data:${result.mediaType};base64,${result.dataBase64}`,
      });
    } catch (error) {
      if (request !== sequence.current) return;
      logger.warn("[ImageFileMention] 图片文件引用预览失败", {
        path,
        workspaceKey,
        error: error instanceof Error ? error.message : String(error),
      });
      setState({ key, loading: false, error: true });
    } finally {
      if (request === sequence.current) pending.current = false;
    }
  }, [key, path, services, workspaceKey]);
  const close = useCallback(() => {
    sequence.current += 1;
    pending.current = false;
    setState(null);
  }, []);
  return {
    available: Boolean(path && services),
    state: state?.key === key ? state : null,
    open,
    close,
  };
}

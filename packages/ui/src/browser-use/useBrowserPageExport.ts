import { useCallback, useRef, useState } from "react";
import {
  canExportBrowserPage,
  exportBrowserPage,
  type BrowserPageExportKind,
} from "@/browser-use/browserPageExport.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * Browser 工具栏「导出为 PNG / PDF」的接线：可用条件、同 tab 互斥与结果提示。
 * 导出本身见 browserPageExport.ts；不改变 guest viewport、预览缩放或滚动位置。
 */
export function useBrowserPageExport({
  currentUrl,
  isReady,
  webview,
}: {
  currentUrl: string;
  isReady: boolean;
  webview: ElectronWebviewTag | null;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [isExporting, setIsExporting] = useState(false);
  const inFlightRef = useRef(false);
  const saveFile = platform.saveFile;
  const captureGuestPage = platform.captureBrowserGuestPage;
  // PNG 取帧与另存为都只有 Desktop 宿主实现；缺任一项时两项一起不出现（Web 端无 <webview>）。
  const canExport = Boolean(
    webview && isReady && saveFile && captureGuestPage && canExportBrowserPage(currentUrl),
  );

  const runExport = useCallback(
    async (kind: BrowserPageExportKind) => {
      if (
        !webview ||
        !saveFile ||
        !captureGuestPage ||
        inFlightRef.current ||
        !canExportBrowserPage(currentUrl)
      )
        return;
      inFlightRef.current = true;
      setIsExporting(true);
      try {
        const result = await exportBrowserPage({ captureGuestPage, kind, saveFile, webview });
        if (result.status === "saved") {
          toast(intl.formatMessage({ id: "browser.export.success" }, { path: result.path }));
        } else if (result.status === "failed") {
          logger.warn("[browser-use] 导出页面失败", { error: result.error, kind });
          toast(intl.formatMessage({ id: "browser.export.failed" }));
        }
      } finally {
        inFlightRef.current = false;
        setIsExporting(false);
      }
    },
    [captureGuestPage, currentUrl, intl, saveFile, webview],
  );

  return {
    canExport,
    exportPdf: useCallback(() => void runExport("pdf"), [runExport]),
    exportPng: useCallback(() => void runExport("png"), [runExport]),
    isExporting,
  };
}

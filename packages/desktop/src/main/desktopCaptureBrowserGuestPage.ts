import type {
  CaptureBrowserGuestPageClip,
  CaptureBrowserGuestPageRequest,
  CaptureBrowserGuestPageResult,
} from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { ipcMain, webContents } from "electron";

/**
 * 同一 guest 的截图请求串行化，与 renderer 侧「导出中」互斥互为兜底。`late` 表示这次已超时返回、
 * 底层 capturePage 还没结算（迟到中）。
 */
const inFlightCaptures = new Map<number, { late: boolean }>();

/** 隐藏/被遮挡的窗口可能永远不出帧；有界等待让 renderer 侧的导出互斥能解锁 */
const CAPTURE_DEADLINE_MS = 15_000;

/**
 * 从发起算起，迟到的取帧最多占住该 guest 这么久。超时后底层 capturePage 还在跑时不叠加新的取帧，
 * 但它可能永不结算（窗口一直隐藏/被遮挡），到点强制释放，否则这个 guest 再也截不了图。
 */
const LATE_CAPTURE_RELEASE_MS = 2 * CAPTURE_DEADLINE_MS;

/**
 * 把 guest CSS px 的裁剪区域换算成实际帧像素。比例取「帧宽 / CSS 视口宽」而不是宿主 DPR：
 * 自由尺寸（DPR 固定 1 但 Retina 原生 surface 是 2x）、Desktop 缩放补偿和 Windows 125% / 150%
 * 小数 DPR 下，帧与 CSS 的比例都可能不等于 screen DPR，只有实测比例在所有情况下一致。
 * 边界向外取整，避免小数 DPR 下元素缺一像素边；超出视口的部分裁掉，完全不可见时返回 null。
 */
export function resolveGuestCaptureCropRect(
  clip: CaptureBrowserGuestPageClip,
  image: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const values = [clip.x, clip.y, clip.width, clip.height, clip.viewportWidth, clip.viewportHeight];
  if (!values.every(Number.isFinite) || clip.viewportWidth <= 0 || clip.viewportHeight <= 0) {
    return null;
  }
  const scaleX = image.width / clip.viewportWidth;
  const scaleY = image.height / clip.viewportHeight;
  const left = Math.max(0, Math.floor(clip.x * scaleX));
  const top = Math.max(0, Math.floor(clip.y * scaleY));
  const right = Math.min(image.width, Math.ceil((clip.x + clip.width) * scaleX));
  const bottom = Math.min(image.height, Math.ceil((clip.y + clip.height) * scaleY));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 内置浏览器「导出为 PNG」与「选元素截图」在 main 取帧。
 * renderer 侧直接调 `<webview>.capturePage()` 会让 renderer 原生崩溃（V8 FATAL，与 Agent 截图
 * 规避的是同一个坑），所以人类用户导出和 Agent 截图一样只能由 main 对 guest webContents 取帧。
 * 只允许嵌入该 guest 的窗口（hostWebContents === sender）发起，防止任意 renderer 截别的窗口。
 */
export function registerDesktopCaptureBrowserGuestPageIpcHandler(logger: {
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(
    PlatformChannels.CaptureBrowserGuestPage,
    async (
      event,
      payload: CaptureBrowserGuestPageRequest,
    ): Promise<CaptureBrowserGuestPageResult> => {
      const guestId = payload?.webContentsId;
      if (typeof guestId !== "number" || !Number.isInteger(guestId) || guestId <= 0) {
        return { success: false, error: "guest_not_found" };
      }
      const guest = webContents.fromId(guestId);
      if (!guest || guest.isDestroyed()) {
        return { success: false, error: "guest_not_found" };
      }
      if (guest.hostWebContents?.id !== event.sender.id) {
        return { success: false, error: "guest_not_owned" };
      }
      const busy = inFlightCaptures.get(guestId);
      if (busy) {
        if (busy.late) {
          logger.warn(
            `[capture-browser-guest-page] 拒绝新的截图：上一次已超时、底层取帧尚未结算 guest=${guestId}`,
          );
        }
        return { success: false, error: "capture_in_progress" };
      }
      const entry = { late: false };
      inFlightCaptures.set(guestId, entry);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let lateRelease: ReturnType<typeof setTimeout> | undefined;
      // 超时只结束这次等待；底层取帧结算（含超时后迟到的那次）之前，同一 guest 继续回 capture_in_progress，
      // 不叠加新的 capturePage。释放来源三选一，先到先放：底层结算（含同步抛错）、guest 销毁、
      // 迟到超过上限强制释放。
      const release = () => {
        if (lateRelease) clearTimeout(lateRelease);
        guest.removeListener("destroyed", release);
        if (inFlightCaptures.get(guestId) === entry) inFlightCaptures.delete(guestId);
      };
      guest.once("destroyed", release);
      const capture = (async () => guest.capturePage())();
      void capture.then(release, release);
      try {
        const image = await Promise.race([
          capture,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("capture_timeout")), CAPTURE_DEADLINE_MS);
          }),
        ]);
        let frame = image;
        if (payload.clip) {
          // 先取整帧再裁：与导出 PNG 同一条已验证的取帧路径，不另走 CDP，也不进入 Agent 截图临界区。
          const crop = resolveGuestCaptureCropRect(payload.clip, image.getSize());
          if (!crop) return { success: false, error: "clip_out_of_view" };
          frame = image.crop(crop);
        }
        const png = frame.toPNG();
        if (png.byteLength === 0) {
          return { success: false, error: "capture_failed" };
        }
        // Buffer 可能是池化视图，切出独立 ArrayBuffer 再走 structured clone
        return { success: true, data: Uint8Array.from(png).buffer };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[capture-browser-guest-page] 截图失败 guest=${guestId} error=${message}`);
        if (message === "capture_timeout" && inFlightCaptures.get(guestId) === entry) {
          entry.late = true;
          lateRelease = setTimeout(() => {
            if (inFlightCaptures.get(guestId) !== entry) return;
            logger.warn(
              `[capture-browser-guest-page] 迟到的取帧超过 ${LATE_CAPTURE_RELEASE_MS}ms 仍未结算，强制释放 guest=${guestId}`,
            );
            release();
          }, LATE_CAPTURE_RELEASE_MS - CAPTURE_DEADLINE_MS);
        }
        return {
          success: false,
          error: message === "capture_timeout" ? "capture_timeout" : "capture_failed",
        };
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    },
  );
}

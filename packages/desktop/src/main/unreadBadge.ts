type AppBadgeSetter = (count: number) => void;

export function parseWindowUnreadCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) {
    return null;
  }

  return payload;
}

// 各窗口汇报的未读数已统一为「全局权威树计数」（侧栏蓝点同源），并非窗口私有值：
// 多窗口时所有窗口上报同一个数，取 max 而不是求和，避免未来放开多主窗口时角标翻倍。
export function maxWindowUnreadCounts(windowUnreadCountMap: ReadonlyMap<number, number>): number {
  let maxUnreadCount = 0;

  for (const unreadCount of windowUnreadCountMap.values()) {
    maxUnreadCount = Math.max(maxUnreadCount, unreadCount);
  }

  return maxUnreadCount;
}

// 应用级 badge：macOS Dock / Linux LauncherEntry。spec 见 docs/desktop/windows-taskbar-unread-badge.md
export function supportsAppUnreadBadge(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

// Windows 的 app.setBadgeCount 是 no-op，任务栏角标要走窗口级 overlay（setOverlayIcon）。
export function supportsWindowOverlayBadge(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

// 任务栏 overlay 图由主进程自绘，只认字符串文案；0 返回 null 表示移除角标。
export function resolveBadgeOverlayLabel(totalUnreadCount: number): string | null {
  if (!Number.isInteger(totalUnreadCount) || totalUnreadCount <= 0) {
    return null;
  }

  return totalUnreadCount > 9 ? "9+" : String(totalUnreadCount);
}

export function syncUnreadBadgeForPlatform(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
  applyOverlay: (label: string | null) => void;
}): void {
  if (supportsAppUnreadBadge(options.platform)) {
    options.setBadgeCount(options.totalUnreadCount);
    return;
  }

  if (supportsWindowOverlayBadge(options.platform)) {
    options.applyOverlay(resolveBadgeOverlayLabel(options.totalUnreadCount));
  }
}

// ---- Windows 任务栏 overlay 徽章图（纯像素渲染，不依赖 electron，便于单测）----

// overlay 在 100% DPI 下显示为 16×16，提供 32×32 让高 DPI 缩放后仍清晰。
export const TASKBAR_BADGE_IMAGE_SIZE = 32;

const BADGE_CIRCLE_COLOR = { red: 229, green: 57, blue: 53 } as const;
const BADGE_TEXT_COLOR = { red: 255, green: 255, blue: 255 } as const;

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_SCALE = 2;

// 画布四周的透明边距：系统把整张图缩放铺满 overlay 槽位，边距让气泡本体只占约 3/4，
// 避免 16×16 实际显示时观感过大压住应用图标。
const BADGE_PADDING = 3;

// 5×7 点阵字体，每行 5 bit，最高位在左；只覆盖角标会用到的字符。
const BADGE_FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  "+": [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
};

export type BadgePixelOptions = {
  size?: number;
  glyphScale?: number;
  padding?: number;
  /** 纯色圆点模式（托盘用）：16px 显示尺寸下数字不可读，只画圆不画数字。 */
  dot?: boolean;
  /**
   * 圆点锚点。center 为画布中心（托盘合成用）；bottom-right 把圆心锚到画布
   * 右下角（任务栏 overlay 用）——overlay 整图铺在图标右下区域，点画在画布
   * 中心会悬在图标中部，只有锚住右下角才呈现"图标角标"的观感。
   */
  anchor?: "center" | "bottom-right";
};

// 输出预乘 alpha 的 BGRA（与 Electron toBitmap / createFromBitmap 契约一致）：
// 圆内完全不透明（预乘不改变通道值），圆外全透明，不遮挡底图。
export function renderTaskbarBadgePixels(
  label: string,
  options: BadgePixelOptions = {},
): Uint8Array {
  const size = options.size ?? TASKBAR_BADGE_IMAGE_SIZE;
  const glyphScale = options.glyphScale ?? GLYPH_SCALE;
  const padding = options.padding ?? BADGE_PADDING;
  const glyphSpacing = glyphScale;
  const pixels = new Uint8Array(size * size * 4);
  const glyphs = options.dot
    ? []
    : [...label]
        .map((character) => BADGE_FONT[character])
        .filter((glyph): glyph is number[] => Array.isArray(glyph));
  if (glyphs.length === 0 && !options.dot) {
    return pixels;
  }

  const glyphWidth = GLYPH_WIDTH * glyphScale;
  const glyphHeight = GLYPH_HEIGHT * glyphScale;
  const totalWidth = glyphs.length * glyphWidth + (glyphs.length - 1) * glyphSpacing;
  const originX = Math.round((size - totalWidth) / 2);
  const originY = Math.round((size - glyphHeight) / 2);
  const radius = Math.max(1, (size - padding * 2) / 2 - 1);
  const radiusSquared = radius * radius;
  // 右下锚定留 2px 安全边：贴到只剩 1px 时 Windows 缩放采样会吃掉最外圈像素，
  // 实拍观感像圆被咬掉一块。
  const anchorMargin = 2;
  const center =
    options.anchor === "bottom-right"
      ? { x: size - radius - anchorMargin, y: size - radius - anchorMargin }
      : { x: (size - 1) / 2, y: (size - 1) / 2 };

  const isGlyphPixel = (x: number, y: number): boolean => {
    for (let index = 0; index < glyphs.length; index += 1) {
      const localX = x - originX - index * (glyphWidth + glyphSpacing);
      const localY = y - originY;
      if (localX < 0 || localX >= glyphWidth || localY < 0 || localY >= glyphHeight) {
        continue;
      }

      const glyph = glyphs[index];
      if (!glyph) {
        continue;
      }

      const row = glyph[Math.floor(localY / glyphScale)];
      const column = Math.floor(localX / glyphScale);
      if (row !== undefined && ((row >> (GLYPH_WIDTH - 1 - column)) & 1) === 1) {
        return true;
      }
    }

    return false;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offsetX = x - center.x;
      const offsetY = y - center.y;
      if (offsetX * offsetX + offsetY * offsetY > radiusSquared) {
        continue;
      }

      const color = isGlyphPixel(x, y) ? BADGE_TEXT_COLOR : BADGE_CIRCLE_COLOR;
      const offset = (y * size + x) * 4;
      pixels[offset] = color.blue;
      pixels[offset + 1] = color.green;
      pixels[offset + 2] = color.red;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}

export interface AntialiasedDotOptions {
  size: number;
  centerX: number;
  centerY: number;
  radius: number;
  supersample?: number;
}

/** 4× 超采样的纯红预乘 BGRA 圆点；任务栏 overlay 使用。 */
export function renderAntialiasedStatusDotPixels(
  options: AntialiasedDotOptions,
): Uint8Array {
  const supersample = options.supersample ?? 4;
  const pixels = new Uint8Array(options.size * options.size * 4);
  const samplesPerPixel = supersample * supersample;

  for (let y = 0; y < options.size; y += 1) {
    for (let x = 0; x < options.size; x += 1) {
      let coveredSamples = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const sampleX = x + (sx + 0.5) / supersample;
          const sampleY = y + (sy + 0.5) / supersample;
          const dx = sampleX - options.centerX;
          const dy = sampleY - options.centerY;
          if (dx * dx + dy * dy <= options.radius * options.radius) coveredSamples += 1;
        }
      }

      if (coveredSamples === 0) continue;
      const coverage = coveredSamples / samplesPerPixel;
      const offset = (y * options.size + x) * 4;
      // 预乘 alpha：抗锯齿边缘保持同一红色，不与底图混成白边或脏边。
      pixels[offset] = Math.round(BADGE_CIRCLE_COLOR.blue * coverage);
      pixels[offset + 1] = Math.round(BADGE_CIRCLE_COLOR.green * coverage);
      pixels[offset + 2] = Math.round(BADGE_CIRCLE_COLOR.red * coverage);
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }

  return pixels;
}

/**
 * Windows taskbar overlay 固定显示 16×16。直接把硬边 32px 圆交给 Shell 缩放会产生
 * 模糊/缺口；这里在目标尺寸上超采样，生成纯红色、抗锯齿的预乘 BGRA 圆点。
 * scale=1 产出原生 16px 表示，scale=2 产出 32px 高 DPI 表示。
 */
export type TaskbarOverlayLayout = "windows-10" | "windows-11";

export function renderTaskbarStatusDotPixels(
  scale: 1 | 2 = 1,
  layout: TaskbarOverlayLayout = "windows-11",
): Uint8Array {
  // 两代 Windows Shell 对 16×16 overlay 的任务栏落点不同：
  // Win10 需要画布内右下锚定；Win11 已把整张 overlay 放到图标角上，需画布内居中，
  // 否则形成二次偏移。一个固定圆心无法同时匹配两代任务栏。
  const center = layout === "windows-10" ? 11.25 : 8;
  return renderAntialiasedStatusDotPixels({
    size: 16 * scale,
    centerX: center * scale,
    centerY: center * scale,
    radius: 3.5 * scale,
  });
}

// 只要求"有任务栏按钮的窗口"能力，方便单测注入假窗口；
// skipTaskbar 窗口（CUA 指示器等）设置 overlay 无副作用，不必逐一排除。
export type TaskbarOverlayWindow = {
  isDestroyed(): boolean;
  setOverlayIcon(overlay: unknown, description: string): void;
};

export function applyTaskbarOverlayToWindows(options: {
  label: string | null;
  windows: Iterable<TaskbarOverlayWindow>;
  badgeImageForLabel: (label: string) => unknown;
}): void {
  const image = options.label ? options.badgeImageForLabel(options.label) : null;
  const description = options.label ? `${options.label} unread tasks` : "";

  for (const win of options.windows) {
    if (win.isDestroyed()) {
      continue;
    }

    win.setOverlayIcon(image, description);
  }
}

// 角标只在任务完成/查看任务时变化，更新频率为事件级；徽章图按 label 缓存避免重复渲染。
// electron 侧（BrowserWindow.getAllWindows / nativeImage.createFromBitmap）由 desktopWindowLifecycle 注入。
export function createWindowsTaskbarOverlayApplier(deps: {
  getAllWindows: () => Iterable<TaskbarOverlayWindow>;
  createBadgeImage: (label: string) => unknown;
}): (label: string | null) => void {
  const badgeImageCache = new Map<string, unknown>();

  return (label) => {
    applyTaskbarOverlayToWindows({
      label,
      windows: deps.getAllWindows(),
      badgeImageForLabel: (cachedLabel) => {
        const cachedImage = badgeImageCache.get(cachedLabel);
        if (cachedImage) {
          return cachedImage;
        }

        const image = deps.createBadgeImage(cachedLabel);
        badgeImageCache.set(cachedLabel, image);
        return image;
      },
    });
  };
}

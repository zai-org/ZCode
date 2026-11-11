import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { normalizeThemePreference, resolveTheme } from "@/useTheme.js";
import type { Theme } from "@/useTheme.js";

interface ThemeHeroPalette {
  panel: string;
  meshBase: string;
  meshLight: string;
  glowPrimary: string;
  glowSecondary: string;
  heading: string;
  description: string;
}

function getThemeHeroPalette(theme: Theme): ThemeHeroPalette {
  switch (theme) {
    case "light":
      return {
        meshBase: "#eff6ff",
        meshLight: "#7dd3fc",
        panel:
          "bg-[linear-gradient(180deg,#eff6ff_0%,#dbeafe_34%,#bfdbfe_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(255,255,255,0.9),transparent_24%),radial-gradient(circle_at_82%_16%,rgba(125,211,252,0.42),transparent_26%),radial-gradient(circle_at_68%_80%,rgba(96,165,250,0.24),transparent_28%)]",
        glowPrimary: "bg-sky-200/70 mix-blend-screen",
        glowSecondary: "bg-blue-200/70 mix-blend-multiply",
        heading: "text-slate-900",
        description: "text-slate-700/80",
      };
    case "zai-light":
      return {
        meshBase: "#f8f8f8",
        meshLight: "#80beff",
        panel:
          "bg-[linear-gradient(180deg,#ffffff_0%,#f8f8f8_42%,#ebf4ff_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_20%,rgba(255,255,255,0.9),transparent_24%),radial-gradient(circle_at_82%_14%,rgba(11,127,255,0.2),transparent_26%),radial-gradient(circle_at_70%_84%,rgba(128,190,255,0.2),transparent_30%)]",
        glowPrimary: "bg-[#80BEFF]/45 mix-blend-multiply",
        glowSecondary: "bg-[#EBF4FF]/80 mix-blend-multiply",
        heading: "text-[#0D0D0D]",
        description: "text-[#5C5C5C]",
      };
    case "zai-dark":
      return {
        meshBase: "#001d3d",
        meshLight: "#80beff",
        panel:
          "bg-[linear-gradient(180deg,#161616_0%,#202020_42%,#001d3d_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(64,153,255,0.18),transparent_24%),radial-gradient(circle_at_82%_12%,rgba(128,190,255,0.2),transparent_26%),radial-gradient(circle_at_66%_84%,rgba(153,199,255,0.16),transparent_28%)]",
        glowPrimary: "bg-[#4099FF]/22 mix-blend-screen",
        glowSecondary: "bg-[#80BEFF]/16 mix-blend-screen",
        heading: "text-[#F8F8F8]",
        description: "text-[#ADADAD]",
      };
    case "dark":
    case "system":
    default:
      return {
        meshBase: "#060816",
        meshLight: "#60a5fa",
        panel:
          "bg-[linear-gradient(180deg,#060816_0%,#0b1333_38%,#12245a_72%,#173474_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_16%_20%,rgba(165,243,252,0.14),transparent_22%),radial-gradient(circle_at_82%_14%,rgba(96,165,250,0.18),transparent_24%),radial-gradient(circle_at_68%_84%,rgba(56,189,248,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]",
        glowPrimary: "bg-cyan-300/22 mix-blend-screen",
        glowSecondary: "bg-blue-400/18 mix-blend-screen",
        heading: "text-slate-50",
        description: "text-slate-200/72",
      };
  }
}

export function useResolvedThemeHeroPalette(): ThemeHeroPalette {
  const theme = useZCodeStore((state) => state.theme);
  // 主题存储可能是旧值 light/dark，但实际应用的是 Zai Light/Zai Dark；
  // 背景调色板必须跟实际主题一致，否则登录页会出现蓝色渐变与页面主题不匹配。
  const appliedTheme =
    theme === "system"
      ? resolveTheme(theme) === "dark"
        ? "zai-dark"
        : "zai-light"
      : normalizeThemePreference(theme);

  return getThemeHeroPalette(appliedTheme);
}

export function ThemeHeroVisual(props: {
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
}) {
  const palette = useResolvedThemeHeroPalette();

  return (
    <div className={cn("relative overflow-hidden", palette.panel, props.className)}>
      <div
        className={cn(
          "pointer-events-none absolute left-[-12%] top-[18%] h-[42rem] w-[42rem] rounded-full blur-3xl",
          palette.glowPrimary,
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute right-[-18%] bottom-[-14%] h-[36rem] w-[36rem] rounded-full blur-3xl",
          palette.glowSecondary,
        )}
      />
      {props.children ? (
        <div className={cn("relative z-10", props.contentClassName)}>{props.children}</div>
      ) : null}
    </div>
  );
}

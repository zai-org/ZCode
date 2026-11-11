import {
  ActivityIcon,
  BellIcon,
  BotIcon,
  ChartBarIcon,
  ChartPieIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  EyeIcon,
  FileTextIcon,
  GaugeIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  LayersIcon,
  ListIcon,
  LogInIcon,
  LogOutIcon,
  MessageSquareIcon,
  PuzzleIcon,
  SparklesIcon,
  TerminalIcon,
  TimerIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * 扩展可用的 Lucide 图标白名单（DESIGN.md「Extension slots」）。清单里写图标名；
 * 不在白名单里的名字显示通用插件图标，壳层不渲染插件提供的 SVG。
 */
const EXTENSION_ICONS: Readonly<Record<string, LucideIcon>> = {
  activity: ActivityIcon,
  bell: BellIcon,
  bot: BotIcon,
  "chart-bar": ChartBarIcon,
  "chart-pie": ChartPieIcon,
  "pie-chart": ChartPieIcon,
  clock: ClockIcon,
  cpu: CpuIcon,
  database: DatabaseIcon,
  eye: EyeIcon,
  "file-text": FileTextIcon,
  gauge: GaugeIcon,
  "git-branch": GitBranchIcon,
  // GitLab 示例插件（docs/plugins/extension-host.md §18.1 H4）：MR、合并、登录与退出。
  "git-merge": GitMergeIcon,
  "git-pull-request": GitPullRequestIcon,
  globe: GlobeIcon,
  info: InfoIcon,
  layers: LayersIcon,
  list: ListIcon,
  "log-in": LogInIcon,
  "log-out": LogOutIcon,
  "message-square": MessageSquareIcon,
  puzzle: PuzzleIcon,
  sparkles: SparklesIcon,
  terminal: TerminalIcon,
  timer: TimerIcon,
  zap: ZapIcon,
};

export function resolveExtensionIcon(name: string | undefined): LucideIcon {
  return (name && EXTENSION_ICONS[name]) || PuzzleIcon;
}

import { useEffect, useRef, type CSSProperties } from "react";
import {
  BASE_EXPRESSION,
  faceState,
  startFaceMotion,
} from "@/components/workflow-timeline/workflow-face-motion.js";
export { faceState } from "@/components/workflow-timeline/workflow-face-motion.js";
import { cn } from "@/components/lib/utils.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

/**
 * 瓦片脸：应用图标的圆角方块去掉 Z、
 * 加上两只眼。子代理的头像就是它——药丸、名册格、侧栏折叠头像串共用这一张脸。
 *
 * 身份是机身色：九个固定 HEX 颜色按 `avatarIndex` 取，第十个起循环；没有编号退回名字散列。
 * 状态定义基础表情，独立随机动作仅更新 SVG 属性。
 */
export const FACE_COLORS = [
  "#54B9A6",
  "#F19D38",
  "#6464EF",
  "#885CF5",
  "#3C82F6",
  "#ED712E",
  "#EB4699",
  "#5BC67A",
  "#EA4045",
] as const;

/** 名字散列选色（31 进制取模 360 后映射到九色板）；只在没有 `avatarIndex` 时兜底。 */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return FACE_COLORS[hash % FACE_COLORS.length]!;
}

/** 代理的颜色：编号优先（九色环循环），缺席时退回名字散列。药丸悬停描边与脸共用它。 */
export function agentColor(avatarIndex: number | undefined, name: string): string {
  if (avatarIndex === undefined) return avatarColor(name);
  return FACE_COLORS[
    ((avatarIndex % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length
  ]!;
}

const EXPRESSIONS = ["pill", "happy", "sleepy", "focused", "sad", "confused"] as const;

// 直接在 20 格内绘制参考眼型；共享左右起点，换脸时保持底部和视线位置。
function Eyes() {
  return (
    <g className="wf-face-eyes">
      <g className="wf-face-bounce">
        <g className="wf-face-lids">
          <g data-eye-expression="dots" fill="var(--wf-face-eye)">
            {[5, 10, 15].map((cx) => (
              <circle key={cx} cx={cx} cy={10} r={1.5} />
            ))}
          </g>
          {EXPRESSIONS.map((expression) => (
            <g key={expression} data-eye-expression={expression} fill="var(--wf-face-eye)">
              {[7, 13].map((x, i) => {
                if (expression === "pill" || expression === "confused") {
                  const short = expression === "confused" && i === 1;
                  return (
                    <rect key={x} x={x} y={short ? 8 : 6} width={4} height={short ? 4 : 6} rx={2} />
                  );
                }
                const paths = {
                  happy: "M0 11 V8 A2 2 0 0 1 4 8 V11 Z",
                  sleepy:
                    i === 0 ? "M0 8 L4 7 V9 A2 2 0 0 1 0 9 Z" : "M0 7 L4 8 V9 A2 2 0 0 1 0 9 Z",
                  focused:
                    i === 0 ? "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z" : "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z",
                  sad:
                    i === 0 ? "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z" : "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z",
                };
                return <path key={x} transform={`translate(${x} 0)`} d={paths[expression]} />;
              })}
            </g>
          ))}
        </g>
        {/* 闭眼单独画横胶囊，避免纵向缩放把端部圆角压成细线。 */}
        <g className="wf-face-closed" fill="var(--wf-face-eye)">
          {[7, 13].map((x) => (
            <rect key={x} x={x} y={8} width={4} height={2} rx={1} />
          ))}
        </g>
      </g>
    </g>
  );
}

export function WorkflowAgentFace({
  avatarIndex,
  className,
  name,
  status,
  idle = false,
  showCompletionMark = false,
  color,
}: {
  avatarIndex: number | undefined;
  className?: string;
  name: string;
  status: StepRunStatus | undefined;
  idle?: boolean;
  showCompletionMark?: boolean;
  color?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const state = idle ? "idle" : faceState(status);
  useEffect(() => {
    if (ref.current && !showCompletionMark) return startFaceMotion(ref.current, state);
  }, [state, showCompletionMark]);
  const style = { "--wf-face-body": color ?? agentColor(avatarIndex, name) } as CSSProperties;
  return (
    <svg
      aria-hidden
      className={cn("wf-face overflow-visible", className)}
      data-face-state={state}
      data-expression={BASE_EXPRESSION[state]}
      data-motion="idle"
      data-subagent-avatar
      ref={ref}
      style={style}
      viewBox="0 0 20 20"
    >
      <rect className="wf-face-body" fill="var(--wf-face-body)" height={20} rx={7} width={20} />
      <Eyes />
      {showCompletionMark ? (
        // 完成徽标向左下角外叠；历史折叠容器为其保留绘制空间，不移动头像或遮挡眼睛。
        <g data-subagent-completion-badge>
          <circle
            cx={3}
            cy={17}
            r={5.5}
            fill="var(--color-success)"
            stroke="var(--color-background)"
            strokeWidth={1.5}
          />
          <path
            d="m0.5 17 1.7 1.7 3.3-3.4"
            fill="none"
            stroke="var(--color-success-foreground)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ) : null}
    </svg>
  );
}

/** 集合入口不代表单个代理，使用同款静态中性头像。 */
export function SubagentCollectionIcon({ className }: { className?: string }) {
  return (
    <WorkflowAgentFace
      avatarIndex={undefined}
      name=""
      status={undefined}
      idle
      color="var(--color-foreground-subtle)"
      className={className}
    />
  );
}

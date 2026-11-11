import type { StepRunStatus } from "@/components/workflow-graph/types.js";

export type FaceState = "idle" | "waiting" | "scanning" | "content" | "sad";
export type EyeExpression = "dots" | "pill" | "happy" | "sleepy" | "focused" | "sad" | "confused";
export function faceState(status: StepRunStatus | undefined): FaceState {
  return status === "running"
    ? "scanning"
    : status === "done"
      ? "content"
      : status === "failed"
        ? "sad"
        : "waiting";
}
export const BASE_EXPRESSION: Record<FaceState, EyeExpression> = {
  idle: "pill",
  waiting: "dots",
  scanning: "pill",
  content: "happy",
  sad: "sad",
};
const SPECIAL: Record<FaceState, readonly EyeExpression[]> = {
  idle: [],
  scanning: ["focused", "confused"],
  waiting: [],
  content: [],
  sad: [],
};

/** 一张脸只有一个待执行计时器；DOM 动作不触发整个工作流的 React 重渲染。 */
export function startFaceMotion(face: SVGSVGElement, state: FaceState): () => void {
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = true;
  let rounds = 0;
  let lookingLeft = false;
  let previous: EyeExpression | undefined;
  const random = (min: number, max: number) => min + Math.random() * (max - min);
  const later = (delay: number, action: () => void) => {
    timer = setTimeout(action, delay);
  };
  const motion = (value: string) => {
    face.dataset.motion = value;
  };
  const base = () => {
    face.dataset.expression = BASE_EXPRESSION[state];
    motion("idle");
    face.style.setProperty("--wf-face-x", "0px");
    face.style.setProperty("--wf-face-y", state === "sad" ? "0.3px" : "0px");
  };
  const pause = () => {
    motion("idle");
    later(
      state === "waiting"
        ? random(1500, 3000)
        : state === "scanning"
          ? random(1000, 2000)
          : state === "sad"
            ? random(1800, 4000)
            : random(6000, 10000),
      cycle,
    );
  };
  // 闭眼时换轮廓，避免从圆眼直接跳到斜切眼；返回基础表情也使用同样的过渡。
  const morph = (expression: EyeExpression, next: () => void) => {
    motion("morph");
    later(80, () => {
      face.dataset.expression = expression;
      later(100, () => {
        motion("idle");
        next();
      });
    });
  };
  const maybeExpression = () => {
    // 设置页的空闲头像只眨眼和巡视，不借用执行状态或随机切换任务表情。
    if (state === "idle") {
      pause();
      return;
    }
    rounds++;
    const probability = state === "scanning" ? 0.45 : 0.25;
    if (rounds < 2 || Math.random() >= probability) {
      pause();
      return;
    }
    const choices = SPECIAL[state].filter((e) => e !== previous);
    // 只有一种偶发表情的结果态也要经过两轮基础动作，不能连续换脸。
    const pool = choices.length ? choices : SPECIAL[state];
    const expression = pool[Math.floor(Math.random() * pool.length)]!;
    previous = expression;
    rounds = 0;
    const hold = expression === "confused" ? random(2200, 3800) : random(800, 1800);
    morph(expression, () => later(hold, () => morph(BASE_EXPRESSION[state], pause)));
  };
  const glance = () => {
    motion("glance");
    // 平移要换到脸的另一侧；旧的 ±0.65 微移只像眼睛抖动，看不出左右驻留。
    lookingLeft = !lookingLeft;
    face.style.setProperty("--wf-face-x", lookingLeft ? "-4px" : "0px");
    later(360, maybeExpression);
  };
  function cycle() {
    if (state === "waiting") {
      motion("dots-wave");
      later(900, pause);
      return;
    }
    if (state === "sad") {
      const floats = Math.random() < 0.5 ? 1 : 2;
      face.style.setProperty("--wf-face-floats", String(floats));
      motion("float");
      later(floats * 600, () => {
        if (Math.random() >= 0.4) {
          pause();
          return;
        }
        morph("focused", () => {
          const shakes = 3 + Math.floor(Math.random() * 3);
          face.style.setProperty("--wf-face-shakes", String(shakes));
          motion("shake");
          later(shakes * 90, () => {
            motion("idle");
            later(random(500, 1000), () => morph("sad", pause));
          });
        });
      });
      return;
    }
    if (state === "content") {
      const hops = Math.random() < 0.5 ? 2 : 3;
      face.style.setProperty("--wf-face-hops", String(hops));
      motion("hop");
      later(hops * 240, () => {
        face.dataset.expression = "pill";
        motion("idle");
        later(250, () => {
          const duration = random(260, 320);
          face.style.setProperty("--wf-face-blinks", "1");
          face.style.setProperty("--wf-face-blink-time", `${duration}ms`);
          motion("blink");
          later(duration, () => {
            face.dataset.expression = "happy";
            pause();
          });
        });
      });
    } else {
      const blinks = Math.random() < 0.5 ? 2 : 3;
      const duration = state === "scanning" ? random(200, 260) : random(260, 320);
      face.style.setProperty("--wf-face-blinks", String(blinks));
      face.style.setProperty("--wf-face-blink-time", `${duration}ms`);
      motion("blink");
      later(duration * blinks, glance);
    }
  }
  const restart = () => {
    clearTimeout(timer);
    timer = undefined;
    rounds = 0;
    lookingLeft = false;
    base();
    if (!document.hidden && !media?.matches && visible) later(random(1200, 2800), cycle);
  };
  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          const next = entries[0]?.isIntersecting ?? true;
          if (next !== visible) {
            visible = next;
            restart();
          }
        });
  observer?.observe(face);
  document.addEventListener("visibilitychange", restart);
  media?.addEventListener?.("change", restart);
  restart();
  return () => {
    clearTimeout(timer);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", restart);
    media?.removeEventListener?.("change", restart);
    base();
  };
}

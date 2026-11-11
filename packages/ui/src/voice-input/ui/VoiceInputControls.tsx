import { memo, useEffect, useState } from "react";
import { MicIcon } from "lucide-react";
import {
  TID_V4_COMPOSER_VOICE_INPUT,
  TID_V4_COMPOSER_VOICE_WAVEFORM,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ComposerVoiceInput, VoiceInputState } from "@/voice-input/contract.js";

const TITLE_IDS: Record<VoiceInputState, string> = {
  idle: "voiceInput.button.start",
  requesting: "voiceInput.button.connecting",
  recording: "voiceInput.button.stop",
  finishing: "voiceInput.button.recognizing",
};

// 10 根 3px 竖条、4px 间距，加左右内边距约 82px，不超过按钮（28px）的 3 倍。
const DOT_COUNT = 10;
const SILENT_LEVELS: readonly number[] = Array.from({ length: DOT_COUNT }, () => 0);

/** 峰值电平 → 0..1：-50 dBFS 以下为 0，-10 dBFS 以上为 1。 */
function levelOf(peak: number): number {
  if (peak <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(peak) + 50) / 40));
}

/**
 * 音量波形：每根竖条是一个 100ms 音频块的峰值，新数据从右侧进入；静音时是 3px 圆点。
 * 颜色取 DESIGN.md 的 Voice Input Recording token（sky 色系），两套主题各自适配。
 * 只在本组件内更新状态，Composer 不随音量重新渲染。
 */
const VoiceInputWaveform = memo(function VoiceInputWaveform(props: {
  active: boolean;
  subscribeLevel: ComposerVoiceInput["subscribeLevel"];
}) {
  const { active, subscribeLevel } = props;
  const [levels, setLevels] = useState(SILENT_LEVELS);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = subscribeLevel((peak) =>
      setLevels((previous) => [...previous.slice(1), levelOf(peak)]),
    );
    return () => {
      unsubscribe();
      setLevels(SILENT_LEVELS);
    };
  }, [active, subscribeLevel]);
  return (
    <span
      aria-hidden
      data-testid={TID_V4_COMPOSER_VOICE_WAVEFORM}
      data-voice-active-dots={levels.filter((level) => level > 0).length}
      className="flex h-3.5 items-center gap-1 pr-1 pl-3"
    >
      {levels.map((level, index) => (
        <span
          key={index}
          className="w-0.75 rounded-full bg-voice-input-wave transition-[height] duration-100 ease-out motion-reduce:transition-none"
          style={{ height: `${3 + 11 * level}px` }}
        />
      ))}
    </span>
  );
});

/**
 * Composer 右侧工具栏的语音输入入口，位于发送 / 停止按钮左侧。
 * 空闲时是麦克风按钮；录音中扩展为浅蓝胶囊：左侧蓝色波形，右侧蓝色停止方块（sky 色系 token）。
 * 外层容器始终渲染，按钮不会因状态切换重新挂载，键盘焦点保持在按钮上。
 * 展开动画：波形外层是单列 grid，列宽从 0fr 过渡到 1fr，胶囊从按钮向左展开，
 * 同时底色和透明度渐入（200ms ease-out）。左侧模型选择随宽度平滑左移，不跳动。
 */
export const VoiceInputButton = memo(function VoiceInputButton(props: {
  state: VoiceInputState;
  onToggle: () => void;
  subscribeLevel: ComposerVoiceInput["subscribeLevel"];
}) {
  const { intl } = useZCodeIntl();
  const title = intl.formatMessage({ id: TITLE_IDS[props.state] });
  const active = props.state !== "idle";
  return (
    <span
      className={
        "flex shrink-0 items-center rounded-full transition-colors duration-200 ease-out motion-reduce:transition-none " +
        (active ? "bg-voice-input-surface" : "")
      }
    >
      <span
        data-voice-pill-expanded={active}
        className={
          "grid transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none " +
          (active ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0")
        }
      >
        <span className="min-w-0 overflow-hidden">
          {active ? (
            <VoiceInputWaveform
              active={props.state === "recording"}
              subscribeLevel={props.subscribeLevel}
            />
          ) : null}
        </span>
      </span>
      <ControlHintTooltip title={title}>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          data-testid={TID_V4_COMPOSER_VOICE_INPUT}
          data-voice-state={props.state}
          aria-label={title}
          aria-pressed={active}
          // 识别中等待服务端结果，不响应点击；用 aria-disabled 保留 hover 提示。
          aria-disabled={props.state === "finishing" || undefined}
          // 按下按钮不抢走输入框焦点：语音文字写在原光标处，用户也能直接继续打字来停止语音输入。
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.state === "finishing" ? undefined : props.onToggle}
          className="shrink-0 rounded-full"
        >
          {props.state === "idle" ? (
            <MicIcon className="size-4" />
          ) : props.state === "recording" ? (
            <span className="size-2.5 rounded-[3px] bg-voice-input-wave" />
          ) : (
            <Spinner className="size-4" />
          )}
          <span className="sr-only">{title}</span>
        </Button>
      </ControlHintTooltip>
    </span>
  );
});

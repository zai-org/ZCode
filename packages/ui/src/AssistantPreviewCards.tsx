import { FileTextIcon, GlobeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  type AssistantPreviewCard,
  type AssistantPreviewCardFileStatService,
  type AssistantPreviewCardsAutoOpenRequest,
  getAssistantPreviewCardFilePath,
  shouldOpenAssistantHtmlInBrowser,
} from "@/lib/assistantPreviewCards.js";
import {
  getAssistantPreviewCardsValidationSignature,
  resolveAssistantPreviewCardsWithoutFileStat,
  resolveValidatedAssistantPreviewCards,
} from "@/lib/assistantPreviewCardValidation.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";

export interface AssistantPreviewCardValidationResult {
  visibleCards: AssistantPreviewCard[];
  settled: boolean;
}

export function buildAssistantPreviewCardFileSource(
  card: Extract<AssistantPreviewCard, { type: "markdown" | "file" }>,
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
): CodeViewerSource {
  return {
    type: "file",
    title: card.title,
    path: card.path,
    ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}),
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: scope.workspaceRemoteSessionId }
      : {}),
  };
}

export function buildAssistantPreviewPptxAutoOpenRequest(
  visibleCards: readonly AssistantPreviewCard[],
  baseKey: string,
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  },
): AssistantPreviewCardsAutoOpenRequest | null {
  const pptxCards = visibleCards.filter(
    (card): card is Extract<AssistantPreviewCard, { type: "file" }> =>
      card.type === "file" && card.kind === "pptx",
  );
  if (pptxCards.length === 0) return null;

  return {
    // stat 结果对应的最终卡片签名必须进入一次性 key；同一 turn 的候选若晚到，
    // 不会把旧的校验投影误当成已经消费的新结果。
    key: JSON.stringify([baseKey, getAssistantPreviewCardsValidationSignature(pptxCards)]),
    sources: pptxCards.map((card) => buildAssistantPreviewCardFileSource(card, scope)),
  };
}

interface AssistantPreviewCardsProps {
  cards: AssistantPreviewCard[];
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop 完成态生成产物：批量打开本轮已通过校验的 PPTX。 */
  autoOpenPptxKey?: string;
  onAutoOpenPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  compactForRemoteControl?: boolean;
}

export function shouldRenderAssistantPreviewCardAsFile(
  card: AssistantPreviewCard,
  scope: {
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
    compactForRemoteControl?: boolean;
  },
): boolean {
  const filePath = getAssistantPreviewCardFilePath(card);
  return (
    card.type !== "website" ||
    (card.url.startsWith("file://") &&
      filePath !== null &&
      !shouldOpenAssistantHtmlInBrowser({ path: filePath, ...scope }))
  );
}

export function useAssistantPreviewCardValidation(
  cards: AssistantPreviewCard[],
  scope: {
    workspacePath?: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  } = {},
): AssistantPreviewCardValidationResult {
  const { fileService } = useWorkspaceServices(
    scope.workspacePath,
    scope.workspaceRemoteSessionId,
    scope.workspaceIdentity,
  );
  const cardsSignature = useMemo(() => getAssistantPreviewCardsValidationSignature(cards), [cards]);
  const validationCardsRef = useRef({ cards, signature: cardsSignature });
  // timeline 重建时会传入内容相同但引用不同的 cards 数组，effect 若依赖数组引用会重复发起 RPC。
  // 只在语义签名变化时替换校验快照；workspace fileService 变化仍会使用同一快照重新校验。
  if (validationCardsRef.current.signature !== cardsSignature) {
    validationCardsRef.current = { cards, signature: cardsSignature };
  }
  const validationCards = validationCardsRef.current.cards;
  const statFreeVisibleCards = useMemo(
    () => resolveAssistantPreviewCardsWithoutFileStat(validationCards),
    [validationCards],
  );
  const [validationResult, setValidationResult] = useState<{
    fileService: AssistantPreviewCardFileStatService | null;
    signature: string;
    visibleCards: AssistantPreviewCard[];
  }>(() => ({
    fileService: null,
    signature: "",
    visibleCards: [],
  }));

  useEffect(() => {
    if (statFreeVisibleCards) {
      return;
    }

    let disposed = false;

    // 历史消息切换时，上一条消息的已通过 stat 结果会在 effect 清理前短暂复用。
    // 这里按当前候选签名批量二次校验，全部算完后一次发布，避免文件卡先闪一批再被替换。
    void resolveValidatedAssistantPreviewCards(validationCards, fileService).then(
      (visibleCards) => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards,
        });
      },
      () => {
        if (disposed) return;
        setValidationResult({
          fileService,
          signature: cardsSignature,
          visibleCards: [],
        });
      },
    );

    return () => {
      disposed = true;
    };
  }, [cardsSignature, fileService, statFreeVisibleCards, validationCards]);

  if (statFreeVisibleCards) {
    return {
      visibleCards: statFreeVisibleCards,
      settled: true,
    };
  }

  const hasCurrentValidation =
    validationResult.fileService === fileService && validationResult.signature === cardsSignature;

  return {
    visibleCards: hasCurrentValidation ? validationResult.visibleCards : [],
    settled: hasCurrentValidation,
  };
}

export function AssistantPreviewCards({
  cards,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  autoOpenPptxKey,
  onAutoOpenPptx,
  compactForRemoteControl,
}: AssistantPreviewCardsProps) {
  const { intl } = useZCodeIntl();
  const { visibleCards, settled } = useAssistantPreviewCardValidation(cards, {
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });

  useEffect(() => {
    if (!settled || !autoOpenPptxKey || !onAutoOpenPptx) return;

    const request = buildAssistantPreviewPptxAutoOpenRequest(visibleCards, autoOpenPptxKey, {
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    });
    if (!request) return;

    // 自动打开只能消费最终可见卡片；这样与 15 个候选、10 张上限和 Host stat
    // 完全同源，不会打开卡片中并不存在的文件。
    onAutoOpenPptx(request);
  }, [
    autoOpenPptxKey,
    onAutoOpenPptx,
    settled,
    visibleCards,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);

  if (!settled || visibleCards.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {visibleCards.map((card, index) => (
        <AssistantPreviewCardRow
          key={card.id}
          card={card}
          animationDelayMs={Math.min(index * 36, 240)}
          subtitle={intl.formatMessage({ id: card.subtitleId })}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenFileLink={onOpenFileLink}
          onOpenCodeViewer={onOpenCodeViewer}
          compactForRemoteControl={compactForRemoteControl}
        />
      ))}
    </div>
  );
}

function AssistantPreviewCardRow({
  card,
  animationDelayMs,
  subtitle,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  compactForRemoteControl,
}: {
  card: AssistantPreviewCard;
  animationDelayMs: number;
  subtitle: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  compactForRemoteControl?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const filePath = getAssistantPreviewCardFilePath(card);
  const renderAsFile = shouldRenderAssistantPreviewCardAsFile(card, {
    workspaceIdentity,
    workspaceRemoteSessionId,
    compactForRemoteControl,
  });
  const descriptor = filePath ? resolveFileDisplayDescriptor(filePath) : null;
  const fileSource =
    renderAsFile && filePath
      ? {
          type: "file" as const,
          title: card.title,
          path: filePath,
          ...(workspacePath ? { workspacePath } : {}),
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
        }
      : null;
  return (
    <OpenSplitButton
      renderCard={(button, { handlePreview, canPreview }) => (
        <div
          className="group/preview-card relative isolate flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground"
          data-preview-card-title={card.title}
          data-zcode-stream-animate="true"
          style={
            {
              "--zcode-stream-animation-delay": `${animationDelayMs}ms`,
            } as CSSProperties
          }
        >
          {/* 修复：hover token 在深色与 Zai 主题中是半透明色，不能直接覆盖 bg-card；
              用独立叠加层保留卡片底色，才能得到 card + hover 的合成效果。 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 rounded-xl bg-hover opacity-0 transition-opacity group-hover/preview-card:opacity-100"
          />

          {/* 卡片主体（空白、图标、文件名）与"打开"主按钮执行同一应用内预览动作：
              铺满卡片的透明按钮承载整卡点击，右侧打开/下拉控件 relative z-10 置于其上层，
              一次点击只会命中其中一个目标，不会触发两次预览。 */}
          <button
            type="button"
            className="absolute inset-0 cursor-pointer rounded-xl disabled:pointer-events-none disabled:cursor-default"
            aria-label={intl.formatMessage(
              { id: "chat.previewCards.openCard" },
              { title: card.title },
            )}
            disabled={!canPreview}
            onClick={handlePreview}
          />
          <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
            {!renderAsFile && card.type === "website" ? (
              <GlobeIcon className="size-6" />
            ) : descriptor ? (
              <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
            ) : (
              <FileTextIcon className="size-6" />
            )}
          </div>
          <div className="min-w-0 flex flex-1 flex-col gap-1">
            <div className="truncate text-ui-base font-medium leading-5">{card.title}</div>
            <div className="truncate text-ui-base leading-5 text-foreground-subtlest">
              {subtitle}
            </div>
          </div>
          <div className="relative z-10 shrink-0">{button}</div>
        </div>
      )}
      target={
        !renderAsFile && card.type === "website"
          ? {
              type: "website",
              url: card.url,
              // website 卡有两个来源——html 引用卡（file://）与 localhost
              // 预览卡（http(s) 活服务）。localPath 直开只对前者生效；localhost 卡
              // 必须继续把 URL 交给浏览器，否则丢路由/动态内容。
              workspacePath,
              localPath: card.url.startsWith("file:") ? card.filePath : undefined,
              // 远程工作区的 filePath 是远端路径，不能交给本机文件管理器定位。
              sourcePath:
                workspaceIdentity || workspaceRemoteSessionId ? undefined : card.filePath,
            }
          : {
              type: "file",
              path: filePath!,
              title: card.title,
              label: card.title,
              // Preview Card 以前没有 CodeViewer scope，远程 Linux path
              // 会被 OpenSplitButton 当成本地路径交给宿主编辑器。
              previewSource:
                card.type === "website"
                  ? fileSource!
                  : buildAssistantPreviewCardFileSource(card, {
                      workspacePath,
                      workspaceIdentity,
                      workspaceRemoteSessionId,
                    }),
            }
      }
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenFileLink={onOpenFileLink}
      onOpenCodeViewer={onOpenCodeViewer}
    />
  );
}

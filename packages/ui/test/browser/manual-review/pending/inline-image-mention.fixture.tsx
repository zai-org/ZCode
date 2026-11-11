import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationRowView } from "@/v4/ConversationRowView";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider";
import { ServiceProvider } from "@/hooks/useServices";
import { PlatformProvider } from "@/hooks/usePlatform";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown";
import "@/styles.css";
const params = new URLSearchParams(location.search);
const evidence: any[] = [];
const releases = new Map<string, () => void>();
(window as any).inlineEvidence = evidence;
(window as any).resolvedOwners = [];
(window as any).releaseRead = (owner: string) => releases.get(owner)?.();
const mode = params.get("case");
const label = mode === "ordinary" ? "README.md" : "小桥流水人家.jpg";
const destination =
  mode === "ordinary" || mode === "disguised"
    ? "./README.md"
    : mode === "windows"
      ? "C:\\work\\images\\小桥流水人家.jpg"
      : "./images/小桥流水人家.jpg";
const actualDestination =
  {
    absolute: "/data/images/小桥流水人家.jpg",
    "file-url": "file:///data/images/%E5%B0%8F%E6%A1%A5.jpg",
    traversal: "../outside.jpg",
    "nested-escape": "./x/../../outside.jpg",
    http: "https://example.test/image.jpg",
  }[mode ?? ""] ?? destination;
const row = {
  kind: "userInput",
  rowId: 1,
  entityId: "inline-image-test",
  turnId: "turn-1",
  revision: 1,
  text: buildFileMentionMarkdown(actualDestination, label) + " 不错不错，再来一张",
  origin: "realUser",
} as any;
const platform = {
  canOpenLocalFiles: !params.has("mobile"),
  saveFile: async () => {
    evidence.push({ kind: "saveFile" });
    if (params.has("failSave")) return { success: false, error: "fixture save failed" };
    return params.has("cancelSave")
      ? { success: false, canceled: true }
      : { success: true, path: "/tmp/inline-image.svg" };
  },
  openInEditor: async (_id: string, path: string) => {
    evidence.push({ kind: "reveal", path });
    return { success: true };
  },
  openInFileManager: async (path: string) => {
    evidence.push({ kind: "reveal", path });
    return { success: true };
  },
  getFileApplications: async () => [
    {
      id: "preview",
      name: "Preview",
      isDefault: true,
      iconDataUrl:
        (window as any).applicationIcon ??
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='skyblue'/%3E%3C/svg%3E",
    },
  ],
  openExternalFile: async () => ({ success: true }),
} as any;
document.documentElement.className = params.has("dark") ? "theme-zai-dark" : "theme-zai-light";
function App() {
  const [owner, setOwner] = useState(params.has("remote") ? "remote-A" : "local");
  (window as any).switchOwner = setOwner;
  const context = useMemo(
    () => ({
      theme: params.has("dark") ? "dark" : "light",
      sessionId: "inline-image-session",
      workspacePath: mode === "windows" ? "C:\\work" : "/workspace",
      workspaceIdentity: owner === "local" ? undefined : `ssh:${owner}:/workspace`,
      workspaceRemoteSessionId: owner === "local" ? undefined : `session-${owner}`,
    }),
    [owner],
  );
  const services = useMemo(
    () => ({
      fileService: {
        readMediaPreview: async (request: any) => {
          evidence.push({ kind: "readMediaPreview", ...request, owner });
          if (params.has("defer"))
            await new Promise<void>((resolve) => releases.set(owner, resolve));
          if (params.has("fail")) throw Error("fixture missing file");
          const svg =
            (window as any).previewSample ??
            '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="lightblue"/></svg>';
          (window as any).resolvedOwners.push(owner);
          return {
            path: request.path,
            mediaType: "image/svg+xml",
            dataBase64: btoa(unescape(encodeURIComponent(svg))),
            totalBytes: svg.length,
          };
        },
      },
    }),
    [owner],
  );
  return (
    <ServiceProvider services={services as any}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <PlatformProvider platform={platform}>
          <TooltipProvider>
            <main data-owner={owner} className="min-h-screen bg-background p-8 text-foreground">
              <h1 className="text-ui-xl">对话中的文件名形式图片引用</h1>
              <div className="mx-auto mt-20 max-w-3xl">
                <ConversationRowView row={row} context={context as any} />
              </div>
            </main>
          </TooltipProvider>
        </PlatformProvider>
      </ZCodeIntlProvider>
    </ServiceProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

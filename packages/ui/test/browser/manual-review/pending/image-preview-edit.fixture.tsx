import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { registerImageComposerTarget } from "@/image-preview-editor/index.js";
import "@/styles.css";
const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
localStorage.setItem("zcode-locale-preference", locale);
document.documentElement.className =
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark dark";
const src =
  "data:image/svg+xml," +
  encodeURIComponent(
    (window as any).previewSample ??
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/><circle cx="600" cy="400" r="150" fill="skyblue"/></svg>',
  );
const fixture = window as unknown as {
  savedFiles: File[];
  changeScope: () => void;
  rejectSave: boolean;
};
fixture.savedFiles = [];
fixture.rejectSave = false;
function Fixture() {
  const [attachments, setAttachments] = useState<File[]>([]);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(0);
  fixture.changeScope = () => setScope((value) => value + 1);
  useEffect(
    () =>
      registerImageComposerTarget({
        append: (file) => {
          if (fixture.rejectSave) return false;
          fixture.savedFiles.push(file);
          setAttachments((files) => [...files, file]);
          return true;
        },
      }),
    [scope],
  );
  return (
    <ZCodeIntlProvider initialLocale={locale}>
      <button onClick={() => setOpen(true)}>Open</button>
      <div className="m-6 rounded-xl border border-border bg-background p-4 text-foreground">
        <label>
          输入框
          <textarea aria-label="输入框" placeholder="输入消息" />
        </label>
        {attachments.map((file, index) => (
          <div key={index} data-composer-attachment="">
            {file.name}
          </div>
        ))}
      </div>
      <ImagePreviewDialog
        open={open}
        onOpenChange={setOpen}
        initialIndex={0}
        items={
          params.has("multi")
            ? [
                { alt: "drawing.svg", src },
                { alt: "second.svg", src: src + "%20" },
              ]
            : [{ alt: "drawing.svg", src }]
        }
      />
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

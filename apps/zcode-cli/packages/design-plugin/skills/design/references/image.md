# Image

For a raster image: a standalone deliverable (poster, cover, banner, logo concept, illustration, product shot) or an asset a page, app or deck needs (hero, illustration, product photo). Diagrams, charts and icons stay drawn SVG or CSS.

## Tool

Generation is the `generate_image` tool of the `image-generation` plugin (Seedream). This plugin does not ship it.

- Not available: say image generation needs the `image-generation` plugin installed and enabled. A page asset falls back to the user's own image, a real one fetched with a tool, or drawn SVG, marked as a stand-in to replace; a standalone image stops there. Never pass off a hand-drawn SVG, HTML or CSS picture as the generated image.
- Errors: tell the user what the tool says (no Coding Plan, account not linked to Z.ai, content review, network) and stop. A content-review failure may be retried once with a reworded prompt. A timeout or unknown outcome may already have used quota; do not resend it on your own.

Parameters: `prompt` (required); `reference_image`, one only: a workspace path, an `https://` URL or a `data:image/...` URL, png, jpeg or webp up to 10 MiB; `output_path`. There is no size, ratio, seed, mask, format or transparency parameter: put orientation and background in the prompt and promise neither exact pixels, true alpha nor a format.

## Decide before calling

1. **Create or edit.** Edit only when the user asks to change an existing image (background, object, text, color, style transfer, outpaint, the previous result); anything else, including "in the style of this image", creates a new one.
2. **Image role.** `reference` (borrow its style, composition, colors, subject), `edit_target`, `previous_result`, or none. With several images and no choice made, ask which one; never pick at random or promise to fuse them.
3. **Final use**, which sets what the prompt must carry. Classify by use, not keywords ("an illustrated coffee poster" is marketing):
   - **Marketing**: poster, cover, banner, social post, ad, thumbnail. Channel and orientation, audience, the exact title, selling points, date, price or CTA, hierarchy among them, text-safe area and negative space, brand colors.
   - **Brand asset**: logo, wordmark, icon, avatar, mascot, sticker set. Exact name, the core symbol, simplicity, silhouette readable at small sizes, color count, plain background, no mockup or extra slogan. It is a raster concept: never promise SVG, editable vectors or a registrable mark.
   - **Illustration**: scene, character, concept art, storyboard. Subjects and what each does, setting and time, medium, viewpoint and shot, light and mood, consistency across a series.
   - **Other**: photo, product, infographic, background, 3D render. Actual use, subject, medium, composition, light, exact labels.

Proceed once subject and target are clear; ask only what blocks it (what to draw, which image, whether an image is the target or a reference, an edit with no image available), per the hard rule on questions.

## Writing the prompt

One complete string in the user's language. Order what applies, skip what does not:

```text
use and deliverable → core request → setting → subject and key details → medium or style
→ composition, viewpoint, orientation → light, mood, color → text, verbatim → keep / must not include
```

- The user's subjects, text, brand, colors, style and constraints stay as given; never turn photo into illustration or the reverse. A specific request is only structured; a vague one gets use, composition and needed detail, nothing more.
- Never add people, objects, brands, slogans, story, left/right placement or filler ("8K", "masterpiece", "stunning") the user did not ask for.
- Text in the image: quote it exactly and say not to add, drop or rewrite it; spell rare brand words letter by letter; describe type personality and rough position. Invent no text when none was asked. Small or long text may still come out wrong; do not promise it.
- Reference image: name exactly which features to borrow. A product reference is protected by default: shape, structure, colors, materials, logo, packaging and proportions stay; change only the setting, light or layout asked for; do not invent hidden parts. Do not copy people, brands or text from a reference unless asked.
- Look at the image first (native vision, per Evidence in [SKILL.md](../SKILL.md)). Keep only visible facts relevant to the task (subject, layout, shapes, colors, type style, materials, light, visible text and invariants), with the user's request as the main thread; leave out brand history, symbolism and other inference. Uncertain readings never become required text. An unreadable image is not guessed at: go on from the text only if it fully defines the result, and say so.

Editing uses one shape, restated in full every round so the subject, face, logo and text do not drift:

```text
Target result: <what it looks like after>
Modify only: <elements or areas>
Must preserve: <identity, text, logo, composition, product, background...>
Must not add: <people, objects, text, logos, watermarks>
```

Add per use: marketing keeps copy, logo, QR code and hierarchy; brand keeps name, core shape and silhouette; illustration keeps character identity, clothing and style; product keeps shape, color, materials, logo and proportions. Short feedback ("bluer", "bigger title") is rebuilt with the previous round's subject and constraints, never passed through alone.

## Calling and after

- One call, one image. Several directions are separate calls with clearly different prompts sharing the user's constraints; a series reuses a confirmed result as `reference_image` and restates the invariants. Do not loop for variations nobody asked for.
- The tool writes the file itself, by default under `generated-images/`. Pass `output_path` when the user names a place, and for a page asset a unique new name in the page's asset folder, e.g. `原型/assets/hero-7f3c.png`, so earlier versions keep theirs. Its returned URL is temporary; never put it in a page.
- Keep the generated image's watermark and AI label: never crop, cover, blur or paint over it, and lay the page out so it stays visible. If the user asks to remove it, say it is required and cannot be removed.
- Look at the result before using it: subject, use, exact text, brand name, edit invariants, anatomy and product fidelity. Retry once for a clear miss against the request, not for taste. A URL alone is not an inspection; if you could not see the image, say the check is incomplete.
- Standalone: deliver the saved file as a Markdown link per [SKILL.md](../SKILL.md)'s Output. Page asset: reference it from the page by relative path (or `data:` for a single file) and go back to the page's own workflow and [check](check.md).
- Follow-ups: a local change edits the previous result as `reference_image`; a new direction creates a new image.
- Report generation, inspection and delivery separately when any of them failed. Do not show the compiled prompt or your classification unless asked.

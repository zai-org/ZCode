---
name: ai-elements
description: Build AI chat interfaces using ai-elements components — conversations, messages, tool displays, prompt inputs, and more. Use when the user wants to build a chatbot, AI assistant UI, or any AI-powered chat interface.
disable-model-invocation: true
---

<!--
Derived from vercel/ai-elements (skills/ai-elements/SKILL.md).
Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
Modified by ZCode: local integration, formatting and adaptations.
See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
-->

# AI Elements

[AI Elements](https://www.npmjs.com/package/ai-elements) is a component library and custom registry built on top of [shadcn/ui](https://ui.shadcn.com/) to help you build AI-native applications faster. It provides pre-built components like conversations, messages and more.

Installing AI Elements is straightforward and can be done in a couple of ways. You can use the dedicated CLI command for the fastest setup, or integrate via the standard shadcn/ui CLI if you've already adopted shadcn's workflow.

> **IMPORTANT:** Run all CLI commands using the project's package runner: `npx ai-elements@latest`, `pnpm dlx ai-elements@latest`, or `bunx --bun ai-elements@latest` — based on the project's `packageManager`. Examples below use `npx ai-elements@latest` but substitute the correct runner for the project.

## Prerequisites

Before installing AI Elements, make sure your environment meets the following requirements:

- [Node.js](https://nodejs.org/en/download/), version 18 or later
- A [Next.js](https://nextjs.org/) project with the [AI SDK](https://ai-sdk.dev/) installed.
- [shadcn/ui](https://ui.shadcn.com/) installed in your project. If you don't have it installed, running any install command will automatically install it for you.
- We also highly recommend using the [AI Gateway](https://vercel.com/docs/ai-gateway) and adding `AI_GATEWAY_API_KEY` to your `env.local` so you don't have to use an API key from every provider. AI Gateway also gives $5 in usage per month so you can experiment with models. You can obtain an API key [here](https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys&title=Get%20your%20AI%20Gateway%20key).

## Installing Components

You can install AI Elements components using either the AI Elements CLI or the shadcn/ui CLI. Both achieve the same result: adding the selected component’s code and any needed dependencies to your project.

The CLI will download the component’s code and integrate it into your project’s directory (usually under your components folder). By default, AI Elements components are added to the `@/components/ai-elements/` directory (or whatever folder you’ve configured in your shadcn components settings).

After running the command, you should see a confirmation in your terminal that the files were added. You can then proceed to use the component in your code.

## Usage

Once an AI Elements component is installed, you can import it and use it in your application like any other React component. The components are added as part of your codebase (not hidden in a library), so the usage feels very natural.

## Example

After installing AI Elements components, you can use them in your application like any other React component. For example:

```tsx title="conversation.tsx"
"use client";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { useChat } from "@ai-sdk/react";

const Example = () => {
  const { messages } = useChat();

  return (
    <>
      {messages.map(({ role, parts }, index) => (
        <Message from={role} key={index}>
          <MessageContent>
            {parts.map((part, i) => {
              switch (part.type) {
                case "text":
                  return (
                    <MessageResponse key={`${role}-${i}`}>
                      {part.text}
                    </MessageResponse>
                  );
              }
            })}
          </MessageContent>
        </Message>
      ))}
    </>
  );
};

export default Example;
```

In the example above, we import the `Message` component from our AI Elements directory and include it in our JSX. Then, we compose the component with the `MessageContent` and `MessageResponse` subcomponents. You can style or configure the component just as you would if you wrote it yourself – since the code lives in your project, you can even open the component file to see how it works or make custom modifications.

## Extensibility

All AI Elements components take as many primitive attributes as possible. For example, the `Message` component extends `HTMLAttributes<HTMLDivElement>`, so you can pass any props that a `div` supports. This makes it easy to extend the component with your own styles or functionality.

## Customization

After installation, no additional setup is needed. The component’s styles (Tailwind CSS classes) and scripts are already integrated. You can start interacting with the component in your app immediately.

For example, if you'd like to remove the rounding on `Message`, you can go to `components/ai-elements/message.tsx` and remove `rounded-lg` as follows:

```tsx title="components/ai-elements/message.tsx" highlight="8"
export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex flex-col gap-2 text-sm text-foreground",
      "group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-user]:px-4 group-[.is-user]:py-3",
      className
    )}
    {...props}
  >
    <div className="is-user:dark">{children}</div>
  </div>
);
```

## Troubleshooting

### Why are my components not styled?

Make sure your project is configured correctly for shadcn/ui in Tailwind 4 - this means having a `globals.css` file that imports Tailwind and includes the shadcn/ui base styles.

### I ran the AI Elements CLI but nothing was added to my project

Double-check that:

- Your current working directory is the root of your project (where `package.json` lives).
- Your components.json file (if using shadcn-style config) is set up correctly.
- You’re using the latest version of the AI Elements CLI:

```bash title="Terminal"
npx ai-elements@latest
```

If all else fails, feel free to open an [issue on GitHub](https://github.com/vercel/ai-elements/issues).

### Theme switching doesn’t work — my app stays in light mode

Ensure your app is using the same data-theme system that shadcn/ui and AI Elements expect. The default implementation toggles a data-theme attribute on the `<html>` element. Make sure your tailwind.config.js is using class or data- selectors accordingly.

### The component imports fail with “module not found”

Check the file exists. If it does, make sure your `tsconfig.json` has a proper paths alias for `@/` i.e.

```json title="tsconfig.json"
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"]
    }
  }
}
```

### My AI coding assistant can't access AI Elements components

1. Verify your config file syntax is valid JSON.
2. Check that the file path is correct for your AI tool.
3. Restart your coding assistant after making changes.
4. Ensure you have a stable internet connection.

### Still stuck?

If none of these answers help, open an [issue on GitHub](https://github.com/vercel/ai-elements/issues) and someone will be happy to assist.

## Available Components

See the `references/` folder for detailed documentation on each component.

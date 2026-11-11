import { describe, expect, it } from "vitest";
import type { PermissionRuleset } from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { createBashPermissionRulePolicy } from "../src/tool/handlers/bash-command-permission-policy.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

describe("Bash command permission rule policy", () => {
  it.each(["cmd", "legacy-shell"] as const)(
    "only suggests and accepts exact command grants for %s",
    (dialect) => {
      const command = "npm run test # & python script.py";
      const policy = createBashPermissionRulePolicy(command, {
        bashShellSelection: { dialect, source: "legacy-fallback", display: { name: dialect } },
      });
      expect(policy.suggestedPermissionUpdates).toEqual([
        {
          behavior: "allow",
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: command }],
        },
      ]);
      for (const ruleContent of ["npm run:*", "npm *", "npm run test"]) {
        expect(policy.evaluateRules("allow", [{ toolName: "Bash", ruleContent }])).toBe(false);
      }
      expect(policy.evaluateRules("allow", [{ toolName: "Bash", ruleContent: command }])).toBe(
        true,
      );
      expect(policy.evaluateRules("allow", [{ toolName: "Bash" }])).toBe(true);
      for (const behavior of ["deny", "ask"] as const) {
        expect(policy.evaluateRules(behavior, [{ toolName: "Bash", ruleContent: command }])).toBe(
          true,
        );
        expect(
          policy.evaluateRules(behavior, [{ toolName: "Bash", ruleContent: "npm run:*" }]),
        ).toBe(true);
      }
    },
  );

  it.each([
    ["pnpm run lint --fix", "pnpm run lint:*"],
    ["pnpm --dir /tmp/project run lint --fix", "pnpm run lint:*"],
    ["git -C packages/app push origin main", "git push:*"],
    ["python3 -m pytest tests/unit", "python3 -m pytest:*"],
    ["sudo -u build git push origin main", "sudo git push:*"],
    ["docker compose up --detach", "docker compose up:*"],
    ["FOO=bar pnpm run lint --fix", "FOO=bar pnpm run lint:*"],
  ])("resolves a stable prefix for %s", (command, expectedRuleContent) => {
    expect(ruleContents(command)).toEqual([expectedRuleContent]);
  });

  it.each([
    "curl https://example.com/archive.tgz",
    "rm -rf ./dist",
    "pnpm run lint > lint.txt",
    "pnpm run $(node choose-script.js)",
    "FOO=$BAR pnpm run lint",
  ])("falls back to an exact rule for %s", (command) => {
    expect(ruleContents(command)).toEqual([command]);
  });

  it("suggests independent compound rules and omits readonly invocations", () => {
    expect(ruleContents("ls && pnpm run lint --fix && git push origin main")).toEqual([
      "pnpm run lint:*",
      "git push:*",
    ]);
  });

  it("falls back to the whole exact command above the five-rule limit", () => {
    const command = ["a", "b", "c", "d", "e", "f"]
      .map((script) => `pnpm run ${script}`)
      .join(" && ");
    expect(ruleContents(command)).toEqual([command]);
  });

  it("requires every permission-requiring invocation to be allowed", () => {
    const command = "npm run test && rm -rf ./out";
    const partialRules: PermissionRuleset = {
      allow: [{ ruleContent: "npm run test:*", toolName: "Bash" }],
      version: 1,
    };
    expect(check(command, partialRules).decision).toBe("ask");

    const fullRules: PermissionRuleset = {
      allow: [
        { ruleContent: "npm run test:*", toolName: "Bash" },
        { ruleContent: "rm -rf ./out", toolName: "Bash" },
      ],
      version: 1,
    };
    expect(check(command, fullRules).decision).toBe("allow");
  });

  it("matches a persisted stable prefix after stripping transient global flags", () => {
    expect(
      check("pnpm --dir /tmp/project run lint -- --second", {
        allow: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("git -C packages/app push origin main", {
        allow: [{ ruleContent: "git push:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
  });

  it("applies deny and ask when any invocation matches", () => {
    const command = "npm run test && rm -rf ./out";
    expect(
      check(command, {
        deny: [{ ruleContent: "rm:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("deny");
    expect(
      check(command, {
        ask: [{ ruleContent: "npm run:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("ask");
  });

  it("keeps legacy exact, wildcard, prefix, and tool-only behavior without compound bypass", () => {
    expect(
      check("npm run test && rm -rf ./out", {
        allow: [{ ruleContent: "npm run test && rm -rf ./out", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("  pnpm run lint --fix  ", {
        allow: [{ ruleContent: "  pnpm run lint --fix  ", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("npm run test --watch", {
        allow: [{ ruleContent: "npm run:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("npm run test && rm -rf ./out", {
        allow: [{ ruleContent: "npm run:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("ask");
    expect(
      check("pnpm run lint --fix", {
        allow: [{ ruleContent: "pnpm *", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("npm run test && rm -rf ./out", {
        allow: [{ toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
  });

  it("only lets an unsafe command match its complete exact rule", () => {
    const rules: PermissionRuleset = {
      allow: [
        { ruleContent: "pnpm run:*", toolName: "Bash" },
        { ruleContent: "pnpm run lint > lint.txt", toolName: "Bash" },
      ],
      version: 1,
    };
    expect(check("pnpm run lint > lint.txt", rules).decision).toBe("allow");
    expect(check("pnpm run lint > other.txt", rules).decision).toBe("ask");
  });
});

function ruleContents(command: string): Array<string | undefined> {
  const policy = createBashPermissionRulePolicy(command);
  return policy.suggestedPermissionUpdates.flatMap((update) =>
    update.rules.map((rule) => rule.ruleContent),
  );
}

function check(command: string, ruleset: PermissionRuleset) {
  const service = new PermissionService();
  return service.checkPermission(
    {
      input: { command },
      mode: "build",
      riskLevel: bashToolEntry.metadata.riskLevel,
      toolName: "Bash",
    },
    {
      ...bashToolEntry.metadata,
      permission: bashToolEntry.permission,
    },
    ruleset,
    createBashPermissionRulePolicy(command),
  );
}

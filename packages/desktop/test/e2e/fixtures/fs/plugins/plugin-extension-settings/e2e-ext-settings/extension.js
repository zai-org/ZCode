// E2E 扩展 fixture（docs/plugins/extension-host.md §16.7、§18.1 H1）：纯 JS，不需要构建。
// - env.onDidChange（订阅后先收当前值，之后每次换语言）时调 ctx.settings.get() 并记一行 E2E_SETTINGS_PROBE。
// - ctx.settings.onDidChange：本插件的设置保存或重置成功后记一行 E2E_SETTINGS_CHANGED。
// - 视图 account（写法一）：工具 login({ token }) 调 ctx.settings.update 写敏感键，logout() 清除它。
//   与 GitLab 面板的登录、退出同一条路径（§18.2）。工具的返回不带 token。
//   工具 setRegion({ region }) 调 ctx.settings.update 写普通键（非敏感值进 config.json）。
// 只记 hasToken、token 的长度、region 与键名，不记 token 本身（日志不能泄露敏感值）。
function describe(values, source, extra = "") {
  const token = typeof values.token === "string" ? values.token : "";
  const keys = Object.keys(values).sort().join(",");
  return `${source} plugin=e2e-ext-settings${extra} hasToken=${token.length > 0} tokenLength=${token.length} region=${String(values.region ?? "")} keys=${keys}`;
}

export function activate(ctx) {
  ctx.env.onDidChange(({ locale }) => {
    ctx.settings
      .get()
      .then(({ values }) =>
        ctx.log.info(describe(values, "E2E_SETTINGS_PROBE", ` locale=${locale}`)),
      )
      .catch((error) => ctx.log.error(`E2E_SETTINGS_PROBE failed: ${error?.code ?? error}`));
  });
  ctx.settings.onDidChange(({ values }) => {
    ctx.log.info(describe(values, "E2E_SETTINGS_CHANGED"));
  });

  const run = async (name, update) => {
    try {
      await ctx.settings.update(update);
      ctx.log.info(`E2E_SETTINGS_UPDATE ${name} ok`);
      return { ok: true };
    } catch (error) {
      ctx.log.info(`E2E_SETTINGS_UPDATE ${name} code=${error?.code ?? "unknown"}`);
      return { ok: false, code: error?.code ?? "unknown" };
    }
  };
  ctx.views.register("account", {
    entry: "./view.html",
    tools: {
      login: {
        description: "Store the token in this plugin's settings",
        inputSchema: { type: "object", properties: { token: { type: "string" } } },
        run: (input) => run("login", { values: { token: String(input?.token ?? "") } }),
      },
      logout: {
        description: "Clear the token from this plugin's settings",
        inputSchema: { type: "object", properties: {} },
        run: () => run("logout", { clear: ["token"] }),
      },
      setRegion: {
        description: "Store a normal (non-sensitive) setting",
        inputSchema: { type: "object", properties: { region: { type: "string" } } },
        run: (input) => run("region", { values: { region: String(input?.region ?? "") } }),
      },
    },
  });
}

export function deactivate() {}

// E2E 扩展 fixture（docs/plugins/extension-host.md §16.7、§18.1 H1）：第二个扩展，验证 settings.get 只给
// 调用方自己的插件，settings.update 只能写自己 userConfig 里的键。
// env.onDidChange（订阅后先收当前值）时读自己的设置并记一行；只记键名与 hasToken，不记值。
// 第一次收到 env 时试写两次（都应报 invalid-input）：不属于它的键 token，与类型不符的 mode。
export function activate(ctx) {
  let triedUpdates = false;
  const tryUpdate = (name, update) =>
    ctx.settings.update(update).then(
      () => ctx.log.info(`E2E_SETTINGS_FOREIGN ${name} ok`),
      (error) => ctx.log.info(`E2E_SETTINGS_FOREIGN ${name} code=${error?.code ?? "unknown"}`),
    );
  ctx.env.onDidChange(({ locale }) => {
    ctx.settings
      .get()
      .then(({ values }) => {
        const keys = Object.keys(values).sort().join(",");
        ctx.log.info(
          `E2E_SETTINGS_PROBE plugin=e2e-ext-settings-other locale=${locale} hasToken=${"token" in values} mode=${String(values.mode ?? "")} keys=${keys}`,
        );
      })
      .catch((error) => ctx.log.error(`E2E_SETTINGS_PROBE failed: ${error?.code ?? error}`));
    if (triedUpdates) return;
    triedUpdates = true;
    void tryUpdate("token", { values: { token: "E2E-FORGED" } }).then(() =>
      tryUpdate("mode-type", { values: { mode: 1 } }),
    );
  });
}

export function deactivate() {}

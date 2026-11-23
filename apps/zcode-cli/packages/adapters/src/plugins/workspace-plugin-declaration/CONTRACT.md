# workspace-plugin-declaration

项目 `plugins.dirs` 目录插件的声明摘要与发现准入（规格：`docs/plugins/workspace-plugin-dir-trust.md`）。

不变量：

- 摘要只由插件根键与 manifest、`hooks/hooks.json`、`.mcp.json`、manifest 以路径引用的 Hook/MCP 文件原文决定；
  启动发现、打开会话的实时目录与信任写入都调用本模块，三处对同一插件得到同一摘要。
- 发现时摘要读自本次发现材料；材料中途变化由发现整体重建，准入的声明就是随后被解析的声明。
- 未命中信任记录的项目插件返回 `pending`，调用方必须强制停用，不解析任何组件。
- 本模块只读文件，不执行插件代码，不读写信任记录；信任记录归 `workspace-plugin-trust` 模块。

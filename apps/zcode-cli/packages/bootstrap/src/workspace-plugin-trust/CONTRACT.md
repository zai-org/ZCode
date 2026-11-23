# workspace-plugin-trust

项目 `plugins.dirs` 目录插件的用户域信任记录（规格：`docs/plugins/workspace-plugin-dir-trust.md`）。

不变量：

- 记录只存于目标 Host 用户存储根下 `security/workspace-plugin-trust-v1.json`；项目文件不能改写存储根，
  仓库里的同名文件不会被读取。
- 记录键是 Trust identity（与 Hook 信任同一 resolver）+ 插件根相对路径 + 声明摘要；三者精确命中才准入。
- 信任写入在文件锁内重验当前声明；存储损坏时拒绝写入而不是覆盖。
- 本模块不执行插件代码，也不改项目配置；准入判定在插件发现里按本模块给出的记录完成。

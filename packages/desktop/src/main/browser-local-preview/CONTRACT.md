# 内置浏览器本地预览

只服务于内置浏览器 partition。main 将可信宿主发起的本地 HTML 导航转换为签名目录地址，
协议 handler 对每次资源请求验签和检查真实路径，原始 file 请求始终拒绝。

- 签名密钥仅存于 main 当前进程，不持久化；与完整退出清空标签的既有行为一致。
- 一个目录一个 origin；目录签名不能被页面用于授权另一个目录。
- 所有 IO 异步；guest 导航序号阻止旧 IO 结果覆盖新导航。
- 启动入口一次安装；IPC 只接受宿主主 frame 对自己 browser guest 的导航。
- shared 仅提供协议名、平台端口及展示 URL 解码；解码不具有授权语义。

规格：[本地 HTML 预览](../../../../../docs/browser-use/local-html-preview.md)。

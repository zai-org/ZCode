export interface BrowserLocalPreviewContract {
  /** 仅可信宿主调用；校验文件后授权其目录。非 file URL 原样返回，不授予新权限。 */
  resolveNavigation(url: string): Promise<string>;
  /** 每次请求重新校验签名和真实路径；无写入能力，不发出业务事件。 */
  respond(request: Request): Promise<Response>;
}

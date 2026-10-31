/** 截图显示地址。正式运行走 shot:// 协议；测试页面可通过 window.__shotUrl 覆盖。 */
export function shotUrl(id: string): string {
  const override = (window as unknown as { __shotUrl?: (id: string) => string }).__shotUrl;
  return override ? override(id) : `shot://${id}/`;
}

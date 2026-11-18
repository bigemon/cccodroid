# 内置远程访问

设置中的远程访问页管理独立 HTTP 代理。代理启动后，其他设备可扫描地址二维码或直接打开页面。管理接口沿用网关认证，写操作检查来源和 CSRF。

- 认证可选择口令或带凭据的访问链接。明确保存后，模式或凭据变更才生效。
- 服务开关使用已保存的配置。服务运行时，新配置需要保存并重启代理。
- 地址按实际监听配置展示，Wi-Fi 地址优先。二维码在本机生成。
- Remote access is optional. Prefer a trusted local network or VPN when using the HTTP listener.

代理代码源自 cc-remote，按随附 MIT 许可证分发。二维码实现的来源及校验和见 [第三方说明](../../../third_party/qrcodegen/README.md)。

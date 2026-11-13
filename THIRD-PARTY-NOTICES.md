# 第三方组件与参考实现

## qrcode-generator（vendor/qrcode.mjs）

- 来源：https://www.npmjs.com/package/qrcode-generator
- 版本：2.0.4（`dist/qrcode.mjs`）
- 作者：Kazuhiko Arase
- 许可证：MIT

仅用于在本地渲染登录二维码的模块矩阵；PNG 编码由本仓库自带的 40 行编码器完成（`index.js` 中的 `qrPng`）。

```
Copyright (c) Kazuhiko Arase
Licensed under the MIT License.
```

## 协议参考（不含其代码）

- 腾讯官方微信频道插件：`@tencent-weixin/openclaw-weixin`（MIT），用于核对 iLink Bot 接口字段、请求头与消息结构。
- 社区协议整理：https://github.com/sintrb/weixin-ClawBot-API

本仓库的 `index.js` / `client.js` 为独立实现，未复制上述项目的源代码。

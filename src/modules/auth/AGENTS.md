# auth 认证模块

## 功能
微信 OAuth 登录、扫码登录、飞书 OAuth 授权、用户管理、飞书消息接收。

## 对外接口（路由）
- `GET /api/auth/wechat/login` — 微信授权登录
- `GET /api/auth/wechat/callback` — 微信回调
- `GET /api/auth/wechat/login/scan` — 生成扫码登录二维码
- `GET /api/auth/wechat/login/scan/poll` — 扫码轮询
- `POST /api/auth/logout` — 登出
- `GET /api/auth/feishu/callback` — 飞书 OAuth 回调
- `GET /api/users/me/subscription` — 查询订阅状态
- `POST /api/users/me/subscription` — 订阅/取消
- `POST /api/internal/push-feishu` — 内部飞书推送
- `GET /api/users/me` — 用户信息
- `POST /api/internal/feishu-message` — 飞书群消息接收

## 核心文件
- `controller.ts` — AuthController（微信登录/登出）
- `scanLoginController.ts` — ScanLoginController（扫码登录）
- `feishuAuthController.ts` — FeishuAuthController（飞书授权/订阅）
- `userController.ts` — UserController（用户管理）
- `feishuMessageController.ts` — FeishuMessageController（飞书消息）

## 依赖的 shared 类型
- `shared/utils/jwt` — JWT 签发/验证
- `shared/utils/response` — 统一响应
- `shared/utils/CacheService` — 微信 access_token 缓存
- `core/db` — 数据库连接

## 跨模块依赖
- `modules/monitor/HotKeywordDetectorService` — 热词检测（飞书消息处理用）

## 开发注意事项
- JWT 签发需要 `JWT_SECRET` 环境变量
- 扫码登录使用微信临时二维码
- 飞书绑定需要 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
- **微信 API 调用必须使用原生 `fetch`**，禁止用 `sessionFetch`（自定义 https.Agent keepAlive 会导致 HTTP 412）
- **本地降级模式**：PostgreSQL 不可用时，`ScanLoginController` 自动 fallback 到内存 Map 存储 state，与 CacheService 的 dual-write 策略一致

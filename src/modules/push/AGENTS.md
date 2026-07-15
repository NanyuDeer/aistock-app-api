# push 推送模块

## 功能
微信模板消息推送、飞书卡片推送、龙头股/机构调研推荐推送、市场事件重磅推送。

## 对外接口（路由）
- `GET /api/potential-stocks/push-history` — 推送历史
- `GET /api/potential-stocks/push-ranking` — 推送排名
- `POST /api/internal/push-leader` — 手动触发龙头股推送
- `POST /api/internal/push-institution-research` — 手动触发机构调研推送
- `POST /api/internal/push-stock-info` — 手动触发自选股异动推送
- `POST /internal/push/market-event` — Python Agent 触发的市场事件重磅推送（需 X-Internal-Token）
- `ALL /api/auth/wechat/push` — 微信事件推送回调

## 核心文件
- `controller.ts` — PotentialStockPushController
- `wechatEventController.ts` — 微信事件处理
- `MessagePushService.ts` — 消息推送服务（飞书定时调度 + 市场事件飞书卡片）
- `WechatPushService.ts` — 微信模板消息推送（含市场事件推送 `dispatchMarketEventPush()`）

## 依赖的 shared 类型
- `shared/utils/response` — 统一响应
- `core/db` — 数据库连接

## 跨模块依赖
- `modules/monitor/WindLeaderService` — 龙头股数据
- `modules/monitor/HotBurstService` — 机构调研热门股
- `modules/crawler/StockInfoPushService` — 自选股异动推送
- `modules/auth/scanLoginController` — 微信 access_token

## 开发注意事项
- 推送调度器通过 `MessagePushService.startScheduler()` 启动
- 微信推送需要有效 access_token
- **微信 API 调用必须使用原生 `fetch`**，禁止用 `sessionFetch`（自定义 https.Agent keepAlive 会导致 HTTP 412）

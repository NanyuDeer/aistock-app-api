# API Documentation — API 接口文档

> AI Stock App 后端 RESTful API 接口定义

## 概述

- **Base URL**: `https://gupiao-api.yaozhineng.com/api`
- **认证方式**: JWT Token
- **响应格式**: JSON

---

## 认证接口

### 1. 微信扫码登录

**接口**: `GET /api/auth/wechat/login`

**响应示例**:
```json
{
  "code": 200,
  "data": { "qrCodeUrl": "https://..." }
}
```

---

### 2. 用户登出

**接口**: `POST /api/auth/logout`

**认证**: 需要 JWT Token

---

## 行情接口

### 3. 获取股票实时行情

**接口**: `GET /api/cn/stocks/:symbol`

**响应示例**:
```json
{
  "code": 200,
  "data": { "symbol": "300750", "price": 200.50 }
}
```

---

### 4. 获取资金流向

**接口**: `GET /api/cn/stocks/:symbol/capital-flow`

---

## 监控接口

### 5. 获取风口龙头

**接口**: `GET /api/cn/wind-leaders`

---

### 6. 获取异动捕手数据

**接口**: `GET /api/cn/institution-research`

---

### 7. 获取 TenX 评分

**接口**: `GET /api/cn/stocks/:symbol/tenx-score`

---

## 用户接口

### 8. 获取用户自选股

**接口**: `GET /api/users/me/favorites`

**认证**: 需要 JWT Token

---

## WebSocket 接口

**接口**: `wss://gupiao-api.yaozhineng.com/ws`

**频道**: quote/alert/chat

---

## 错误码

| 错误码 | 说明 |
|--------|------|
| 200 | 成功 |
| 401 | 未授权 |
| 500 | 服务器错误 |

---

## 更新日志

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-03 | 0.1.0 | 初始版本 |
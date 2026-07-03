# Database Schema — 数据库表结构文档

> AI Stock App 后端数据库设计（PostgreSQL + pgvector）

## 概述

- **数据库类型**: PostgreSQL（支持 pgvector 向量检索）
- **连接方式**: 连接池（最大 20 连接）
- **时区**: Asia/Shanghai（北京时间）

---

## 核心表结构

### 1. `stock_concept_mapping` — 股票概念映射表

**用途**: 存储股票与概念板块的映射关系（用于风口龙头分析）

```sql
CREATE TABLE stock_concept_mapping (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(10) NOT NULL,           -- 股票代码（如 300750）
    sector_name VARCHAR(100) NOT NULL,     -- 概念板块名称（如"MiniLED"）
    created_at TIMESTAMP DEFAULT NOW(),    -- 创建时间
    UNIQUE(symbol, sector_name)            -- 避免重复映射
);
```

**索引建议**:
- `idx_symbol`: 加速按股票代码查询
- `idx_sector_name`: 加速按概念板块查询

---

### 2. `institution_research_history` — 机构调研历史表

**用途**: 存储机构调研推荐热门股的历史记录（用于异动捕手）

```sql
CREATE TABLE institution_research_history (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMP NOT NULL,        -- 检测时间
    symbol VARCHAR(10) NOT NULL,           -- 股票代码
    stock_name VARCHAR(50) NOT NULL,       -- 股票名称
    resonance_score DECIMAL(5,2),          -- 共振分数（0-100）
    resonance_level VARCHAR(20),           -- 共振等级（如"高共振"）
    price DECIMAL(10,2),                   -- 当时价格
    change_pct DECIMAL(5,2),               -- 当时涨跌幅
    sector_info TEXT,                      -- 板块信息（JSON）
    keywords TEXT[],                       -- 关键词列表
    news_count INTEGER DEFAULT 0,          -- 相关新闻数量
    feishu_count INTEGER DEFAULT 0,        -- 飞书推送次数
    ths_verified BOOLEAN DEFAULT FALSE     -- 同花顺验证标志
);
```

**索引建议**:
- `idx_detected_at`: 加速按时间查询
- `idx_symbol`: 加速按股票代码查询

---

### 3. `earnings_forecast` — 业绩预测表

**用途**: 存储股票业绩预测数据

```sql
CREATE TABLE earnings_forecast (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(10) NOT NULL,           -- 股票代码
    update_time TIMESTAMP NOT NULL,        -- 更新时间
    summary TEXT,                          -- 业绩预测摘要
    forecast_detail TEXT,                  -- 业绩预测详情（JSON）
    forecast_netprofit_yoy DECIMAL(5,2),   -- 预测净利润同比增长率
    UNIQUE(symbol, update_time)            -- 避免重复预测
);
```

**索引建议**:
- `idx_symbol`: 加速按股票代码查询

---

## 数据库连接配置

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/aistock
```

---

## 更新日志

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-03 | 0.1.0 | 初始版本 |
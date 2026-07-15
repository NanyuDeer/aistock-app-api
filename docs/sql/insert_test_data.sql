-- 插入测试事件传导数据
INSERT INTO agent_analysis_reports (report_type, report_date, user_id, content, data_source, status, model_version)
VALUES (
  'event_conduction',
  '2026-07-14',
  'evt_test001',
  '{
    "eventId": "evt_test001",
    "title": "新能源汽车补贴政策延续至2027年",
    "source": "新华社",
    "publishTime": "2026-07-14T10:00:00",
    "event": "财政部等多部门联合发布通知，将新能源汽车推广应用财政补贴政策延长至2027年底。",
    "analysis_reports": {
      "event_understanding": {
        "summary": "补贴政策延续至2027年，降低购车成本拉动终端需求。",
        "coreChanges": [
          { "variable": "政策预期", "before": "2026年到期", "after": "明确延续至2027年" }
        ]
      },
      "event_transmission": {
        "mechanism": "补贴降低购车门槛->终端销量增长->电池装机提升->上游锂矿需求增加",
        "variables": [
          { "name": "补贴金额", "direction": "bullish", "strength": 0.9, "explanation": "单车最高1.5万元直接刺激消费" }
        ],
        "coreIndustry": {
          "name": "新能源汽车",
          "impact": "直接利好",
          "reason": "购车成本下降"
        },
        "chain": [
          { "industry": "新能源汽车", "relation": "核心行业", "level": 1, "direction": "bullish", "impactStrength": 1.0, "reason": "补贴直接刺激消费" },
          { "industry": "动力电池", "relation": "上游传导", "level": 2, "direction": "bullish", "impactStrength": 0.9, "reason": "整车放量拉动电池需求" },
          { "industry": "锂矿", "relation": "上游传导", "level": 3, "direction": "bullish", "impactStrength": 0.8, "reason": "电池产能扩张带动原材料需求" }
        ]
      },
      "event_history": [
        {
          "historyId": "hist_001",
          "year": "2023",
          "title": "新能源补贴退坡20%",
          "eventType": "产业政策",
          "sentiment": "bearish",
          "industryChange": "汽车整车下跌8.5%",
          "changePercentage": -5.6
        }
      ],
      "event_investment": {
        "conclusion": "补贴延续为产业链提供确定性增长预期，整车及上游动力电池有望持续受益。",
        "keyPoints": ["政策不确定性消除", "终端需求确定性增强"],
        "focusIndustries": [
          { "name": "新能源汽车", "direction": "positive", "reason": "补贴降低购车门槛" },
          { "name": "动力电池", "direction": "positive", "reason": "整车放量拉动电池需求" }
        ],
        "opportunities": ["关注整车龙头市场份额提升机会"],
        "risks": ["补贴执行细则可能低于预期"],
        "rating": "positive"
      },
      "event_podcast_brief": "新能源汽车补贴政策延续至2027年，对产业链形成利好。"
    }
  }',
  'test_manual_insert',
  'completed',
  'v3'
);

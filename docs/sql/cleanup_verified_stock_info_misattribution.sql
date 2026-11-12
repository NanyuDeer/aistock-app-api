-- 仅清理已核实的 2026-11-07 错配。部署按股票去重的代码后，在目标数据库执行。
BEGIN;

CREATE TEMP TABLE verified_stock_info_misattribution ON COMMIT DROP AS
SELECT j.id, j.symbol, j.stock_name
FROM stock_info_judgements j
JOIN (VALUES
    (5714, '002384', '国机精工', 'eastmoney-news-202611063925193576'),
    (5717, '300750', '中芯国际', 'eastmoney-news-202611063925062790'),
    (5718, '300750', '中际旭创', 'eastmoney-news-202611063925032035'),
    (5720, '600519', '中际旭创', 'eastmoney-news-202611063925197452'),
    (5721, '600519', '江波龙', 'eastmoney-news-202611063924989297'),
    (5723, '601899', '亨通光电', 'eastmoney-news-202611063924901082'),
    (5724, '601899', '亨通光电', 'eastmoney-news-202611063924886939'),
    (5769, '601009', '工商银行', 'eastmoney-news-202611063924888713'),
    (5787, '300750', '药明康德', 'eastmoney-news-202611073925464689')
) AS known(id, symbol, stock_name, source_id)
    USING (id, symbol, stock_name, source_id)
WHERE j.source = 'eastmoney' AND j.info_type = 'news'
FOR UPDATE OF j;

DELETE FROM notification_outbox o
USING verified_stock_info_misattribution v
WHERE o.input->>'category' = 'stock_info'
  AND o.input->>'sourceKey' = 'stock-info:' || v.id
  AND o.input->>'symbol' = v.symbol
  AND o.input->>'stockName' = v.stock_name;

DELETE FROM user_notifications n
USING verified_stock_info_misattribution v
WHERE n.category = 'stock_info'
  AND n.source_key = 'stock-info:' || v.id
  AND n.symbol = v.symbol
  AND n.stock_name = v.stock_name;

DELETE FROM stock_info_judgements j
USING verified_stock_info_misattribution v
WHERE j.id = v.id;

COMMIT;

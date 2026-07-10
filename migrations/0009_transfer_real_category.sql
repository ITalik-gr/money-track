-- §F2 крок 2: «реальна категорія» переказу/зняття. Транзакція лишається у вторинному
-- бакеті «Перекази і зняття» (category_id=13, is_transfer незмінні — основна аналітика
-- витрат недоторкана), але real_category_id каже, на що ці кошти пішли НАСПРАВДІ
-- (зняв готівку у банкоматі → «Продукти»; card-to-card на власну картку → null).
-- Показується у drill-down переказів; не роздуває основний розподіл.
ALTER TABLE transactions ADD COLUMN real_category_id INTEGER REFERENCES categories(id);

-- Навчання: alias запам'ятовує і реальну категорію, щоб схожі перекази/зняття
-- (той самий опис/мерчант) авто-розмічались без AI при наступному синку.
ALTER TABLE merchant_aliases ADD COLUMN real_category_id INTEGER;

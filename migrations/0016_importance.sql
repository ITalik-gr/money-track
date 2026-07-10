-- §6 Вагомість витрат: 3 рівні — essential (обов'язкова) | discretionary (бажана) |
-- optional (необов'язкова). Дефолт задається на КАТЕГОРІЇ; операція може ПЕРЕВИЗНАЧАТИ.
-- NULL на категорії → трактуємо як 'discretionary' у розрахунках (stats.ts EFF_IMPORTANCE).
-- NULL на транзакції → успадковує від (ефективної) категорії.
ALTER TABLE categories ADD COLUMN importance TEXT;      -- essential|discretionary|optional | NULL
ALTER TABLE transactions ADD COLUMN importance TEXT;    -- override операції | NULL

-- Розумні дефолти для типових категорій (за назвою; кастомні лишаються NULL=бажана).
UPDATE categories SET importance = 'essential'
  WHERE importance IS NULL AND (
    name LIKE '%Продукт%' OR name LIKE '%Комунал%' OR name LIKE '%Податк%' OR
    name LIKE '%Здоров%' OR name LIKE '%Оренд%' OR name LIKE '%Житл%' OR
    name LIKE '%Транспорт%' OR name LIKE '%Зв''язок%' OR name LIKE '%Аптек%' OR
    name LIKE '%Кредит%' OR name LIKE '%Освіт%' OR name LIKE '%Діт%');

UPDATE categories SET importance = 'optional'
  WHERE importance IS NULL AND (
    name LIKE '%Розваг%' OR name LIKE '%Кафе%' OR name LIKE '%Ресторан%' OR
    name LIKE '%Подорож%' OR name LIKE '%Хоб%' OR name LIKE '%Подарунк%' OR
    name LIKE '%Краса%' OR name LIKE '%Одяг%' OR name LIKE '%Розкіш%' OR name LIKE '%Ігр%');

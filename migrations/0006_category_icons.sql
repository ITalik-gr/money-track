-- Допил іконок категорій: перепризначити кілька вбудованих на влучніші слаги, що
-- зʼявилися в CategoryIcon (gamepad/bus/pill). Ідемпотентно (звичайні UPDATE за id),
-- зачіпає лише конкретні вбудовані категорії — кастомні й змінені користувачем не чіпаємо.
UPDATE categories SET icon = 'gamepad' WHERE id = 39 AND icon = 'chip';   -- Ігри
UPDATE categories SET icon = 'bus'     WHERE id = 37 AND icon = 'car';    -- Громадський
UPDATE categories SET icon = 'pill'    WHERE id = 40 AND icon = 'health'; -- Аптека

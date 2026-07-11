-- §R7: ручна назва операції має бути авторитетною. name_locked=1 → користувач сам задав
-- мерчант/назву, і enrich/авто-ре-світ НЕ перезаписує її (категорію/ai_note ще можуть
-- уточнюватись). Ставиться при ручній зміні назви в TxDetail; знімається кнопкою.
ALTER TABLE transactions ADD COLUMN name_locked INTEGER DEFAULT 0;

-- 011_reservations_add_user_id_and_backfill.sql
-- Aggiunge reservations.user_id + backfill utenti e collega prenotazioni

START TRANSACTION;

-- 1) Aggiungi colonna se mancante
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reservations' AND COLUMN_NAME = 'user_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `reservations` ADD COLUMN `user_id` BIGINT NULL AFTER `email`;',
  'SELECT "reservations.user_id esiste già";'
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2) Backfill tabella users (per email)
INSERT INTO users (first_name, last_name, email, phone)
SELECT
  NULLIF(TRIM(customer_first),''), NULLIF(TRIM(customer_last),''), LOWER(NULLIF(TRIM(email),'')), NULLIF(TRIM(phone),'')
FROM reservations r
WHERE r.email IS NOT NULL AND TRIM(r.email) <> ''
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = LOWER(TRIM(r.email)))
GROUP BY LOWER(TRIM(r.email));

-- 3) Backfill tabella users (per phone, solo dove email manca o vuota)
INSERT INTO users (first_name, last_name, email, phone)
SELECT
  NULLIF(TRIM(customer_first),''), NULLIF(TRIM(customer_last),''), NULL, NULLIF(TRIM(phone),'')
FROM reservations r
WHERE (r.email IS NULL OR TRIM(r.email) = '')
  AND r.phone IS NOT NULL AND TRIM(r.phone) <> ''
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.phone = TRIM(r.phone))
GROUP BY TRIM(r.phone);

-- 4) Collega reservations → users (preferisci email, sennò phone)
-- per email
UPDATE reservations r
JOIN users u ON u.email = LOWER(TRIM(r.email))
SET r.user_id = u.id
WHERE r.user_id IS NULL
  AND r.email IS NOT NULL AND TRIM(r.email) <> '';

-- per phone (solo dove user_id ancora NULL)
UPDATE reservations r
JOIN users u ON u.phone = TRIM(r.phone)
SET r.user_id = u.id
WHERE r.user_id IS NULL
  AND (r.email IS NULL OR TRIM(r.email) = '')
  AND r.phone IS NOT NULL AND TRIM(r.phone) <> '';

-- 5) Indice + FK
SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'reservations'
    AND CONSTRAINT_NAME = 'fk_reservations_user_id'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `reservations`
     ADD INDEX `idx_reservations_user_id` (`user_id`),
     ADD CONSTRAINT `fk_reservations_user_id`
       FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
       ON UPDATE CASCADE ON DELETE SET NULL;',
  'SELECT "FK fk_reservations_user_id esiste già";'
);
PREPARE s2 FROM @sql; EXECUTE s2; DEALLOCATE PREPARE s2;

COMMIT;

// src/services/reservations.service.js
// Service “Reservations” — query DB per prenotazioni
// Stile: commenti lunghi, log con emoji, diagnostica chiara.

const { query } = require('../db');
const logger = require('../logger');
const env = require('../env');

// --- Helpers base ------------------------------------------------------------
function trimOrNull(s) {
  const v = (s ?? '').toString().trim();
  return v ? v : null;
}

// Normalizza YYYY-MM-DD → 'YYYY-MM-DD 00:00:00' e 'YYYY-MM-DD 23:59:59'
function toDayRange(fromYmd, toYmd) {
  const out = { from: null, to: null };
  if (fromYmd) out.from = `${fromYmd} 00:00:00`;
  if (toYmd)   out.to   = `${toYmd} 23:59:59`;
  return out;
}

// Calcolo end_at in base alle regole da env.RESV (pranzo/cena).
// Semplice: se ora < 16 => lunchMinutes, altrimenti dinnerMinutes.
function computeEndAtFromStart(startAtIso) {
  const start = new Date(startAtIso);
  const hour  = start.getHours();
  const addMin = hour < 16 ? env.RESV.defaultLunchMinutes : env.RESV.defaultDinnerMinutes;
  const end = new Date(start.getTime() + addMin * 60 * 1000);

  const pad = (n) => String(n).padStart(2, '0');
  const mysqlStart = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:${pad(start.getMinutes())}:00`;
  const mysqlEnd   = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${pad(end.getHours())}:${pad(end.getMinutes())}:00`;
  return { startMysql: mysqlStart, endMysql: mysqlEnd };
}

// --- ensureUser: trova o crea l'utente e ritorna id --------------------------
// Richiede UNIQUE su users.email e/o users.phone (migrazioni 010+).
// Nota: se non hai bisogno di login, assicurati che password_hash sia NULLABLE.
async function ensureUser({ first, last, email, phone }) {
  const e = trimOrNull(email);
  const p = trimOrNull(phone);

  // 1) match rapido su email/phone se presenti
  if (e) {
    const r = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [e]);
    if (r.length) return r[0].id;
  }
  if (p) {
    const r = await query('SELECT id FROM users WHERE phone = ? LIMIT 1', [p]);
    if (r.length) return r[0].id;
  }

  // 2) upsert: se esiste (per unique key) aggiorna nomi e restituisce l'id
  //    se non esiste, crea e restituisce l'id nuovo.
  const res = await query(`
    INSERT INTO users (first_name, last_name, email, phone)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      first_name = COALESCE(VALUES(first_name), first_name),
      last_name  = COALESCE(VALUES(last_name),  last_name),
      id = LAST_INSERT_ID(id)
  `, [trimOrNull(first), trimOrNull(last), e, p]);

  // mysql2 OkPacket: insertId è disponibile sia per insert che per dup-key
  return res.insertId || res[0]?.insertId;
}

// --- API principali ----------------------------------------------------------

// LIST con filtri
async function list(filter = {}) {
  const where = ['1=1'];
  const params = [];

  const { from, to } = toDayRange(filter.from, filter.to);
  if (from) { where.push('r.start_at >= ?'); params.push(from); }
  if (to)   { where.push('r.start_at <= ?'); params.push(to); }

  if (filter.status && filter.status !== 'all') {
    where.push('r.status = ?'); params.push(String(filter.status));
  }

  if (filter.q) {
    const q = `%${String(filter.q).trim()}%`;
    where.push(`(
      u.first_name  LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?
      OR r.customer_first LIKE ? OR r.customer_last LIKE ? OR r.email LIKE ? OR r.phone LIKE ?
    )`);
    params.push(q, q, q, q, q, q, q, q);
  }

  const sql = `
    SELECT
      r.*,

      -- Dati tavolo
      t.table_number AS table_number,
      t.room_id      AS room_id,
      CONCAT('Tavolo ', IFNULL(CAST(t.table_number AS CHAR), CHAR(63))) AS table_name,

      -- Dati utente (prefisso u_)
      u.id          AS u_id,
      u.first_name  AS u_first_name,
      u.last_name   AS u_last_name,
      u.email       AS u_email,
      u.phone       AS u_phone,

      -- Campi utili per il FE
      TRIM(CONCAT_WS(' ',
        COALESCE(NULLIF(u.first_name,''), NULLIF(r.customer_first,'')),
        COALESCE(NULLIF(u.last_name,''),  NULLIF(r.customer_last,''))
      )) AS display_name,

      COALESCE(NULLIF(u.phone,''),  NULLIF(r.phone,''))  AS contact_phone,
      COALESCE(NULLIF(u.email,''),  NULLIF(r.email,''))  AS contact_email
    FROM reservations r
    LEFT JOIN users  u ON u.id = r.user_id
    LEFT JOIN tables t ON t.id = r.table_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.start_at DESC, r.id DESC
  `;

  logger.info('📥 RESV list ▶️', { where, params, service: 'server' });
  return await query(sql, params);
}

// DETTAGLIO
async function getById(id) {
  const sql = `
    SELECT
      r.*,

      t.table_number AS table_number,
      t.room_id      AS room_id,
      CONCAT('Tavolo ', IFNULL(CAST(t.table_number AS CHAR), CHAR(63))) AS table_name,

      u.id          AS u_id,
      u.first_name  AS u_first_name,
      u.last_name   AS u_last_name,
      u.email       AS u_email,
      u.phone       AS u_phone,

      TRIM(CONCAT_WS(' ',
        COALESCE(NULLIF(u.first_name,''), NULLIF(r.customer_first,'')),
        COALESCE(NULLIF(u.last_name,''),  NULLIF(r.customer_last,''))
      )) AS display_name,

      COALESCE(NULLIF(u.phone,''),  NULLIF(r.phone,''))  AS contact_phone,
      COALESCE(NULLIF(u.email,''),  NULLIF(r.email,''))  AS contact_email
    FROM reservations r
    LEFT JOIN users  u ON u.id = r.user_id
    LEFT JOIN tables t ON t.id = r.table_id
    WHERE r.id = ?
    LIMIT 1
  `;
  const rows = await query(sql, [id]);
  return rows[0] || null;
}

// CREA prenotazione (calcola end_at se assente) + associa a users
async function create(dto) {
  const {
    customer_first = null,
    customer_last  = null,
    phone          = null,
    email          = null,
    party_size,
    start_at,           // atteso ISO (FE locale) o già DATETIME MySQL
    end_at   = null,    // opzionale: se null lo calcoliamo
    notes    = null,
    table_id = null,
    client_token = null,
  } = dto || {};

  if (!party_size || !start_at) {
    throw new Error('party_size e start_at sono obbligatori');
  }

  // 1) risolvi/crea utente e prendi user_id
  const userId = await ensureUser({
    first: customer_first,
    last : customer_last,
    email,
    phone,
  });

  // 2) calcola orari MySQL (o usa end_at se passato)
  const times = computeEndAtFromStart(start_at);
  const startMysql = times.startMysql;
  const endMysql   = end_at ? end_at : times.endMysql;

  // 3) INSERT con user_id (manteniamo anche i legacy per compatibilità)
  const sql = `
    INSERT INTO reservations
      (user_id, customer_first, customer_last, phone, email, party_size,
       start_at, end_at, notes, status, client_token, table_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `;

  const params = [
    userId,
    trimOrNull(customer_first),
    trimOrNull(customer_last),
    trimOrNull(phone),
    trimOrNull(email),
    Number(party_size) || 1,
    startMysql,
    endMysql,
    trimOrNull(notes),
    client_token,
    table_id || null
  ];

  const res = await query(sql, params);
  const id = res.insertId || res[0]?.insertId;

  const created = await getById(id);
  logger.info('✅ RESV create', { id, user_id: userId, service: 'server' });
  return created;
}

// ROOMS (supporto UI)
async function listRooms() {
  return await query(
    'SELECT id, name, is_active, sort_order FROM rooms ORDER BY sort_order ASC, id ASC',
    []
  );
}

// TABLES (supporto UI)
async function listTablesByRoom(roomId) {
  return await query(
    'SELECT id, room_id, table_number, seats AS capacity, status FROM tables WHERE room_id = ? ORDER BY table_number ASC, id ASC',
    [roomId]
  );
}

// Conteggi per status nel range from/to (YYYY-MM-DD). Usata per il badge “In attesa”.
async function countByStatus(filter = {}) {
  const where = ['1=1'];
  const params = [];

  const { from, to } = toDayRange(filter.from, filter.to);
  if (from) { where.push('r.start_at >= ?'); params.push(from); }
  if (to)   { where.push('r.start_at <= ?'); params.push(to); }

  const sql = `
    SELECT r.status, COUNT(*) AS n
    FROM reservations r
    WHERE ${where.join(' AND ')}
    GROUP BY r.status
  `;

  logger.info('📊 RESV count-by-status ▶️', { where, params, service: 'server' });
  const rows = await query(sql, params);

  const out = { pending: 0, accepted: 0, rejected: 0, cancelled: 0, total: 0 };
  for (const r of rows) {
    const s = String(r.status);
    const n = Number(r.n || 0);
    if (s in out) out[s] = n;
    out.total += n;
  }
  return out;
}

module.exports = {
  list,
  getById,
  create,
  listRooms,
  listTablesByRoom,
  countByStatus,
};

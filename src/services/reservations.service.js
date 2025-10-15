// src/services/reservations.service.js
// Service “Reservations” — query DB per prenotazioni
// Stile: commenti lunghi, log con emoji, diagnostica chiara.

const { query } = require('../db');
const logger = require('../logger');
const env = require('../env');

// --- Helpers data ------------------------------------------------------------

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
    where.push('(r.customer_first LIKE ? OR r.customer_last LIKE ? OR r.phone LIKE ? OR r.email LIKE ?)');
    params.push(q, q, q, q);
  }

  // === INIZIO MODIFICA (evita placeholder fantasma) ==========================
  // Problema: il driver può contare il '?' dentro le stringhe come placeholder.
  // Soluzione: non usare '?' letterale; usa CHAR(63) e CAST per table_number.
  const sql = `
    SELECT
      r.*,
      CONCAT('Tavolo ', IFNULL(CAST(t.table_number AS CHAR), CHAR(63))) AS table_name,
      t.table_number AS table_number,
      t.room_id      AS room_id
    FROM reservations r
    LEFT JOIN tables t ON t.id = r.table_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.start_at DESC, r.id DESC
  `;
  // === FINE MODIFICA =========================================================

  logger.info('📥 RESV list ▶️', { where, params, service: 'server' });
  return await query(sql, params);
}

// DETTAGLIO
async function getById(id) {
  // === INIZIO MODIFICA (come sopra: niente '?' letterale) ====================
  const sql = `
    SELECT
      r.*,
      CONCAT('Tavolo ', IFNULL(CAST(t.table_number AS CHAR), CHAR(63))) AS table_name,
      t.table_number AS table_number,
      t.room_id      AS room_id
    FROM reservations r
    LEFT JOIN tables t ON t.id = r.table_id
    WHERE r.id = ?
    LIMIT 1
  `;
  // === FINE MODIFICA =========================================================

  const rows = await query(sql, [id]);
  return rows[0] || null;
}

// CREA prenotazione (calcola end_at se assente)
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

  const times = computeEndAtFromStart(start_at);
  const startMysql = times.startMysql;
  const endMysql   = end_at ? end_at : times.endMysql;

  const sql = `
    INSERT INTO reservations
      (customer_first, customer_last, phone, email, party_size,
       start_at, end_at, notes, status, client_token, table_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `;

  const params = [
    customer_first, customer_last, phone, email, party_size,
    startMysql, endMysql, notes, client_token, table_id
  ];

  const res = await query(sql, params);
  const created = await getById(res.insertId);
  logger.info('✅ RESV create', { id: res.insertId, service: 'server' });
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
  // NOTA: niente “label” nel DB reale: esponiamo table_number e seats come capacity
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

// src/api/reservations.js
// Router REST per Prenotazioni — usa il service interno.
// Stile: commenti lunghi, log a emoji, errori espliciti.

'use strict';

const express = require('express');
const router = express.Router();

const logger = require('../logger');
const svc = require('../services/reservations.service'); // <-- usa il service vero


// utils piccoli
function trimOrNull(s) {
  const v = (s ?? '').toString().trim();
  return v ? v : null;
}

/**
 * ensureUser: trova o crea un utente e ritorna l'ID.
 * Strategia:
 *  - match per email (se presente)
 *  - altrimenti match per telefono (se presente)
 *  - altrimenti crea record con i campi disponibili
 */
async function ensureUser(conn, { first, last, email, phone }) {
  const emailT = trimOrNull(email);
  const phoneT = trimOrNull(phone);

  // 1) match per email
  if (emailT) {
    const [r1] = await conn.execute(
      'SELECT id FROM `users` WHERE email = ? LIMIT 1',
      [emailT]
    );
    if (r1.length) return r1[0].id;
  }

  // 2) match per telefono
  if (phoneT) {
    const [r2] = await conn.execute(
      'SELECT id FROM `users` WHERE phone = ? LIMIT 1',
      [phoneT]
    );
    if (r2.length) return r2[0].id;
  }

  // 3) crea
  const [ins] = await conn.execute(
    'INSERT INTO `users` (first_name, last_name, email, phone) VALUES (?,?,?,?)',
    [trimOrNull(first), trimOrNull(last), emailT, phoneT]
  );
  return ins.insertId;
}


// (in cima al file)
// === INIZIO MODIFICA STEP 4 — import requireAuth + service azioni ===
// const { requireAuth } = require('./auth'); // se già presente, ignora questa riga
const resvActions = require('../services/reservations-status.service');
// === FINE MODIFICA STEP 4 ===

// === INIZIO MODIFICA STEP 4 — requireAuth con fallback DEV ===================
// Se ./auth esporta requireAuth lo usiamo; altrimenti creiamo un fallback DEV
let requireAuth;
try {
  ({ requireAuth } = require('./auth'));
  if (typeof requireAuth !== 'function') throw new Error('requireAuth non è una funzione');
} catch (e) {
  logger.warn('⚠️ requireAuth non disponibile da ./auth. Uso FALLBACK DEV (solo per test locali).');
  requireAuth = (req, _res, next) => {
    // ⚠️ DEV ONLY: utente finto per testare le rotte protette senza JWT reale
    req.user = { id: 0, email: 'dev@local' };
    next();
  };
}
// === FINE MODIFICA STEP 4 — requireAuth con fallback DEV =====================


// GET /api/reservations?status=&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', async (req, res) => {
  try {
    const filter = {
      status: req.query.status || undefined,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      q: req.query.q || undefined
    };
    logger.info('📥 [GET] /api/reservations', { filter });
    const rows = await svc.list(filter);
    res.json(rows);
  } catch (err) {
    logger.error('❌ [GET] /api/reservations', { error: String(err) });
    res.status(500).json({ error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// === INIZIO MODIFICA (ordina rotte + evita conflitti con /:id) ===
// ✅ Spostate PRIMA le rotte /support/* per non farle catturare da /:id
// ✅ /:id ora accetta solo numeri con la regex (\\d+)
// ✅ Aggiunta guardia su id non numerico per sicurezza
// ─────────────────────────────────────────────────────────────────────────────

// Supporti UI ---------------------------------------------------------------

// GET /api/reservations/rooms
router.get('/rooms', async (_req, res) => {
  try {
    const rows = await svc.listRooms();
    res.json(rows);
  } catch (err) {
    logger.error('❌ [GET] /api/reservations/rooms', { error: String(err) });
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/reservations/support/tables/by-room/:roomId
router.get('/support/tables/by-room/:roomId(\\d+)', async (req, res) => {
  const roomId = Number(req.params.roomId);
  try {
    const rows = await svc.listTablesByRoom(roomId);
    res.json(rows);
  } catch (err) {
    logger.error('❌ [GET] /api/reservations/support/tables/by-room/:roomId', { roomId, error: String(err) });
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/reservations/support/count-by-status?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/support/count-by-status', async (req, res) => {
  try {
    const out = await svc.countByStatus({ from: req.query.from, to: req.query.to });
    res.json(out);
  } catch (err) {
    logger.error('❌ [GET] /api/reservations/support/count-by-status', { error: String(err) });
    res.status(500).json({ error: 'internal_error' });
  }
});

// =============================================================================
/** STEP 4 — AZIONI DI STATO + AUDIT */
// =============================================================================

// === INIZIO MODIFICA STEP 4 — PUT /api/reservations/:id/status ===
/**
* Cambia lo stato della prenotazione con motivazione e audit.
* Body: { action: 'accept'|'reject'|'cancel', reason?: string }
*
* NB: Questo router è montato a /api/reservations → il path qui è '/:id/status'
*/
router.put('/:id(\\d+)/status', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { action, reason } = req.body || {};
    if (!id || !action) return res.status(400).json({ error: 'id e action sono obbligatori' });

    const updated = await resvActions.updateStatus({
      reservationId: id,
      action,
      reason: typeof reason === 'string' ? reason.trim() : null,
      user: req.user, // \o/ dal JWT (o fallback DEV)
    });

    return res.json({ ok: true, reservation: updated });
  }   catch (err) {
  const code = err.statusCode || 500;
  // 🔎 log verboso
  logger.error('❌ [RESV] status change failed', {
    message: err.message,
    sql: err.sql,
    sqlMessage: err.sqlMessage,
    stack: err.stack,
  });
  // 🔎 manda al FE il dettaglio SQL se presente (aiuta il debug)
  return res.status(code).json({ error: err.sqlMessage || err.message });
}
});
// === FINE MODIFICA STEP 4 ===

// === INIZIO MODIFICA STEP 4 — GET /api/reservations/:id/audit ===
/**
 * Ritorna le ultime N righe di audit per la prenotazione (default 50)
 */
router.get('/:id(\\d+)/audit', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const limit = Number(req.query.limit || 50);
    const rows = await resvActions.getAudit({ reservationId: id, limit });
    return res.json({ ok: true, rows });
  } catch (err) {
    const code = err.statusCode || 500;
    logger.error(`❌ [RESV] audit fetch failed: ${err.message}`);
    return res.status(code).json({ error: err.message });
  }
});
// === FINE MODIFICA STEP 4 ===

// GET /api/reservations/:id  (SOLO numeri, grazie alla regex)
router.get('/:id(\\d+)', async (req, res) => {
  const raw = req.params.id;
  const id = Number(raw);

  // Guardia extra (in teoria inutile con la regex, ma meglio difensivo)
  if (!Number.isFinite(id)) {
    logger.warn('⚠️ [GET] /api/reservations/:id invalid id', { raw });
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    logger.info('📥 [GET] /api/reservations/:id', { id });
    const r = await svc.getById(id);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json(r);
  } catch (err) {
    logger.error('❌ [GET] /api/reservations/:id', { id, error: String(err) });
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/reservations  (crea prenotazione “pending”)
// body: { customer_first, customer_last, phone, email, party_size, start_at, notes, client_token, table_id? }
router.post('/', async (req, res) => {
  try {
    logger.info('✏️ [POST] /api/reservations', { body: req.body });
    const created = await svc.create(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    logger.error('❌ [POST] /api/reservations', { error: String(err) });
    res.status(500).json({ error: 'internal_error' });
  }
});


// === STAMPA TERMICA GIORNALIERA =============================================
const printerSvc = require('../services/thermal-printer.service');

router.post('/print/daily', requireAuth, async (req, res) => {
  try {
    const date = (req.body?.date || new Date().toISOString().slice(0,10));
    const status = req.body?.status || 'all';

    // prendi dati dal service che già usi in FE
    const rows = await svc.list({ from: date, to: date, status });

    const out = await printerSvc.printDailyReservations({
      date,
      rows,
      user: req.user
    });
    return res.json({ ok: true, job_id: out.jobId, printed_count: out.printedCount });
  } catch (err) {
    logger.error('❌ print/daily', { error: String(err) });
    return res.status(500).json({ error: err.message || String(err) });
  }
});



// === STAMPA SEGNAPOSTI (uno scontrino per prenotazione) ======================
router.post('/print/placecards', requireAuth, async (req, res) => {
  try {
    const date = (req.body?.date || new Date().toISOString().slice(0,10));
    const status = req.body?.status || 'accepted'; // default → solo confermate
    const qrBaseUrl = req.body?.qr_base_url || process.env.QR_BASE_URL || '';

    // prendi prenotazioni del giorno
    const rows = await svc.list({ from: date, to: date, status });

    const out = await printerSvc.printPlaceCards({
      date,
      rows,
      user: req.user,
      logoText: process.env.BIZ_NAME || 'LA MIA ATTIVITÀ',
      qrBaseUrl
    });

    return res.json({ ok: true, job_id: out.jobId, printed_count: out.printedCount });
  } catch (err) {
    logger.error('❌ print/placecards', { error: String(err) });
    return res.status(500).json({ error: err.message || String(err) });
  }
});


module.exports = router; // <-- fondamentale: esporta un Router, non un oggetto
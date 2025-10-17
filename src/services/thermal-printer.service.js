'use strict';

// === INIZIO MODIFICA (allineamento ENV + log) =================================
// Service di stampa “daily” e “placecards” che invia ESC/POS su TCP 9100.
// 🔧 FIX: usa PRINTER_IP (preferito) con fallback PRINTER_HOST (legacy).
// 🔎 Aggiunti log dettagliati su host/port/cols/codepage e conteggi.
// ==============================================================================

const net = require('net');
const iconv = require('iconv-lite');
const logger = require('../logger');

// 🧠 Preferiamo PRINTER_IP; se assente, usiamo PRINTER_HOST per retro-compat
const RESOLVED_HOST = process.env.PRINTER_IP || process.env.PRINTER_HOST || '127.0.0.1';
const RESOLVED_PORT = Number(process.env.PRINTER_PORT || 9100);
const WIDTH_MM      = Number(process.env.PRINTER_WIDTH_MM || 80);
const CODEPAGE      = (process.env.PRINTER_CODEPAGE || 'cp858').toLowerCase();
const COLS          = WIDTH_MM >= 70 ? 48 : 32; // 58mm≈32 col, 80mm≈48 col

// ESC/POS helpers --------------------------------------------------------------
const ESC = Buffer.from([0x1B]);
const GS  = Buffer.from([0x1D]);
const LF  = Buffer.from([0x0A]);

function cmd(...bytes) { return Buffer.from(bytes); }
const INIT         = Buffer.concat([ESC, Buffer.from('@')]);      // ESC @
const ALIGN_LEFT   = Buffer.concat([ESC, Buffer.from('a'), Buffer.from([0])]);
const ALIGN_CENTER = Buffer.concat([ESC, Buffer.from('a'), Buffer.from([1])]);
const BOLD_ON      = Buffer.concat([ESC, Buffer.from('E'), Buffer.from([1])]);
const BOLD_OFF     = Buffer.concat([ESC, Buffer.from('E'), Buffer.from([0])]);
const DOUBLE_ON    = Buffer.concat([GS,  Buffer.from('!'), Buffer.from([0x11])]); // doppia h/w
const DOUBLE_OFF   = Buffer.concat([GS,  Buffer.from('!'), Buffer.from([0x00])]);
const CUT_FULL     = Buffer.concat([GS,  Buffer.from('V'), Buffer.from([0])]);    // taglio

// selezione tabella caratteri (euro, italiano)
function selectCodepageBuffer() {
  // ESC t n — mappa comune (può variare per modello)
  const map = { cp437:0, cp850:2, cp858:19, cp852:18, cp1252:16 };
  const n = map[CODEPAGE] ?? 19;
  return Buffer.concat([ESC, Buffer.from('t'), Buffer.from([n])]);
}

function encode(text) {
  return iconv.encode(String(text || '').replace(/\r/g, ''), CODEPAGE, { addBOM:false });
}

function line(text='') {
  return Buffer.concat([ encode(text), LF ]);
}

function wrap(text, width = COLS) {
  const words = String(text || '').split(/\s+/);
  const rows = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { rows.push(cur); cur = w; }
  }
  if (cur) rows.push(cur);
  return rows;
}

function padRight(s, n) { return String(s || '').padEnd(n, ' '); }

function sendToPrinter(buffers) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: RESOLVED_HOST, port: RESOLVED_PORT }, () => {
      for (const b of buffers) socket.write(b);
      socket.end();
    });
    socket.setTimeout(8000);
    socket.on('timeout', () => { socket.destroy(new Error('timeout')); });
    socket.on('error', reject);
    socket.on('close', (hadErr) => hadErr ? reject(new Error('printer socket closed with error'))
                                          : resolve(true));
  });
}

// utils di formattazione -------------------------------------------------------
function formatTimeHHmm(start_at) {
  // DB manda "YYYY-MM-DD HH:mm:ss" (UTC) → leggiamola come UTC
  const s = String(start_at || '');
  const d = s.includes('T') ? new Date(s) : new Date(s.replace(' ', 'T') + 'Z');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
function up(s) { return (s || '').toString().toUpperCase(); }

// === DAILY ===================================================================
/**
 * Stampa UN unico scontrino con il riepilogo prenotazioni del giorno.
 * rows: array prenotazioni { start_at, table_number, table_id, party_size, customer_first, customer_last, phone, notes, ... }
 */
async function printDailyReservations({ date, rows, user }) {
  logger.info('🖨️ DAILY begin', {
    date, rows: rows?.length || 0, host: RESOLVED_HOST, port: RESOLVED_PORT, cols: COLS, codepage: CODEPAGE
  });

  const out = [];
  out.push(INIT, selectCodepageBuffer(), ALIGN_CENTER, BOLD_ON, DOUBLE_ON);
  out.push(line('PRENOTAZIONI'));
  out.push(DOUBLE_OFF, BOLD_OFF);

  const fmtDate = new Intl.DateTimeFormat('it-IT', {
    weekday:'long', day:'2-digit', month:'2-digit', year:'numeric'
  }).format(new Date(date + 'T00:00:00'));
  out.push(line(fmtDate.toUpperCase()));
  out.push(line('-'.repeat(COLS)));

  // intestazione
  out.push(ALIGN_LEFT, BOLD_ON);
  out.push(line(padRight('ORA',5) + ' ' + padRight('TAV',4) + ' ' + padRight('PAX',3) + ' ' + padRight('NOME', COLS-5-1-4-1-3-1)));
  out.push(BOLD_OFF, line('-'.repeat(COLS)));

  // ordiniamo per orario
  rows.sort((a,b) => String(a.start_at).localeCompare(String(b.start_at)));

  for (const r of rows) {
    const time = formatTimeHHmm(r.start_at);
    const tav  = (r.table_number || r.table_id || '-').toString();
    const pax  = (r.party_size || '-').toString();
    const name = ((r.customer_first || '') + ' ' + (r.customer_last || '')).trim() || '—';

    // riga 1: ORA TAV PAX NOME (wrap)
    const left = `${padRight(time,5)} ${padRight(tav,4)} ${padRight(pax,3)} `;
    const nameWidth = COLS - left.length;
    const nameRows = wrap(name, nameWidth);
    out.push(line(left + padRight(nameRows[0] || '', nameWidth)));
    for (let i=1;i<nameRows.length;i++) out.push(line(' '.repeat(left.length) + nameRows[i]));

    // telefono
    if (r.phone) out.push(line(' '.repeat(left.length) + String(r.phone)));

    // note (wrappate)
    if (r.notes) {
      const notesRows = wrap('NOTE: ' + r.notes, COLS - left.length);
      for (const rr of notesRows) out.push(line(' '.repeat(left.length) + rr));
    }

    // separatore
    out.push(line(' '.repeat(COLS)));
  }

  out.push(line('-'.repeat(COLS)));
  out.push(ALIGN_CENTER, line(`Operatore: ${user?.email || 'sistema'}`));
  out.push(line(''), line(''), CUT_FULL);

  await sendToPrinter(out);
  return { jobId: `daily_${Date.now()}`, printedCount: rows.length };
}

// === PLACE CARDS =============================================================
// ESC/POS QR commands (Model 2)
function qrStoreData(data) {
  const payload = encode(data);
  const len = payload.length + 3;
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  return Buffer.concat([
    GS, Buffer.from('('), Buffer.from('k'),
    Buffer.from([pL, pH, 0x31, 0x50, 0x30]),
    payload
  ]);
}
function qrSetModuleSize(size = 6) {
  const s = Math.max(1, Math.min(16, size));
  return Buffer.concat([GS, Buffer.from('('), Buffer.from('k'), Buffer.from([0x03,0x00,0x31,0x43,s])]);
}
function qrSetECC(level = 51 /* '3' → H */) {
  return Buffer.concat([GS, Buffer.from('('), Buffer.from('k'), Buffer.from([0x03,0x00,0x31,0x45,level])]);
}
function qrPrint() {
  return Buffer.concat([GS, Buffer.from('('), Buffer.from('k'), Buffer.from([0x03,0x00,0x31,0x51,0x30])]);
}

function formatDateHuman(d) {
  return new Intl.DateTimeFormat('it-IT', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' }).format(d);
}

function buildOnePlaceCardBuffers(r, opts = {}) {
  const cols = WIDTH_MM >= 70 ? 48 : 32;
  const out = [];

  const time = formatTimeHHmm(r.start_at);
  const d = String(r.start_at || '');
  const dateObj = d.includes('T') ? new Date(d) : new Date(d.replace(' ', 'T') + 'Z');
  const dateHuman = formatDateHuman(dateObj);
  const tav  = (r.table_number || r.table_id || '-').toString();
  const pax  = (r.party_size || '-').toString();
  const sala = r.room_name || r.room || r.room_id || '-';
  const name = up(((r.customer_last || '') + ' ' + (r.customer_first || '')).trim() || 'OSPITE');

  out.push(INIT, selectCodepageBuffer(), ALIGN_CENTER);
  if (opts.logoText) {
    out.push(BOLD_ON, line(opts.logoText), BOLD_OFF);
  } else {
    out.push(line('<< LOGO >>'));
  }

  out.push(DOUBLE_ON, BOLD_ON, line(`TAVOLO ${tav}`), BOLD_OFF, DOUBLE_OFF);
  out.push(DOUBLE_ON, line(name), DOUBLE_OFF);
  out.push(BOLD_ON, line(`${time}  •  ${dateHuman}`), BOLD_OFF);
  out.push(line(`SALA: ${sala}   •   COPERTI: ${pax}`), line(''));

  const qrContent = opts.qrBaseUrl
    ? `${opts.qrBaseUrl.replace(/\/+$/,'')}/table/${r.table_id || r.table_number || ''}`
    : null;

  if (qrContent) {
    out.push(ALIGN_CENTER, qrSetModuleSize(6), qrSetECC(51), qrStoreData(qrContent), qrPrint());
    out.push(line(''), line('Scansiona il QR del tavolo'));
  }

  out.push(line(''), CUT_FULL);
  return out;
}

async function printPlaceCards({ date, rows, user, logoText, qrBaseUrl }) {
  logger.info('🖨️ PLACECARDS begin', {
    date, rows: rows?.length || 0, host: RESOLVED_HOST, port: RESOLVED_PORT, cols: COLS, codepage: CODEPAGE
  });

  const buffers = [];
  for (const r of rows) buffers.push(...buildOnePlaceCardBuffers(r, { logoText, qrBaseUrl }));

  await sendToPrinter(buffers);
  return { jobId: `placecards_${Date.now()}`, printedCount: rows.length };
}

module.exports = {
  printDailyReservations,
  printPlaceCards,
};

// === FINE MODIFICA ===========================================================

'use strict';
const net = require('net');
const iconv = require('iconv-lite');
const logger = require('../logger');

const HOST = process.env.PRINTER_HOST || '192.168.2.182';
const PORT = Number(process.env.PRINTER_PORT || 9100);
const WIDTH_MM = Number(process.env.PRINTER_WIDTH_MM || 80);
const CODEPAGE = (process.env.PRINTER_CODEPAGE || 'cp858').toLowerCase();

// colonne tipiche: ~32 per 58mm, ~48 per 80mm
const COLS = WIDTH_MM >= 70 ? 48 : 32;

// ESC/POS helpers -------------------------------------------------------------
const ESC = Buffer.from([0x1B]);
const GS  = Buffer.from([0x1D]);
const LF  = Buffer.from([0x0A]);

function cmd(...bytes) { return Buffer.from(bytes); }
const INIT        = Buffer.concat([ESC, Buffer.from('@')]);      // ESC @
const ALIGN_LEFT  = Buffer.concat([ESC, Buffer.from('a'), Buffer.from([0])]);
const ALIGN_CENTER= Buffer.concat([ESC, Buffer.from('a'), Buffer.from([1])]);
const BOLD_ON     = Buffer.concat([ESC, Buffer.from('E'), Buffer.from([1])]);
const BOLD_OFF    = Buffer.concat([ESC, Buffer.from('E'), Buffer.from([0])]);
const DOUBLE_ON   = Buffer.concat([GS,  Buffer.from('!'), Buffer.from([0x11])]); // double h+w
const DOUBLE_OFF  = Buffer.concat([GS,  Buffer.from('!'), Buffer.from([0x00])]);
const CUT_FULL    = Buffer.concat([GS,  Buffer.from('V'), Buffer.from([0])]);    // taglio

// alcune stampanti richiedono selezione tabella caratteri
function selectCodepageBuffer() {
  // ESC t n — molti modelli: 0=437, 2=850, 19=858 (euro)
  const map = { cp437:0, cp850:2, cp858:19, cp852:18, cp1252:16 };
  const n = map[CODEPAGE] ?? 19;
  return Buffer.concat([ESC, Buffer.from('t'), Buffer.from([n])]);
}

function encode(text) {
  // sostituisci caratteri non mappati
  return iconv.encode(text.replace(/\r/g, ''), CODEPAGE, { addBOM:false });
}

function line(text='') {
  return Buffer.concat([ encode(text), LF ]);
}

function wrap(text, width = COLS) {
  const words = (text || '').split(/\s+/);
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

function padRight(s, n) { return (s || '').padEnd(n, ' '); }
function padLeft(s, n)  { return (s || '').padStart(n, ' '); }

// TCP send --------------------------------------------------------------------
function sendToPrinter(buffers) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT }, () => {
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

// Public API ------------------------------------------------------------------
/**
 * rows: array di prenotazioni (usa la tua svc.list)
 * Formato termico 48/32 colonne: ORA TAV PAX NOME / TEL / NOTE
 */
async function printDailyReservations({ date, rows, user, widthMm = WIDTH_MM }) {
  const cols = widthMm >= 70 ? 48 : 32;
  const out = [];

  out.push(INIT, selectCodepageBuffer(), ALIGN_CENTER, BOLD_ON, DOUBLE_ON);
  out.push(line('PRENOTAZIONI'));
  out.push(DOUBLE_OFF, BOLD_OFF);

  const fmtDate = new Intl.DateTimeFormat('it-IT', {
    weekday:'long', day:'2-digit', month:'2-digit', year:'numeric'
  }).format(new Date(date + 'T00:00:00'));
  out.push(line(fmtDate.toUpperCase()));
  out.push(line('-'.repeat(cols)));

  // intestazione tabella
  out.push(ALIGN_LEFT, BOLD_ON);
  out.push(line(padRight('ORA',5) + ' ' + padRight('TAV',4) + ' ' + padRight('PAX',3) + ' ' + padRight('NOME', cols-5-1-4-1-3-1)));
  out.push(BOLD_OFF, line('-'.repeat(cols)));

  // ordina per orario
  rows.sort((a,b) => String(a.start_at).localeCompare(String(b.start_at)));

  for (const r of rows) {
    const time = formatTimeHHmm(r.start_at); // 14:30
    const tav  = (r.table_number || r.table_id || '-').toString();
    const pax  = (r.party_size || '-').toString();
    const name = ((r.customer_first || '') + ' ' + (r.customer_last || '')).trim() || '—';

    // riga 1: ORA TAV PAX NOME (troncata/piegata)
    const left = `${padRight(time,5)} ${padRight(tav,4)} ${padRight(pax,3)} `;
    const nameWidth = cols - left.length;
    const nameRows = wrap(name, nameWidth);
    out.push(line(left + padRight(nameRows[0] || '', nameWidth)));
    for (let i=1;i<nameRows.length;i++) out.push(line(' '.repeat(left.length) + nameRows[i]));

    // riga 2: telefono
    if (r.phone) out.push(line(' '.repeat(left.length) + String(r.phone)));

    // riga 3+: note wrappate
    if (r.notes) {
      const notesRows = wrap('NOTE: ' + r.notes, cols - left.length);
      for (const rr of notesRows) out.push(line(' '.repeat(left.length) + rr));
    }

    out.push(line(' '.repeat(cols))); // riga vuota separatrice
  }

  out.push(line('-'.repeat(cols)));
  out.push(ALIGN_CENTER, line(`Operatore: ${user?.email || 'sistema'}`));
  out.push(line(''), line(''), CUT_FULL);

  logger.info('🖨️ Invio a termica', { host: HOST, port: PORT, rows: rows.length, cols });
  await sendToPrinter(out);
  return { jobId: `job_${Date.now()}`, printedCount: rows.length };
}

// utils
function formatTimeHHmm(start_at) {
  // nel tuo driver MySQL usi dateStrings: true → stringa "YYYY-MM-DD HH:mm:ss"
  const s = String(start_at || '');
  // supporta anche ISO
  const d = s.includes('T') ? new Date(s) : new Date(s.replace(' ', 'T')+'Z'); // sessione DB in UTC
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}



// ============ PLACE CARDS (SEGNAPOSTO) =======================================
// ESC/POS QR helpers (Model 2)
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
  // size 1..16
  const s = Math.max(1, Math.min(16, size));
  return Buffer.concat([GS, Buffer.from('('), Buffer.from('k'), Buffer.from([0x03,0x00,0x31,0x43,s])]);
}
function qrSetECC(level = 51 /* '3' → H */) {
  // 48=L,49=M,50=Q,51=H
  return Buffer.concat([GS, Buffer.from('('), Buffer.from('k'), Buffer.from([0x03,0x00,0x31,0x45,level])]);
}
function qrPrint() {
  return Buffer.concat([GS, Buffer.from('('), Buffer.from('k'), Buffer.from([0x03,0x00,0x31,0x51,0x30])]);
}
function up(s) { return (s || '').toString().toUpperCase(); }

function formatDateHuman(d) {
  return new Intl.DateTimeFormat('it-IT', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' }).format(d);
}

// Stampa UN segnaposto per UNA prenotazione
function buildOnePlaceCardBuffers(r, opts = {}) {
  const cols = (opts.widthMm || WIDTH_MM) >= 70 ? 48 : 32;
  const out = [];

  // Calcoli base
  const time = formatTimeHHmm(r.start_at);
  const d = String(r.start_at || '');
  const dateObj = d.includes('T') ? new Date(d) : new Date(d.replace(' ', 'T') + 'Z');
  const dateHuman = formatDateHuman(dateObj); // martedì 14/10/2025
  const tav  = (r.table_number || r.table_id || '-').toString();
  const pax  = (r.party_size || '-').toString();
  const sala = r.room_name || r.room || r.room_id || '-';
  const name = up(((r.customer_last || '') + ' ' + (r.customer_first || '')).trim() || 'OSPITE');

  // HEADER + LOGO (placeholder testuale per ora)
  out.push(INIT, selectCodepageBuffer(), ALIGN_CENTER);
  if (opts.logoText) {
    out.push(BOLD_ON, line(opts.logoText), BOLD_OFF);
  } else {
    // TODO: sostituire con stampa bitmap logo (ESC * / GS v 0)
    out.push(line('<< LOGO >>'));
  }

  // TAVOLO grande
  out.push(DOUBLE_ON, BOLD_ON);
  out.push(line(`TAVOLO ${tav}`));
  out.push(BOLD_OFF, DOUBLE_OFF);

  // Nome grande
  out.push(DOUBLE_ON, line(name));
  out.push(DOUBLE_OFF);

  // Riga info
  out.push(BOLD_ON);
  out.push(line(`${time}  •  ${dateHuman}`));
  out.push(BOLD_OFF);

  out.push(line(`SALA: ${sala}   •   COPERTI: ${pax}`));
  out.push(line(''));

  // QR del tavolo (se base URL presente)
  const qrContent = opts.qrBaseUrl
    ? `${opts.qrBaseUrl.replace(/\/+$/,'')}/table/${r.table_id || r.table_number || ''}`
    : null;

  if (qrContent) {
    out.push(ALIGN_CENTER);
    out.push(qrSetModuleSize(6)); // dimensione
    out.push(qrSetECC(51));       // H
    out.push(qrStoreData(qrContent));
    out.push(qrPrint());
    out.push(line('')); // spazio sotto
    out.push(line('Scansiona il QR del tavolo'));
  }

  out.push(line(''));
  out.push(CUT_FULL);
  return out;
}

/**
 * Stampa un segnaposto per OGNI prenotazione passata.
 * @param {Object} params
 * @param {string} params.date  - YYYY-MM-DD (solo per log/display)
 * @param {Array}  params.rows  - elenco prenotazioni
 * @param {Object} params.user  - utente
 * @param {string} [params.logoText]  - testo logo (placeholder)
 * @param {string} [params.qrBaseUrl] - base url per QR (es. https://mio.sito/qr)
 */
async function printPlaceCards({ date, rows, user, logoText, qrBaseUrl }) {
  const buffers = [];
  for (const r of rows) {
    buffers.push(...buildOnePlaceCardBuffers(r, { widthMm: WIDTH_MM, logoText, qrBaseUrl }));
  }
  logger.info('🖨️ Segnaposti → invio', { date, count: rows.length, host: HOST, port: PORT });
  await sendToPrinter(buffers);
  return { jobId: `placecards_${Date.now()}`, printedCount: rows.length };
}

module.exports = {
  printDailyReservations,
  printPlaceCards,
};
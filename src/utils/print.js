// 🖨️ Stampa ESC/POS: TCP 9100 (raw) + fallback file .txt in /receipts
const net = require('net');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');   // ✅ istanza diretta

function format(order, cfg) {
  const L = [];
  const pad = (l,r,w=42)=>{ l=String(l); r=String(r); const s=Math.max(1,w-(l.length+r.length)); return l+' '.repeat(s)+r; };
  (cfg.header||[]).forEach(h => L.push(h));
  L.push('-'.repeat(42));
  if (order.id) L.push(pad('Ordine #', order.id));
  if (order.created_at) L.push(pad('Data', String(order.created_at)));
  L.push('-'.repeat(42));
  (order.items||[]).forEach(it => {
    const left = `${it.qty||1}x ${it.product_name || it.name || 'Item'}`;
    const right = `€ ${(Number(it.price||0)*(it.qty||1)).toFixed(2)}`;
    L.push(pad(left, right));
    if (it.notes) L.push('  Note: ' + it.notes);
  });
  L.push('-'.repeat(42));
  L.push(pad('TOTALE', `€ ${Number(order.total||0).toFixed(2)}`));
  if (cfg.footer) { L.push(''); L.push(cfg.footer); }
  L.push(''); L.push('');
  return L.join('\n');
}

function fallback(order, text, err) {
  const dir = path.join(process.cwd(), 'receipts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `receipt-${order.id||'na'}-${Date.now()}.txt`);
  fs.writeFileSync(file, text);
  logger.error('🖨️ PRINT fallback', { file, error: String(err) });
}

async function printOrder(order, cfg) {
  const text = format(order, cfg);
  if (!cfg.enabled) return fallback(order, text, 'disabled');

  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let done = false;
    sock.setTimeout(3000);
    sock.on('connect', () => { sock.write(text); sock.end(); });
    sock.on('close', () => { if (!done) { done=true; logger.info('🖨️ PRINT ok', { ip: cfg.ip, port: cfg.port }); resolve(); } });
    sock.on('timeout', () => sock.destroy(new Error('timeout')));
    sock.on('error', (e) => { if (!done) { done=true; fallback(order, text, e); reject(e); } });
    sock.connect(cfg.port, cfg.ip);
  });
}

module.exports = { printOrder };

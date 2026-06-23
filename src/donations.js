// Payblis Checkout Mode integration per donazioni.
//
// Flusso:
//   1. Frontend POST /api/donate con { amount, email, name }
//   2. Backend valida + costruisce URL Payblis firmato
//   3. Frontend redirect a pay.payblis.com → utente paga
//   4. Payblis redirect a /donate/ok o /donate/ko
//   5. Payblis manda IPN server-to-server a /donate/ipn (log per tracking)
//
// Payblis usa PHP serialize() (NON JSON) per il token. Implementiamo un
// mini-serializer compatibile (20 righe, zero deps).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAYBLIS_ENDPOINT = 'https://pay.payblis.com/api/payment_gateway.php';
const STORE_NAME = process.env.PAYBLIS_STORE_NAME || 'ItaHub';
const SANDBOX = (process.env.PAYBLIS_SANDBOX || '').toLowerCase() === 'true';

// PHP serialize() per associative arrays con solo string keys/values.
// Output esattamente compatibile con PHP serialize() (verified via plugin
// WooCommerce ufficiale Payblis). Byte length per le string, non char length.
function phpSerialize(obj) {
  const entries = Object.entries(obj);
  let out = `a:${entries.length}:{`;
  for (const [k, v] of entries) {
    out += phpStr(String(k));
    out += phpStr(String(v));
  }
  out += '}';
  return out;
}
function phpStr(s) {
  return `s:${Buffer.byteLength(s, 'utf8')}:"${s}";`;
}

// Validation: amount min 1€, email + name non-empty.
function validateDonation({ amount, email, name }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 1) return 'Importo minimo: 1€';
  // No max — l'utente ha disabilitato il cap
  const e = String(email || '').trim();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Email non valida';
  const n = String(name || '').trim();
  if (!n || n.length < 2) return 'Nome richiesto';
  return null;
}

// Genera RefOrder univoca: donation-{timestamp ms}-{6 char random}
function generateRefOrder() {
  return `donation-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// Costruisce URL Payblis per redirect. Ritorna { url, refOrder }.
function buildCheckoutUrl({ amount, email, name, userIP, publicHost }) {
  const merchantKey = process.env.PAYBLIS_MERCHANT_KEY;
  if (!merchantKey) throw new Error('PAYBLIS_MERCHANT_KEY not configured');

  // Split nome in firstName + lastName (Payblis vuole due campi)
  const parts = String(name).trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || parts[0] || '';

  const refOrder = generateRefOrder();
  // Checkout Mode standard (esempio ufficiale Payblis): method=credit_cards,
  // niente provider_or (è solo per Direct Provider Mode). Payblis mostra il
  // suo selettore di provider all'utente filtrato per credit_cards.
  const data = {
    MerchantKey: merchantKey,
    amount: Number(amount).toFixed(2),
    currency: 'EUR',
    product_name: 'Donazione ItaHub',
    method: 'credit_cards',
    RefOrder: refOrder,
    Customer_Email: String(email).trim(),
    Customer_Name: lastName,
    Customer_FirstName: firstName,
    country: 'IT',
    userIP: userIP || '',
    lang: 'it',
    store_name: STORE_NAME,
    urlOK: `${publicHost}/donate/ok?ref=${encodeURIComponent(refOrder)}`,
    urlKO: `${publicHost}/donate/ko?ref=${encodeURIComponent(refOrder)}`,
    ipnURL: `${publicHost}/donate/ipn`,
  };
  if (SANDBOX) data.sandbox = 'true';

  const serialized = phpSerialize(data);
  const token = Buffer.from(serialized, 'utf8').toString('base64');
  return { url: `${PAYBLIS_ENDPOINT}?token=${token}`, refOrder };
}

// Verifica firma IPN (callback server-to-server da Payblis).
// Plugin WooCommerce usa hash_hmac('sha256', json_encode(data_no_sig), secretKey).
// Confronto timing-safe per evitare leak via timing attacks.
function verifyIpnSignature(body, receivedSignature) {
  const secretKey = process.env.PAYBLIS_SECRET_KEY;
  if (!secretKey || !receivedSignature) return false;
  try {
    const clone = { ...body };
    delete clone.signature;
    const expected = crypto.createHmac('sha256', secretKey)
      .update(JSON.stringify(clone))
      .digest('hex');
    if (expected.length !== receivedSignature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSignature));
  } catch (_) {
    return false;
  }
}

// Log donazioni su file locale per tracking (no DB).
// Append-only JSON Lines. Una riga per evento IPN.
const DONATIONS_LOG = process.env.DONATIONS_LOG_PATH
  || path.join(process.env.HOME || '/tmp', '.itahub-donations.log');

function logDonation(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(DONATIONS_LOG, line, 'utf8');
  } catch (e) {
    console.error('[donations] log err:', e.message);
  }
}

module.exports = {
  validateDonation,
  buildCheckoutUrl,
  verifyIpnSignature,
  logDonation,
  phpSerialize, // exported for tests
};

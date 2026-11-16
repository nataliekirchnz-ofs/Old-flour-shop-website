// netlify/functions/stripe-webhook.js
//
// This function is called directly by Stripe (not by your website) the
// moment a payment actually succeeds. This is more reliable than only
// emailing on the browser's return trip from Stripe, because it fires
// even if the customer closes their browser tab right after paying.
//
// It verifies the request really came from Stripe (using a signing
// secret), then:
//   1. logs the order as a row in Airtable, so staff can see upcoming
//      orders in one place without digging through Stripe or email
//   2. sends an order notification email to the bakery
//   3. sends a branded order confirmation email to the customer
//   4. (optional) texts a short new-order alert to the staff phone via
//      TNZ. Staff only — customers are never texted.
//
// Setup required (see README.md for the full walkthrough):
//   1. Create a free account at https://resend.com, get an API key,
//      add it in Netlify as RESEND_API_KEY
//   2. In Stripe Dashboard -> Developers -> Webhooks -> Add endpoint:
//        URL:    https://YOUR-SITE.netlify.app/.netlify/functions/stripe-webhook
//        Events: checkout.session.completed
//                checkout.session.async_payment_succeeded
//      Stripe will show you a "Signing secret" (starts with whsec_...) —
//      add that in Netlify as STRIPE_WEBHOOK_SECRET
//   3. Add BAKERY_NOTIFICATION_EMAIL in Netlify — the address that
//      should receive new-order emails (defaults to
//      theoldflourshop@gmail.com if not set)
//   4. Create an Airtable base with a table matching the field names
//      below, get an API token, add AIRTABLE_API_KEY, AIRTABLE_BASE_ID
//      and AIRTABLE_TABLE_NAME in Netlify — see README.md for the
//      exact steps and field names to create
//   5. (optional) For staff text alerts, add TNZ_AUTH_TOKEN in Netlify
//      (from the TNZ Dashboard: Users -> your user -> API tab -> Auth
//      Token). Texts go to +64273399264, or STAFF_SMS_NUMBER if set.
//      Add TNZ_TEST_MODE = true to check the connection without sending
//      real texts (TNZ reports success but sends nothing); remove it to
//      go live.

const crypto = require('crypto');

// The values below (customer name, phone, cake message,
// delivery address) are all free text the customer typed at checkout.
// They're embedded directly into HTML email templates further down, so
// they're escaped first — otherwise something like `<a href=...>` typed
// into a cake message would render as a real link in the bakery's inbox.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// REPEATS AND RETRIES — Stripe can deliver the same payment more than
// once (its own retries, or ours: this function asks Stripe to try again
// whenever something temporary goes wrong). Every step is written so a
// repeat is safe:
//   - the Airtable row is only created if it isn't there already;
//   - each email is sent with a fixed "idempotency key" made from the
//     order, so Resend sends it at most once (Resend remembers keys for
//     24 hours) — a repeat simply re-sends any email that didn't go
//     out the first time, and skips the ones that did;
//   - the staff text only goes out on the run that created the order.
//
// This Set lives at module scope, so it persists for the lifetime of a
// warm Netlify function container — a fast, free first check for an order
// this container has already finished completely.
const processedEventIds = new Set();

// Looks the order up in Airtable by its Stripe session ID. Returns:
//   'found'   — already saved by an earlier run
//   'missing' — not saved yet
//   'retry'   — Airtable couldn't be reached or was busy; try again later
//   'setup'   — Airtable refused because of how it's set up (wrong token,
//               base, table or column name); retrying won't fix that
async function findOrderInAirtable(sessionId, apiKey, baseId, tableName, timeoutMs) {
  try {
    const formula = encodeURIComponent(`{Stripe Session ID}='${sessionId}'`);
    const res = await fetch(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?filterByFormula=${formula}&maxRecords=1`,
      { headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) }
    );
    if ([401, 403, 404, 422].includes(res.status)) return 'setup';
    if (!res.ok) return 'retry';
    const data = await res.json();
    return Array.isArray(data.records) && data.records.length > 0 ? 'found' : 'missing';
  } catch (e) {
    return 'retry';
  }
}

// If the same payment arrives twice at the same moment, both copies can
// find "missing" and both save a row. So right after saving, each copy
// looks again: if there's more than one row for this order, only the
// earliest-saved one is kept and any later copy removes the row it just
// made itself. Both copies see the same rows, so exactly one survives.
// Returns true if this run's row is the one kept (or the check couldn't
// be done — the row is then simply left in place).
async function keepOnlyFirstRow(sessionId, myRecordId, apiKey, baseId, tableName, timeoutMs) {
  const table = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
  try {
    const formula = encodeURIComponent(`{Stripe Session ID}='${sessionId}'`);
    const res = await fetch(`${table}?filterByFormula=${formula}&maxRecords=10`,
      { headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return true;
    const rows = ((await res.json()).records || []).slice()
      .sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id));
    if (rows.length < 2 || rows[0].id === myRecordId) return true;
    await fetch(`${table}/${myRecordId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) })
      .catch(() => {});
    console.error('Same payment arrived twice at once — removed the extra Airtable row', myRecordId);
    return false;
  } catch (e) {
    return true;
  }
}

// Sends one email through Resend. The idempotency key means a repeat of
// the same order never sends the same email twice. Returns:
//   'sent'      — sent now, or already sent by an earlier run
//   'retry'     — temporary problem (no response, busy, Resend down)
//   'failed'    — Resend refused it for good (e.g. an invalid address);
//                 retrying wouldn't help, so it's only logged
async function sendEmail(apiKey, idempotencyKey, email, label, timeoutMs) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.ok) return 'sent';
    const detail = await res.text().catch(() => '');
    if (res.status === 409) {
      // Same key seen before. "concurrent" = an earlier run is sending it
      // right now (check again later); otherwise it was already sent.
      if (/concurrent/i.test(detail)) return 'retry';
      return 'sent';
    }
    console.error(`Resend error (${label}):`, res.status, detail);
    return (res.status === 429 || res.status >= 500) ? 'retry' : 'failed';
  } catch (err) {
    console.error(`Failed to send ${label}:`, err.name === 'TimeoutError' ? `no response within ${Math.round(timeoutMs / 1000)} seconds` : err);
    return 'retry';
  }
}

// ── Staff text alert (TNZ) ──────────────────────────────────────────────
// Texts the staff phone when a new order comes in. Staff only — customers
// are never texted. Uses TNZ's REST API v3.00 ("Send SMS",
// https://api.tnz.co.nz/api/v3.00/sms). Switched off unless
// TNZ_AUTH_TOKEN is set in Netlify.

// Characters like en dashes (–), curly quotes, macrons and emoji aren't in
// the standard SMS alphabet; one of them switches the whole text to an
// encoding that fits 70 characters per part instead of 160, so the text
// costs more. They're swapped for plain equivalents first (TNZ's own
// CharacterConversion option is also switched on as a backstop).
function toPlainSms(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // ā → a, é → e
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Sends one text. Never throws, and gives up once the time it's given
// runs out, so a problem at TNZ can never hold up or break order processing.
// TNZ's docs mention both "Bearer" and "Basic" for the Authorization
// header, so "Bearer" is tried first and "Basic" only if that's refused.
async function sendStaffSms({ token, to, body, reference, testMode, timeLeft }) {
  const payload = JSON.stringify({
    ToNumber: to,
    Message: toPlainSms(body),
    Reference: reference,            // shows in the TNZ Dashboard
    CharacterConversion: true,
    ...(testMode ? { Mode: 'Test' } : {})   // Test = TNZ reports success, sends nothing
  });
  for (const scheme of ['Bearer', 'Basic']) {
    try {
      const res = await fetch('https://api.tnz.co.nz/api/v3.00/sms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `${scheme} ${token}`
        },
        body: payload,
        signal: AbortSignal.timeout(timeLeft())
      });
      if (res.ok) return;
      const detail = await res.text().catch(() => '');
      if (res.status === 401 && scheme === 'Bearer') continue;   // try "Basic"
      // 401 on both = the TNZ_AUTH_TOKEN in Netlify is wrong, or was
      // refreshed in the TNZ Dashboard (which cancels the old one).
      console.error('TNZ SMS error:', res.status, detail);
      return;
    } catch (err) {
      console.error('Failed to send staff SMS via TNZ:', err.name === 'TimeoutError' ? 'no response in the time available' : err);
      return;
    }
  }
}

// How old a Stripe message can be before it's rejected. Stripe's own
// libraries use 5 minutes. This stops an old, genuine message that someone
// managed to copy from being replayed later.
const SIGNATURE_TOLERANCE_SECONDS = 300;

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  // The header looks like "t=123,v1=abc,v1=def". There can be more than
  // one v1 signature (e.g. while Stripe is rotating the secret), so all of
  // them are collected, and any one matching is enough.
  let timestamp = null;
  const signatures = [];
  for (const part of sigHeader.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex'),
    'hex'
  );

  // constant-time comparison against each signature
  return signatures.some(sig => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const b = Buffer.from(sig, 'hex');
    return b.length === expected.length && crypto.timingSafeEqual(expected, b);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const BAKERY_EMAIL = process.env.BAKERY_NOTIFICATION_EMAIL || 'theoldflourshop@gmail.com';
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Orders';
  // Emails need an absolute image URL (unlike the website, which can use
  // relative paths) — this must be your real live domain.
  const SITE_URL = process.env.SITE_URL || 'https://www.theoldflourshop.co.nz';
  const TNZ_AUTH_TOKEN = process.env.TNZ_AUTH_TOKEN || '';
  const STAFF_SMS_NUMBER = process.env.STAFF_SMS_NUMBER || '+64273399264'; // staff phone

  // Netlify stops this function after 10 seconds, wherever it's got to.
  // Every outside call below is given only part of that time, so the
  // function always finishes (and replies to Stripe) inside the limit,
  // rather than being cut off part-way through, e.g. mid-text.
  const startedAt = Date.now();
  const DEADLINE_MS = 8500;
  const timeLeft = (cap = DEADLINE_MS) => Math.max(1000, Math.min(cap, DEADLINE_MS - (Date.now() - startedAt)));

  if (!STRIPE_WEBHOOK_SECRET || !RESEND_API_KEY) {
    console.error('Missing STRIPE_WEBHOOK_SECRET or RESEND_API_KEY environment variable.');
    return { statusCode: 500, body: 'Server not configured.' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const isValid = verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);

  if (!isValid) {
    console.error('Invalid Stripe webhook signature.');
    return { statusCode: 400, body: 'Invalid signature.' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON.' };
  }

  // We only care about checkouts that are actually paid. Card payments
  // arrive as "checkout.session.completed" already paid. Some slower
  // payment types (e.g. bank debits) complete checkout first and only
  // pay later — for those, "completed" arrives unpaid and is skipped
  // here, and the order is processed when Stripe sends
  // "checkout.session.async_payment_succeeded" once the money clears.
  const HANDLED_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!HANDLED_EVENTS.includes(stripeEvent.type)) {
    return { statusCode: 200, body: 'Ignored (not a checkout payment event).' };
  }

  const session = stripeEvent.data.object;

  if (session.payment_status !== 'paid') {
    return { statusCode: 200, body: 'Checkout completed but not paid yet — waiting for payment.' };
  }

  // Fast path: has this container already finished this order completely?
  // Keyed by session (the order itself), not by event, since one order can
  // arrive under either event type above.
  if (processedEventIds.has(session.id)) {
    return { statusCode: 200, body: 'Already processed (duplicate webhook delivery, same instance) — skipped.' };
  }

  const m = session.metadata || {};
  // Cake messages can be spread over several details (cake_message,
  // cake_message_1, cake_message_2 ...) — see create-checkout-session.js.
  for (let k = 1; m[`cake_message_${k}`] !== undefined; k++) {
    m.cake_message = (m.cake_message || '') + m[`cake_message_${k}`];
  }
  const amount = ((session.amount_total || 0) / 100).toFixed(2);
  const currency = (session.currency || 'nzd').toUpperCase();
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  // Everything below that goes into the HTML emails is escaped first —
  // the customer's own free text, and (as a second safeguard) the values
  // our checkout function builds itself, so nothing can ever be read as
  // web code in an email.
  const safeCustomerEmail = escapeHtml(customerEmail);
  const safeSummary = escapeHtml(m.order_summary);
  const safeDate = escapeHtml(m.pickup_delivery_date);
  const safeTime = escapeHtml(m.time_window);
  const safeSuburb = escapeHtml(m.suburb);
  const safeFulfilment = m.fulfilment === 'delivery' ? 'Delivery' : m.fulfilment === 'pickup' ? 'Pickup' : escapeHtml(m.fulfilment);
  const safeCustomerName = escapeHtml(m.customer_name);
  const safePhone = escapeHtml(m.phone);
  const safeDeliveryAddress = escapeHtml(m.delivery_address);
  const safeCakeMessage = escapeHtml(m.cake_message);
  const customerFirstName = escapeHtml((m.customer_name || '').split(' ')[0] || 'there');

  // ── Itemised receipt (used in both emails) ──────────────────────────
  // One line per cake with its price, cake messages underneath, a
  // no-added-gluten row where chosen, then delivery, card surcharge and
  // total. Built from the lines the checkout function stored (receipt_0,
  // receipt_1, ...), and only used if they add up exactly to what Stripe
  // actually charged — otherwise (e.g. an order placed before this was
  // added) the emails fall back to the simpler layout.
  // Thousands separators for display ($1,740.00), matching the website and Stripe.
  const withCommas = str => str.replace(/^(\d+)/, d => d.replace(/\B(?=(\d{3})+$)/g, ','));
  const money = c => `$${withCommas((c / 100).toFixed(2))}`;
  const amountShown = withCommas(amount); // display only — Airtable still gets the plain number
  const cents = key => {
    const n = Number(m[key]);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  let receiptLines = null;
  try {
    let raw = '';
    for (let k = 0; m[`receipt_${k}`] !== undefined; k++) raw += m[`receipt_${k}`];
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length && parsed.every(l =>
      Array.isArray(l) && typeof l[0] === 'string' && Number.isInteger(l[1]) && l[1] > 0 &&
      Number.isInteger(l[2]) && l[2] >= 0 && Number.isInteger(l[3]) && l[3] >= 0 && Array.isArray(l[4]))) {
      receiptLines = parsed;
    }
  } catch (e) { receiptLines = null; }
  const deliveryCents = cents('price_delivery_cents');
  const surchargeCents = cents('price_surcharge_cents');
  const receiptOk = !!receiptLines && deliveryCents !== null && surchargeCents !== null
    && receiptLines.reduce((sum, [, qty, each, gf]) => sum + (each + gf) * qty, 0) + deliveryCents + surchargeCents === (session.amount_total || 0);

  const G = '#5F6350';
  const receiptHtml = (() => {
    if (!receiptOk) return '';
    const td = 'padding:5px 0;vertical-align:top;';
    const sub = `padding:0 0 5px 16px;font-size:13px;color:${G};`;
    const rows = [];
    for (const [name, qty, each, gf, msgs] of receiptLines) {
      rows.push(`<tr><td style="${td}"><strong>${qty} × ${escapeHtml(name)}</strong>${qty > 1 ? `<br><span style="font-size:12.5px;color:${G};">${money(each)} each</span>` : ''}</td><td style="${td}text-align:right;white-space:nowrap;">${money(each * qty)}</td></tr>`);
      msgs.forEach((msg, n) => {
        if (typeof msg === 'string' && msg.trim()) {
          rows.push(`<tr><td style="${sub}">${qty > 1 ? `Cake ${n + 1} message` : 'Cake message'}: "${escapeHtml(msg.trim())}"</td><td style="${sub}"></td></tr>`);
        }
      });
      if (gf) rows.push(`<tr><td style="${sub}">+ No added gluten${qty > 1 ? ` (${qty} × ${money(gf)})` : ''}</td><td style="${sub}text-align:right;white-space:nowrap;">${money(gf * qty)}</td></tr>`);
    }
    rows.push(`<tr><td colspan="2" style="border-top:1px dashed #E3E1D6;padding:0;height:6px;"></td></tr>`);
    if (deliveryCents) rows.push(`<tr><td style="padding:3px 0;color:${G};">Delivery${m.suburb ? ` (${safeSuburb})` : ''}</td><td style="padding:3px 0;text-align:right;white-space:nowrap;">${money(deliveryCents)}</td></tr>`);
    if (surchargeCents) rows.push(`<tr><td style="padding:3px 0;color:${G};">Credit Card Surcharge (1.8%)</td><td style="padding:3px 0;text-align:right;white-space:nowrap;">${money(surchargeCents)}</td></tr>`);
    rows.push(`<tr><td style="border-top:1px solid #2B3C25;padding:8px 0 0;font-size:16px;"><strong>Total paid</strong></td><td style="border-top:1px solid #2B3C25;padding:8px 0 0;text-align:right;font-size:16px;white-space:nowrap;"><strong>$${amountShown} ${currency}</strong></td></tr>`);
    return `<table style="border-collapse:collapse;width:100%;max-width:460px;margin:0 0 20px;font-size:14.5px;">${rows.join('')}</table>`;
  })();
  const sectionLabel = text => `<p style="margin:0 0 6px;font-size:12px;letter-spacing:.06em;color:${G};">${text}</p>`;

  // Fallback (no itemised lines available): the order summary, any cake
  // messages, and the total paid.
  const simpleSummaryHtml = `
      <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
        <tr><td style="padding:6px 12px 6px 0;color:${G};">Cake</td><td><strong>${safeSummary}</strong></td></tr>
        ${m.cake_message ? `<tr><td style="padding:6px 12px 6px 0;color:${G};">Cake message</td><td>${safeCakeMessage}</td></tr>` : ''}
        <tr><td style="padding:6px 12px 6px 0;color:${G};">Total paid</td><td><strong>$${amountShown} ${currency}</strong></td></tr>
      </table>`;

  const cakeWord = parseInt(m.item_count, 10) > 1 ? 'cakes' : 'cake';
  // "8am – 10am" → "between 8am and 10am". Orders started on the website
  // before the time windows went live carry the old wording instead
  // ("Anytime 7:30am – 3pm" / "Delivery time TBC"), so those keep the old
  // sentences rather than reading "between Delivery time TBC".
  const win = /^(\d{1,2}(?::\d{2})?[ap]m) \u2013 (\d{1,2}(?::\d{2})?[ap]m)$/.exec(m.time_window || '');
  const between = win ? `between <strong>${escapeHtml(win[1])}</strong> and <strong>${escapeHtml(win[2])}</strong>` : '';
  const fulfilLine = m.fulfilment === 'delivery'
    ? `We'll deliver your ${cakeWord} to <strong>${safeDeliveryAddress || 'your address'}</strong> (${safeSuburb || 'Waiheke Island'}) on <strong>${safeDate}</strong>${between ? `, ${between}` : `. We'll be in touch to confirm a delivery time`}.`
    : `Your ${cakeWord} will be ready for pickup from our Oneroa bakery on <strong>${safeDate}</strong>${between ? `. Please collect ${between}` : safeTime ? `, ${safeTime.replace(/^Anytime/, 'anytime')}` : ''}.`;

  const customerEmailHtml = `
    <div style="font-family:sans-serif;font-size:15px;color:#2B3C25;line-height:1.6;max-width:520px;">
      <div style="text-align:center;margin-bottom:20px;">
        <img src="${SITE_URL}/images/badge-email.png" width="80" height="80" alt="The Old Flour Shop Bakery" style="display:inline-block;">
      </div>
      <h2 style="margin:0 0 4px;font-family:Georgia,serif;">Thanks, ${customerFirstName}!</h2>
      <p style="margin:0 0 18px;color:#5F6350;">Your order is confirmed — here's a copy for your records.</p>

      ${receiptOk ? sectionLabel('YOUR ORDER') + receiptHtml : simpleSummaryHtml}

      <p style="margin:0 0 20px;">${fulfilLine}</p>

      <p style="margin:0 0 20px;padding:10px 12px;background:#F4F2EA;border-radius:6px;color:#5F6350;font-size:12.5px;line-height:1.5;">
        <strong>Allergen information:</strong> selected cakes can be made without gluten-containing ingredients. Please note that our bakery handles wheat, nuts, dairy, eggs and other allergens in a small shared kitchen, so we cannot guarantee that any product is completely free from allergens or cross-contact. If you have a serious allergy, please contact us before your order date.
      </p>

      <p style="margin:0 0 6px;color:#5F6350;font-size:13px;">Need to change anything about your order? Just reply to this email or contact us:</p>
      <p style="margin:0 0 24px;font-size:14px;">
        027 339 9264<br>
        theoldflourshop@gmail.com<br>
        114 Ocean View Road, Oneroa, Waiheke Island
      </p>

      <p style="margin:0;font-family:Georgia,serif;font-style:italic;color:#8A8C74;">Old Building. Blooming Good.</p>
      <p style="margin:2px 0 0;font-size:12px;color:#8A8C74;">The Old Flour Shop Bakery</p>
    </div>
  `;

  // ── Save the order record first ─────────────────────────────────────
  // Whenever something temporary goes wrong from here on, we return an
  // error so Stripe tries again automatically (it keeps retrying for up
  // to 3 days). Every step below is safe to repeat (see REPEATS AND
  // RETRIES at the top), so a retry only finishes whatever didn't happen
  // the first time — no double rows, no double emails.
  // Airtable is the record when it's set up; if it isn't, the bakery
  // email is the record instead.
  const retryLater = (why) => {
    console.error(`${why} — returning an error so Stripe retries this order.`);
    return { statusCode: 500, body: 'Temporary problem processing order; please retry.' };
  };
  const airtableConfigured = !!(AIRTABLE_API_KEY && AIRTABLE_BASE_ID);
  // Set if Airtable refuses the order because of how it's set up (e.g. a
  // column was renamed or deleted, or the access token changed). Retrying
  // can never fix that, so instead the bakery email goes out as the
  // record, with a warning to add the order to Airtable by hand.
  let airtableProblem = '';
  // True only on the run that actually creates the order (or when there's
  // no Airtable to check) — used so the staff text isn't sent twice.
  let newOrder = true;

  let existing = 'missing';
  if (airtableConfigured) {
    existing = await findOrderInAirtable(session.id, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, timeLeft(2500));
    if (existing === 'retry') {
      // Can't tell whether it's already saved. Rather than risk saving and
      // emailing it twice, wait and let Stripe try again.
      return retryLater('Could not check Airtable for this order');
    }
    if (existing === 'found') newOrder = false;
    if (existing === 'setup') airtableProblem = 'Airtable could not be searched (check the token, base, table and the "Stripe Session ID" column)';
  }

  // Only create the row if the search above found nothing. (If the search
  // itself was refused because of Airtable's setup, saving would fail the
  // same way — airtableProblem is already set, and the bakery email
  // becomes the record.)
  if (airtableConfigured && existing === 'missing') {
    try {
      const airtableRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(timeLeft(2500)),
          body: JSON.stringify({
            // Lets Airtable match text to a dropdown ("single select")
            // column, e.g. Time Window, adding the option if it's missing
            // rather than refusing the whole order.
            typecast: true,
            records: [{
              fields: {
                // This is Airtable's primary field (the default first
                // column, usually just called "Name") — it's what
                // Calendar view actually displays on each card, and
                // what Grid view shows as the row label. It was never
                // being written before, which is why calendar cards
                // were showing up blank.
                'Name': `${m.order_summary || 'Order'} — ${m.customer_name || 'Unknown'}`,
                'Cake': m.order_summary || '',
                'Fulfilment': m.fulfilment || '',
                'Pickup/Delivery Date': m.pickup_delivery_date_iso || '',
                'Time Window': m.time_window || '',
                'Suburb': m.suburb || '',
                'Delivery Address': m.delivery_address || '',
                'Customer Name': m.customer_name || '',
                'Phone': m.phone || '',
                'Email': customerEmail || '',
                'Cake Message': m.cake_message || '',
                'Amount Paid': Number(amount),
                'Stripe Session ID': session.id || ''
              }
            }]
          })
        }
      );
      if (!airtableRes.ok) {
        const detail = await airtableRes.text().catch(() => '');
        console.error('Airtable error:', airtableRes.status, detail);
        // 401/403/404/422 = Airtable's setup (token, base, table name or
        // columns) doesn't match — permanent until someone fixes it.
        // Anything else (429 busy, 5xx down) is temporary: retry.
        if ([401, 403, 404, 422].includes(airtableRes.status)) {
          let reason = '';
          try { reason = JSON.parse(detail)?.error?.message || JSON.parse(detail)?.error?.type || ''; } catch (e) {}
          airtableProblem = reason || `Airtable error ${airtableRes.status}`;
        } else {
          return retryLater('Could not save order to Airtable');
        }
      } else {
        // Saved. Make sure a second copy of this same payment, arriving at
        // the same moment, hasn't also saved a row (see keepOnlyFirstRow).
        const created = await airtableRes.json().catch(() => ({}));
        const myRecordId = created?.records?.[0]?.id;
        if (myRecordId) {
          const kept = await keepOnlyFirstRow(session.id, myRecordId, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, timeLeft(1500));
          if (!kept) newOrder = false; // the other copy is handling this order; no second staff text
        }
      }
    } catch (err) {
      console.error('Failed to log order to Airtable:', err);
      return retryLater('Could not save order to Airtable');
    }
  }


  const bakeryEmailHtml = `
    <div style="font-family:sans-serif;font-size:15px;color:#2B3C25;line-height:1.6;">
      ${airtableProblem ? `<div style="margin:0 0 16px;padding:12px 14px;background:#FCE8E3;border:1px solid #E7A89A;border-radius:6px;color:#7A2E1E;">
        <strong>⚠️ This order was NOT saved to Airtable.</strong><br>
        Please add it to Airtable by hand, and check Airtable's column names haven't been changed or deleted.<br>
        <span style="font-size:12px;">Airtable said: ${escapeHtml(airtableProblem)}</span>
      </div>` : ''}
      ${receiptOk
        ? `<h2 style="margin:0 0 14px;">New cake order — $${amountShown}</h2>${sectionLabel('ORDER')}${receiptHtml}${sectionLabel('DETAILS')}`
        : `<h2 style="margin:0 0 12px;">New cake order — ${safeSummary || 'Unknown cake'}</h2>
      <p style="margin:0 0 16px;"><strong>Total paid:</strong> $${amountShown} ${currency}</p>`}
      <table style="border-collapse:collapse;width:100%;max-width:480px;">
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Customer</td><td>${safeCustomerName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Phone</td><td>${safePhone}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Email</td><td>${safeCustomerEmail}</td></tr>
        ${receiptOk ? '' : `<tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Cake</td><td>${safeSummary}</td></tr>`}
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Fulfilment</td><td>${safeFulfilment}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Date</td><td>${safeDate}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Time window</td><td>${safeTime}</td></tr>
        ${m.fulfilment === 'delivery' ? `
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Suburb</td><td>${safeSuburb}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Delivery address</td><td>${safeDeliveryAddress}</td></tr>
        ` : ''}
        ${!receiptOk && m.cake_message ? `<tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Cake message</td><td>${safeCakeMessage}</td></tr>` : ''}
      </table>
      <p style="margin-top:20px;font-size:13px;color:#5F6350;">Full payment details are also in your Stripe Dashboard under Payments.</p>
    </div>
  `;

  // ── Emails (and staff text) — all at once, to keep this quick ─────────
  // Each email has its own fixed key made from the order, so a repeat of
  // this order (a Stripe retry) never sends the same email twice. The
  // staff text only goes out on the run that first saved the order.
  const emailKey = kind => `order-${session.id}-${kind}`;
  const bakeryEmail = sendEmail(RESEND_API_KEY, emailKey('bakery'), {
    from: 'The Old Flour Shop Orders <orders@theoldflourshop.co.nz>',
    to: [BAKERY_EMAIL],
    // Hitting Reply on this order email writes straight to the
    // customer (e.g. to ask about their cake). Falls back to the
    // bakery's own inbox only if the order somehow has no email.
    reply_to: customerEmail || BAKERY_EMAIL,
    subject: `${airtableProblem ? '⚠️ NOT IN AIRTABLE — ' : ''}New order: ${m.order_summary || 'Cake'} — $${amountShown}`,
    html: bakeryEmailHtml
  }, 'bakery email', timeLeft());

  const customerEmailSend = customerEmail
    ? sendEmail(RESEND_API_KEY, emailKey('customer'), {
        from: 'The Old Flour Shop Bakery <orders@theoldflourshop.co.nz>',
        to: [customerEmail],
        // orders@theoldflourshop.co.nz can send but can't receive. The
        // email invites "just reply to this email", so replies go to
        // theoldflourshop@gmail.com, the inbox that's actually checked.
        reply_to: 'theoldflourshop@gmail.com',
        subject: `Your order is confirmed — ${m.order_summary || 'Cake'}`,
        html: customerEmailHtml
      }, 'customer email', timeLeft())
    : (console.error('No customer email found on session — skipped customer confirmation.'), Promise.resolve('failed'));

  // Staff text alert — best-effort; a failure is logged but never
  // affects the order, and it's never re-sent on a retry.
  const staffText = (TNZ_AUTH_TOKEN && newOrder)
    ? sendStaffSms({
        token: TNZ_AUTH_TOKEN,
        to: STAFF_SMS_NUMBER,
        reference: `Cake order ${String(session.id || '').slice(-8)}`,   // same reference as the confirmation page
        testMode: /^(true|yes|1)$/i.test(process.env.TNZ_TEST_MODE || ''),
        timeLeft: () => timeLeft(),
        body: `${airtableProblem ? 'NOT IN AIRTABLE - add by hand. ' : ''}New order: ${m.order_summary || 'Cake'}. ${m.fulfilment === 'delivery' ? `Delivery (${m.suburb || '?'})` : 'Pickup'} ${m.pickup_delivery_date || ''}${m.time_window ? ' ' + m.time_window.replace(/\u2013/g, '-').replace(/\s+-\s+/g, '-') : ''}. ${m.customer_name || ''} ${m.phone || ''}. $${amountShown} paid`
      })
    : Promise.resolve();

  const [bakeryResult, customerResult] = await Promise.all([bakeryEmail, customerEmailSend, staffText]);

  // Anything temporary that didn't go out: ask Stripe to try again. The
  // retry finds the order already saved, skips the Airtable step, and
  // only the email(s) that didn't go out are actually sent.
  if (bakeryResult === 'retry' || customerResult === 'retry') {
    return retryLater(`Email not sent yet (bakery: ${bakeryResult}, customer: ${customerResult})`);
  }
  // If Resend refused the bakery email for good and it's the only record
  // (no working Airtable), retrying can't fix it — flag it loudly in the
  // logs so it's visible in Netlify, but the payment itself is in Stripe.
  if (bakeryResult === 'failed' && (!airtableConfigured || airtableProblem)) {
    console.error('IMPORTANT: order not recorded anywhere except Stripe — check the Stripe Dashboard for session', session.id);
  }

  // Finished — this warm container can skip any repeat of this order.
  processedEventIds.add(session.id);
  return { statusCode: 200, body: 'OK' };
};

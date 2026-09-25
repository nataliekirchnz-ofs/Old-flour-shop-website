// netlify/functions/stripe-webhook.js
//
// This function is called directly by Stripe (not by your website) the
// moment a payment actually succeeds. This is more reliable than only
// emailing on the browser's return trip from Stripe, because it fires
// even if the customer closes their browser tab right after paying.
//
// It verifies the request really came from Stripe (using a signing
// secret), then:
//   1. sends an order notification email to the bakery
//   2. sends a branded order confirmation email to the customer
//   3. logs the order as a row in Airtable, so staff can see upcoming
//      orders in one place without digging through Stripe or email
//   4. (via ClickSend) texts a new-order alert to the staff phone.
//      Customers are NOT texted — they get the confirmation email only.
//
// Setup required (see README.md for the full walkthrough):
//   1. Create a free account at https://resend.com, get an API key,
//      add it in Netlify as RESEND_API_KEY
//   2. In Stripe Dashboard -> Developers -> Webhooks -> Add endpoint:
//        URL:    https://YOUR-SITE.netlify.app/.netlify/functions/stripe-webhook
//        Event:  checkout.session.completed
//      Stripe will show you a "Signing secret" (starts with whsec_...) —
//      add that in Netlify as STRIPE_WEBHOOK_SECRET
//   3. Add BAKERY_NOTIFICATION_EMAIL in Netlify — the address that
//      should receive new-order emails (defaults to
//      theoldflourshop@gmail.com if not set)
//   4. Create an Airtable base with a table matching the field names
//      below, get an API token, add AIRTABLE_API_KEY, AIRTABLE_BASE_ID
//      and AIRTABLE_TABLE_NAME in Netlify — see README.md for the
//      exact steps and field names to create
//   5. (optional) For text messages, add CLICKSEND_USERNAME and
//      CLICKSEND_API_KEY in Netlify. Alerts go to the staff phone
//      (+64273399264), or BAKERY_SMS_NUMBER if set. The text is skipped
//      if the ClickSend keys aren't set — emails and Airtable still work.

const crypto = require('crypto');

// The values below (customer name, phone, cake message, allergy notes,
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

// IDEMPOTENCY — Stripe explicitly documents that webhooks can be delivered
// more than once for the same event (retries, network blips on their end),
// so this function must tolerate being called twice for one payment
// without emailing the customer/bakery twice or double-logging the order.
//
// This Set lives at module scope, so it persists for the lifetime of a
// warm Netlify function container — a fast, free first line of defence
// that catches the most common case (a near-immediate Stripe retry
// landing on the same warm instance). It is NOT durable across cold
// starts or multiple concurrent instances, which is what the Airtable
// check further below (isDuplicateInAirtable) is for.
const processedEventIds = new Set();

async function isDuplicateInAirtable(sessionId, apiKey, baseId, tableName) {
  if (!apiKey || !baseId) return false; // can't check — don't block processing over it
  try {
    const formula = encodeURIComponent(`{Stripe Session ID}='${sessionId}'`);
    const res = await fetch(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?filterByFormula=${formula}&maxRecords=1`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    if (!res.ok) return false; // if the check itself fails, don't block a real order over it
    const data = await res.json();
    return Array.isArray(data.records) && data.records.length > 0;
  } catch (e) {
    return false;
  }
}

// ── SMS (ClickSend) ─────────────────────────────────────────────────────
// Turns a NZ mobile in any common format ("027 339 9264", "+64 27...",
// "6427...") into international format (+6427...). Returns '' for
// anything that isn't a NZ mobile, so a mistyped number is skipped
// rather than failing.
function toNzMobile(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('64')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  // NZ mobiles start with 2 (021, 022, 027, 028, 029...) and are 8–10
  // digits after dropping the leading 0.
  if (!/^2\d{7,9}$/.test(digits)) return '';
  return '+64' + digits;
}

// Sends one text. Never throws — a failed text must not stop the rest of
// the order processing, same as the emails.
async function sendSms({ to, body, username, apiKey, from }) {
  if (!to || !body) return;
  body = toPlainSms(body);
  try {
    const message = { source: 'theoldflourshop-website', to, body };
    if (from) message.from = from; // blank = ClickSend's shared number
    const res = await fetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${username}:${apiKey}`).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messages: [message] })
    });
    const data = await res.json().catch(() => ({}));
    const status = data?.data?.messages?.[0]?.status;
    if (!res.ok || (status && status !== 'SUCCESS')) {
      console.error('ClickSend error:', res.status, status || data?.response_code, data?.response_msg || '');
    }
  } catch (err) {
    console.error('Failed to send SMS:', err);
  }
}

// Characters like en dashes (–), curly quotes and emoji aren't in the
// standard SMS alphabet. A single one switches the whole text to a
// different encoding that only fits 70 characters per SMS instead of 160,
// tripling the cost — so they're swapped for plain equivalents first.
function toPlainSms(str) {
  return String(str)
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '');
}


function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('='))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // constant-time comparison
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
  const CLICKSEND_USERNAME = process.env.CLICKSEND_USERNAME;
  const CLICKSEND_API_KEY = process.env.CLICKSEND_API_KEY;
  const CLICKSEND_FROM = process.env.CLICKSEND_FROM || ''; // optional dedicated number, e.g. +6421...
  const BAKERY_SMS_NUMBER = process.env.BAKERY_SMS_NUMBER || '+64273399264'; // staff phone

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

  // We only care about successful payments.
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored (not a completed checkout).' };
  }

  // Fast path: has this exact Stripe event already been handled by this
  // warm container? (See processedEventIds comment above for what this
  // does and doesn't cover.)
  if (processedEventIds.has(stripeEvent.id)) {
    return { statusCode: 200, body: 'Already processed (duplicate webhook delivery, same instance) — skipped.' };
  }
  processedEventIds.add(stripeEvent.id);

  const session = stripeEvent.data.object;

  // Durable path: has this session already been logged to Airtable by a
  // previous (possibly different) function instance? Only runs when
  // Airtable is configured — see README for setup.
  if (await isDuplicateInAirtable(session.id, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME)) {
    return { statusCode: 200, body: 'Already processed (duplicate webhook delivery, found in Airtable) — skipped.' };
  }

  const m = session.metadata || {};
  const amount = ((session.amount_total || 0) / 100).toFixed(2);
  const currency = (session.currency || 'nzd').toUpperCase();
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  // Free text the customer actually typed — escaped once here, then used
  // safely everywhere below. order_summary/fulfilment/date/time/suburb
  // are all built server-side from our own trusted data, not customer
  // free text, so they don't need this.
  const safeCustomerName = escapeHtml(m.customer_name);
  const safePhone = escapeHtml(m.phone);
  const safeDeliveryAddress = escapeHtml(m.delivery_address);
  const safeCakeMessage = escapeHtml(m.cake_message);
  const safeAllergyNotes = escapeHtml(m.allergy_notes);
  const customerFirstName = escapeHtml((m.customer_name || '').split(' ')[0] || 'there');

  const bakeryEmailHtml = `
    <div style="font-family:sans-serif;font-size:15px;color:#2B3C25;line-height:1.6;">
      <h2 style="margin:0 0 12px;">New cake order — ${m.order_summary || 'Unknown cake'}</h2>
      <p style="margin:0 0 16px;"><strong>Total paid:</strong> $${amount} ${currency}</p>
      <table style="border-collapse:collapse;width:100%;max-width:480px;">
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Customer</td><td>${safeCustomerName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Phone</td><td>${safePhone}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Email</td><td>${customerEmail}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Cake</td><td>${m.order_summary || ''}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Fulfilment</td><td>${m.fulfilment || ''}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Date</td><td>${m.pickup_delivery_date || ''}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Time window</td><td>${m.time_window || ''}</td></tr>
        ${m.fulfilment === 'delivery' ? `
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Suburb</td><td>${m.suburb || ''}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Delivery address</td><td>${safeDeliveryAddress}</td></tr>
        ` : ''}
        ${m.cake_message ? `<tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Cake message</td><td>"${safeCakeMessage}"</td></tr>` : ''}
        ${m.allergy_notes ? `<tr><td style="padding:4px 12px 4px 0;color:#5F6350;">Allergy notes</td><td>${safeAllergyNotes}</td></tr>` : ''}
      </table>
      <p style="margin-top:20px;font-size:13px;color:#5F6350;">Full payment details are also in your Stripe Dashboard under Payments.</p>
    </div>
  `;

  const fulfilLine = m.fulfilment === 'delivery'
    ? `We'll deliver your cake to <strong>${safeDeliveryAddress || 'your address'}</strong> (${m.suburb || 'Waiheke Island'}) on <strong>${m.pickup_delivery_date || ''}</strong>. ${m.time_window ? `Delivery time: ${m.time_window}.` : ''}`
    : `Your cake will be ready for pickup from our Oneroa bakery on <strong>${m.pickup_delivery_date || ''}</strong>. ${m.time_window ? m.time_window + '.' : ''}`;

  const customerEmailHtml = `
    <div style="font-family:sans-serif;font-size:15px;color:#2B3C25;line-height:1.6;max-width:520px;">
      <div style="text-align:center;margin-bottom:20px;">
        <img src="${SITE_URL}/images/badge-email.png" width="80" height="80" alt="The Old Flour Shop Bakery" style="display:inline-block;">
      </div>
      <h2 style="margin:0 0 4px;font-family:Georgia,serif;">Thanks, ${customerFirstName}!</h2>
      <p style="margin:0 0 20px;color:#5F6350;">Your order is confirmed — here's a copy for your records.</p>

      <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
        <tr><td style="padding:6px 12px 6px 0;color:#5F6350;">Cake</td><td><strong>${m.order_summary || ''}</strong></td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#5F6350;">Total paid</td><td>$${amount} ${currency}</td></tr>
        ${m.cake_message ? `<tr><td style="padding:6px 12px 6px 0;color:#5F6350;">Cake message</td><td>"${safeCakeMessage}"</td></tr>` : ''}
        ${m.allergy_notes ? `<tr><td style="padding:6px 12px 6px 0;color:#5F6350;">Notes we have</td><td>${safeAllergyNotes}</td></tr>` : ''}
      </table>

      <p style="margin:0 0 20px;">${fulfilLine}</p>

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

  try {
    const bakeryRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'The Old Flour Shop Orders <orders@theoldflourshop.co.nz>',
        to: [BAKERY_EMAIL],
        // orders@theoldflourshop.co.nz is a verified sending address, not
        // a real inbox — nothing arrives there if someone replies. This
        // makes sure a reply lands somewhere actually checked, matching
        // BAKERY_EMAIL (defaulting to theoldflourshop@gmail.com) so any
        // reply-all or forward from the bakery's own inbox behaves sanely.
        reply_to: BAKERY_EMAIL,
        subject: `New order: ${m.order_summary || 'Cake'} — $${amount}`,
        html: bakeryEmailHtml
      })
    });
    if (!bakeryRes.ok) {
      console.error('Resend error (bakery email):', await bakeryRes.text());
    }
  } catch (err) {
    console.error('Failed to send bakery notification email:', err);
  }

  if (customerEmail) {
    try {
      const customerRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'The Old Flour Shop Bakery <orders@theoldflourshop.co.nz>',
          to: [customerEmail],
          // Same reasoning as above — orders@theoldflourshop.co.nz can
          // send but can't receive. The email itself explicitly invites
          // "just reply to this email", so this is what actually makes
          // that true: a reply now lands in theoldflourshop@gmail.com,
          // the inbox that's genuinely checked, instead of vanishing.
          reply_to: 'theoldflourshop@gmail.com',
          subject: `Your order is confirmed — ${m.order_summary || 'Cake'}`,
          html: customerEmailHtml
        })
      });
      if (!customerRes.ok) {
        console.error('Resend error (customer email):', await customerRes.text());
      }
    } catch (err) {
      console.error('Failed to send customer confirmation email:', err);
    }
  } else {
    console.error('No customer email found on session — skipped customer confirmation.');
  }

  if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
    try {
      const airtableRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
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
                'Allergy Notes': m.allergy_notes || '',
                'Amount Paid': Number(amount),
                'Stripe Session ID': session.id || ''
              }
            }]
          })
        }
      );
      if (!airtableRes.ok) {
        console.error('Airtable error:', await airtableRes.text());
      }
    } catch (err) {
      console.error('Failed to log order to Airtable:', err);
    }
  }

  // ── Staff text alert (only if ClickSend is set up) ───────────────────
  // Goes to the staff phone only, never to the customer. Plain text, not
  // HTML, so the raw (unescaped) values are used here. No links, as
  // ClickSend holds back texts containing URLs on new accounts.
  if (CLICKSEND_USERNAME && CLICKSEND_API_KEY) {
    const staffMobile = toNzMobile(BAKERY_SMS_NUMBER);
    if (staffMobile) {
      const when = [m.pickup_delivery_date, m.time_window].filter(Boolean).join(', ');
      const fulfil = m.fulfilment === 'delivery' ? `Delivery (${m.suburb || '?'})` : 'Pickup';
      await sendSms({
        username: CLICKSEND_USERNAME,
        apiKey: CLICKSEND_API_KEY,
        from: CLICKSEND_FROM,
        to: staffMobile,
        body: `New order: ${m.order_summary || 'Cake'}. ${fulfil} ${when}. ${m.customer_name || ''} ${m.phone || ''}. $${amount} paid`
      });
    } else {
      console.error('BAKERY_SMS_NUMBER is not a valid NZ mobile — skipped staff SMS.');
    }
  }

  // All of the above (bakery email, customer email, Airtable log, staff text) are logged
  // above but never block Stripe's webhook response — Stripe only
  // needs to know we received the event.
  return { statusCode: 200, body: 'OK' };
};

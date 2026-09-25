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

  // All three (bakery email, customer email, Airtable log) are logged
  // above but never block Stripe's webhook response — Stripe only
  // needs to know we received the event.
  return { statusCode: 200, body: 'OK' };
};

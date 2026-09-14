// netlify/functions/create-checkout-session.js
//
// SECURITY MODEL:
// The browser is never trusted for money-related values. It only ever
// sends a list of {cakeId, quantity, glutenFree} entries and a suburb;
// this function looks up the real price of each cake and the real
// delivery fee itself from the allowlists below, and builds the Stripe
// Checkout line items from those looked-up values only. Nothing the
// browser sends is used to set an amount.
//
// Every one of these is independently validated here, not just hinted
// at in the UI — see the numbered checks in the handler below:
//   1. cake IDs must exist in the CAKES allowlist
//   2. quantities must be integers between 1 and MAX_ITEM_QTY
//   3. a "no added gluten" request is only honoured for cakes that
//      actually offer it (glutenFreeOption: true) — silently ignored,
//      not an error, for any other cake
//   4. delivery suburbs must exist in the DELIVERY_ZONES allowlist
//   5. the date must be a real calendar date, at least 48 hours out
//      (in genuine NZ time, not the server's own clock), not more than
//      MAX_BOOKING_MONTHS_AHEAD out, and not a blackout date
//   6. email must pass a real format check, phone a reasonable digit-
//      count check
// A request failing any of these never reaches Stripe.
//
// ── IMPORTANT — KEEPING THIS IN SYNC ────────────────────────────────────
// CAKES, DELIVERY_ZONES and BLACKOUT_DATES below are a deliberate copy of
// the same data in index.html's <script>. This site has no build step
// and no database, so there is no single source of truth to share
// automatically — if you add a cake, remove a cake, change a price/
// delivery fee, or add a closed date on the website, you must make the
// same change here, or checkout will use the old value. Keep the `id`
// values identical between the two files; that's what links them.
// ─────────────────────────────────────────────────────────────────────

const CAKES = {
  'chocolate-cake':          { name: 'Chocolate Celebration Cake', price: 120, glutenFreeOption: false },
  'raspberry-cheesecake':    { name: 'Raspberry Cheesecake',       price: 125, glutenFreeOption: true },
  'chocolate-marquise':      { name: 'Chocolate Marquise',         price: 130, glutenFreeOption: false },
  'tiramisu-cake':           { name: 'Tiramisu Cake',              price: 115, glutenFreeOption: false },
  'lemon-velvet':            { name: 'Lemon Mousse Cake',          price: 120, glutenFreeOption: true },
  'orange-almond':           { name: 'Orange & Almond Cake',       price: 120, glutenFreeOption: false }, // naturally no added gluten already, not an "option"
  'passionfruit-cheesecake': { name: 'Passionfruit Cheesecake',    price: 125, glutenFreeOption: true },
  'lemon-lover-cake':        { name: 'Lemon Lover Cake',           price: 115, glutenFreeOption: false },
  'raspberry-crumble':       { name: 'Raspberry Crumble Cake',     price: 100, glutenFreeOption: false },
};

const DELIVERY_ZONES = [
  { fee: 15, suburbs: ['Oneroa', 'Blackpool', 'Little Oneroa'] },
  { fee: 20, suburbs: ['Surfdale', 'Palm Beach', 'Ostend'] },
  { fee: 25, suburbs: ['Mudbrick Vineyard', 'Cable Bay Vineyard', 'Wild on Waiheke', 'Stoneyridge Vineyard', 'Te Motu Estate', 'Tantalus Estate', 'Onetangi'] },
];

// Dates the bakery is closed / not taking orders. Format: 'YYYY-MM-DD'.
// This is the authoritative copy — index.html has a matching one for
// immediate UI feedback, but this is what actually blocks a booking.
//
// NOTE — DAILY PRODUCTION CAPACITY IS NOT HANDLED HERE (BY DESIGN):
// This list only blocks specific closed dates, not "how many cakes can
// realistically be made for a given open day." If that ever becomes a
// real constraint, it must be enforced authoritatively here (or in
// whatever order-management system this evolves into) — e.g. by
// querying a live count of existing orders for a date (Airtable or
// similar) before allowing a new one. It must never be trusted to the
// browser/frontend alone, for the same reason prices and every other
// value in this file aren't: the frontend is a convenience layer, not
// a security or business-rule boundary — anything enforced only there
// can be bypassed by a direct request to this endpoint.
const BLACKOUT_DATES = ['2026-12-25', '2027-01-01'];

const CUTOFF_HOURS = 48;
const MAX_BOOKING_MONTHS_AHEAD = 6; // must match MAX_BOOKING_MONTHS_AHEAD in index.html
const MAX_ITEM_QTY = 20;      // sanity cap per cake line
const MAX_CART_ITEMS = 20;    // sanity cap on number of distinct cart lines in one order

// RATE LIMITING — best-effort only. This Map lives at module scope, so it
// persists for the lifetime of a warm Netlify function container, and is
// reset on cold start. It also isn't shared across multiple concurrent
// instances if traffic is spread across them. This is NOT a substitute
// for a real distributed rate limiter (e.g. Upstash Redis) if this site
// ever needs to withstand deliberate abuse at scale — but it costs
// nothing extra and stops the common case: an accidental retry loop or a
// casual script hammering this endpoint from one place.
const requestLog = new Map(); // ip -> array of request timestamps (ms)
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 10;                  // max checkout attempts per IP per window

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

function clientIpFrom(event) {
  // x-forwarded-for can be a comma-separated chain (client, proxy, proxy...)
  // when requests pass through intermediaries — only the first entry is
  // the actual client, so that's what we key the rate limiter on.
  const xff = event.headers['x-forwarded-for'];
  const firstForwarded = xff ? xff.split(',')[0].trim() : '';
  return event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || firstForwarded || 'unknown';
}

function findDeliveryFee(suburb) {
  const zone = DELIVERY_ZONES.find(z => z.suburbs.includes(suburb));
  return zone ? zone.fee : null; // null = not a suburb we recognise
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isReasonablePhone(value) {
  const digits = typeof value === 'string' ? value.replace(/[^0-9]/g, '') : '';
  return digits.length >= 7 && digits.length <= 15;
}

// All date/cutoff logic below is deliberately anchored to New Zealand
// time (Pacific/Auckland), not this server's own clock — Netlify
// functions typically run in UTC, which is NOT the same as NZ time, so
// using the server's "local" Date methods directly would silently
// enforce the wrong cutoff. We get NZ wall-clock time via
// Intl.DateTimeFormat, then represent it using Date's UTC fields purely
// as a convenient calendar-math frame — no real UTC conversion is implied.
function nzNowAsUTC() {
  const fmt = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour); // midnight can format as "24" with hour12:false
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second)));
}

function minBookableDateNZ() {
  // The earliest bookable calendar day must have its full 24 hours (from
  // NZ midnight onward — the earliest a pickup could realistically be
  // collected) sit at or beyond now + CUTOFF_HOURS. If we instead floored
  // to the start of whatever day "now + 48h" happens to fall on, an early
  // pickup that same day could end up with less than the full 48 hours'
  // notice — so when the cutoff doesn't land exactly on midnight, the
  // minimum bookable day rolls forward to the next one. This must never
  // be loosened back to a floor, or the stated 48-hour promise can be
  // silently broken for early same-day pickups.
  const now = nzNowAsUTC();
  const cutoff = new Date(now.getTime() + CUTOFF_HOURS * 3600 * 1000);
  const atMidnight = cutoff.getUTCHours() === 0 && cutoff.getUTCMinutes() === 0 && cutoff.getUTCSeconds() === 0;
  let minDate = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate(), 0, 0, 0));
  if (!atMidnight) { minDate = new Date(minDate.getTime() + 24 * 3600 * 1000); }
  return minDate;
}

function maxBookableDateNZ() {
  const now = nzNowAsUTC();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + MAX_BOOKING_MONTHS_AHEAD, now.getUTCDate(), 0, 0, 0));
}

function isValidBookingDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const parts = dateStr.split('-').map(Number);
  const [y, mo, d] = parts;
  if (parts.length !== 3 || !Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  // Built directly from the numeric parts (not string-parsed) so there is
  // no timezone interpretation of dateStr at all — it's treated purely as
  // a calendar date, compared against the NZ-anchored bounds in the same frame.
  const chosen = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  if (isNaN(chosen.getTime())) return false;
  if (chosen < minBookableDateNZ()) return false;
  if (chosen > maxBookableDateNZ()) return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const clientIp = clientIpFrom(event);
  if (isRateLimited(clientIp)) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes and try again.' }) };
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  // SITE_URL is set by you in Netlify env vars (e.g. https://theoldflourshop.netlify.app).
  // We build success/cancel URLs from this ourselves rather than trusting
  // whatever origin the browser claims to be — otherwise a request could
  // ask Stripe to redirect a completed payment to an attacker's domain.
  const SITE_URL = process.env.SITE_URL;

  if (!STRIPE_SECRET_KEY || !SITE_URL) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is not fully configured yet. STRIPE_SECRET_KEY and SITE_URL must both be set in Netlify environment variables.' })
    };
  }

  let order;
  try {
    order = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request.' }) };
  }

  // ---- 1 & 2 & 3. look up every cart line by ID; validate quantity; only honour "no added gluten" where actually offered ----
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Your cart is empty. Please add a cake before checking out.' }) };
  }
  if (order.items.length > MAX_CART_ITEMS) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Too many different cakes in one order. Please contact us directly for large orders.' }) };
  }

  const resolvedItems = [];
  for (const rawItem of order.items) {
    const cake = CAKES[rawItem && rawItem.cakeId];
    if (!cake) {
      return { statusCode: 400, body: JSON.stringify({ error: 'One of the cakes in your cart is not recognised. Please refresh and try again.' }) };
    }
    const qty = Math.floor(Number(rawItem.quantity));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_ITEM_QTY) {
      return { statusCode: 400, body: JSON.stringify({ error: `Please choose a quantity between 1 and ${MAX_ITEM_QTY} for each cake.` }) };
    }
    const glutenFree = !!(rawItem.glutenFree && cake.glutenFreeOption);
    resolvedItems.push({ id: rawItem.cakeId, name: cake.name, price: cake.price, qty, glutenFree });
  }

  // ---- 4. validate fulfilment + look up delivery fee server-side ----
  if (order.fulfil !== 'pickup' && order.fulfil !== 'delivery') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please choose pickup or delivery.' }) };
  }

  let deliveryFeeCents = 0;
  let suburb = '';
  if (order.fulfil === 'delivery') {
    suburb = typeof order.suburb === 'string' ? order.suburb.trim() : '';
    const fee = findDeliveryFee(suburb);
    if (fee === null) {
      return { statusCode: 400, body: JSON.stringify({ error: 'That suburb is outside our delivery area. Please choose one from the list.' }) };
    }
    deliveryFeeCents = fee * 100;

    if (!order.address || typeof order.address !== 'string' || order.address.trim().length < 4) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a delivery address.' }) };
    }
  }

  // ---- 5. validate date: real calendar date, at least 48 hours out, not more than 6 months out, not a blackout date ----
  if (!isValidBookingDate(order.date)) {
    return { statusCode: 400, body: JSON.stringify({ error: `Please choose a valid date between 48 hours and ${MAX_BOOKING_MONTHS_AHEAD} months from now.` }) };
  }
  if (BLACKOUT_DATES.includes(order.date)) {
    return { statusCode: 400, body: JSON.stringify({ error: "We're closed on that date. Please choose another." }) };
  }

  // ---- 6. validate customer details ----
  if (!order.fname || !order.fname.trim() || !order.lname || !order.lname.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter your first and last name.' }) };
  }
  if (!isValidEmail(order.email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }
  if (!isReasonablePhone(order.phone)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid phone number.' }) };
  }

  // ---- build the Stripe Checkout Session request ----
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  // Server-built redirect URLs, not client-supplied ones (see SITE_URL note above).
  params.append('success_url', `${SITE_URL}/?order=success&session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${SITE_URL}/?order=cancelled`);
  params.append('customer_email', order.email);

  let lineIndex = 0;
  for (const item of resolvedItems) {
    const unitAmount = Math.round(item.price * 100);
    const displayName = item.glutenFree ? `${item.name} (no added gluten)` : item.name;
    params.append(`line_items[${lineIndex}][price_data][currency]`, 'nzd');
    params.append(`line_items[${lineIndex}][price_data][product_data][name]`, displayName);
    params.append(`line_items[${lineIndex}][price_data][unit_amount]`, String(unitAmount));
    params.append(`line_items[${lineIndex}][quantity]`, String(item.qty));
    lineIndex++;
  }

  if (deliveryFeeCents > 0) {
    params.append(`line_items[${lineIndex}][price_data][currency]`, 'nzd');
    params.append(`line_items[${lineIndex}][price_data][product_data][name]`, `Delivery — ${suburb}`);
    params.append(`line_items[${lineIndex}][price_data][unit_amount]`, String(deliveryFeeCents));
    params.append(`line_items[${lineIndex}][quantity]`, '1');
    lineIndex++;
  }

  // A short human-readable summary for display in emails, Airtable and the
  // confirmation screen — e.g. "2x Lemon Mousse Cake (no added gluten), 1x Tiramisu Cake".
  const orderSummary = resolvedItems
    .map(i => `${i.qty}x ${i.name}${i.glutenFree ? ' (no added gluten)' : ''}`)
    .join(', ');

  // Order details attached as metadata so they show up in the Stripe Dashboard
  // and in the webhook payload. These are for display only — never used to
  // determine price.
  const metadata = {
    order_summary: orderSummary,
    item_count: String(resolvedItems.reduce((n, i) => n + i.qty, 0)),
    fulfilment: order.fulfil,
    suburb: suburb,
    delivery_address: order.fulfil === 'delivery' ? (order.address || '').trim() : '',
    pickup_delivery_date: order.dateDisplay || order.date,
    time_window: order.time || '',
    customer_name: `${order.fname} ${order.lname}`,
    phone: order.phone || '',
    cake_message: (order.message || '').trim(),
    allergy_notes: (order.notes || '').trim()
  };
  Object.entries(metadata).forEach(([key, value]) => {
    params.append(`metadata[${key}]`, String(value).slice(0, 490)); // Stripe metadata values cap at 500 chars
  });

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('Stripe error:', session);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: session.error?.message || 'Stripe could not start this payment.' })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url })
    };
  } catch (err) {
    console.error('Checkout session error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not reach Stripe. Please try again.' }) };
  }
};

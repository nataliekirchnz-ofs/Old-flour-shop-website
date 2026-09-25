// netlify/functions/verify-checkout-session.js
//
// The website's success page must never just trust the presence of
// `?order=success` in the URL — anyone can type that into their address
// bar without paying anything. Instead, the browser sends the
// `session_id` Stripe put in the redirect URL to this function, which
// asks Stripe directly "did this session actually get paid?" and only
// then do we know it's real. This function only returns a small, safe
// subset of the order for display — never the full Stripe object.

// Best-effort rate limiter — see the matching comment in
// create-checkout-session.js for what this does and doesn't cover.
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 20; // a bit higher than checkout — legitimate page reloads/retries hit this too

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

// Every response carries "no-store" so browsers and in-between caches
// never keep a copy of someone's order confirmation.
const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const respond = (statusCode, obj) => ({ statusCode, headers: NO_STORE, body: JSON.stringify(obj) });

// Stripe Checkout session IDs look like "cs_live_..." or "cs_test_..."
// followed by letters and numbers. Anything else is rejected before we
// even ask Stripe. 255 characters is a generous upper limit.
const SESSION_ID_PATTERN = /^cs_(live|test)_[A-Za-z0-9]+$/;
const SESSION_ID_MAX_LENGTH = 255;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  const clientIp = clientIpFrom(event);
  if (isRateLimited(clientIp)) {
    return respond(429, { error: 'Too many requests. Please wait a moment and try again.' });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return respond(500, { error: 'Server is not configured yet.' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return respond(400, { error: 'Invalid request.' });
  }

  const sessionId = body.sessionId;
  // Stripe Checkout session IDs always start with "cs_" — a cheap sanity
  // check before we even bother calling Stripe with it.
  if (typeof sessionId !== 'string' || sessionId.length > SESSION_ID_MAX_LENGTH || !SESSION_ID_PATTERN.test(sessionId)) {
    return respond(400, { error: 'Missing or invalid session id.' });
  }

  try {
    const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
    });
    const session = await stripeRes.json().catch(() => ({}));

    // A genuine "no such order" from Stripe is different from Stripe (or
    // our key) having a problem — the second one is worth retrying and
    // shouldn't tell the customer their order doesn't exist.
    if (stripeRes.status === 404) {
      return respond(404, { error: 'Order not found.' });
    }
    if (!stripeRes.ok) {
      console.error('Stripe error while verifying session:', stripeRes.status, session?.error?.message || '');
      return respond(502, { error: "We couldn't reach our payment provider to confirm this just now. Please refresh this page in a moment." });
    }

    // This is the actual proof of payment — not the URL, not anything the
    // browser said, but Stripe's own record of what happened.
    const paid = session.payment_status === 'paid' && session.status === 'complete';

    if (!paid) {
      return respond(200, { paid: false });
    }

    const m = session.metadata || {};
    // Only what the confirmation page actually shows is returned. The
    // customer's email is deliberately left out — the page doesn't use it.
    return respond(200, {
        paid: true,
        orderSummary: m.order_summary || '',
        fulfilment: m.fulfilment || '',
        dateDisplay: m.pickup_delivery_date || '',
        timeWindow: m.time_window || '',
          amount: ((session.amount_total || 0) / 100).toFixed(2),
        currency: (session.currency || 'nzd').toUpperCase()
    });
  } catch (err) {
    console.error('Verify session error:', err);
    return respond(500, { error: 'Could not verify payment. Please contact us to confirm your order.' });
  }
};

# The Old Flour Shop — deploying with real Stripe payments

This package contains everything needed to put the site live on Netlify
with real, securely-processed card payments through Stripe.

```
index.html                          the website
images/                              all photos (must stay next to the HTML file)
netlify/functions/                   three serverless functions (see below)
netlify.toml                         tells Netlify where the functions live
robots.txt                           tells search engines they can crawl the site
sitemap.xml                          lists the page for search engines
```

The three functions:
- **create-checkout-session.js** — starts a payment. Looks up the real
  cake price and delivery fee itself (never trusts the browser for
  money amounts) and creates a Stripe Checkout session.
- **verify-checkout-session.js** — called when the customer returns
  from Stripe, to confirm with Stripe directly that the payment
  actually succeeded before showing a success message.
- **stripe-webhook.js** — Stripe calls this directly the moment a
  payment succeeds, and it sends the order-confirmation emails. This
  is the authoritative trigger for "an order happened," independent
  of whether the customer's browser makes it back to your site.

## What changed from the demo version

The old "Payment" step that asked for a card number directly has been
replaced with a **"Review & pay"** step. Clicking through now sends the
order to Netlify's servers, which validate it, create a real Stripe
Checkout session, and redirect the customer to Stripe's own secure
payment page. Card details are typed on Stripe's page, never on yours —
you never see or store card numbers at all.

After payment, Stripe sends the customer back to your site, which
verifies the payment really happened (see verify-checkout-session.js
above) before showing the "Order placed!" confirmation.

## ⚠️ Keeping prices in sync — read this before changing the menu
`create-checkout-session.js` contains its own copy of every cake's `id`
and `price`, and the delivery suburbs/fees. This is deliberate: the
server must calculate the real price itself rather than trusting
whatever the browser sends, otherwise anyone could tamper with the
request and pay $1 for a cake. But it means **this site has two places
where the menu lives** — `index.html`'s `CAKES`/`DELIVERY_ZONES`
arrays (what customers see) and the matching object near the top of
`create-checkout-session.js` (what they're actually charged).

**Whenever you add a cake, remove a cake, or change a price or
delivery fee, update both files.** If you only update `index.html`,
the website will show a new price but customers will still be charged
the old one — worth checking after every menu change.

## One-time setup

### 1. Create a Stripe account
Sign up free at **stripe.com**. You'll get two keys under
**Developers → API keys**: a *Publishable* key and a *Secret* key. This
project only needs the **Secret** key (starts with `sk_test_...` while
testing, `sk_live_...` once you're ready for real payments).

### 2. Deploy to Netlify
The easiest reliable path:
1. Put this whole folder into a new **GitHub repository**
2. In Netlify: **Add new site → Import an existing project → connect
   that GitHub repo**
3. Leave the build settings as-is (there's no build step — it's already
   built) and deploy

*(Drag-and-drop deploy on Netlify's dashboard only publishes static
files — it will **not** pick up the `netlify/functions` folder. Either
the GitHub method above, or the `netlify` CLI tool run from your own
computer, are the two ways that actually deploy the functions.)*

### 3. Add your environment variables to Netlify
In your new Netlify site: **Site configuration → Environment
variables → Add a variable** — add all of these:

| Key | Value |
|---|---|
| `STRIPE_SECRET_KEY` | your Stripe secret key from step 1 |
| `SITE_URL` | `https://www.theoldflourshop.co.nz` (no trailing slash) |

`SITE_URL` matters for security, not just convenience — it's what the
server uses to build the redirect-back-to-your-site URL after payment,
rather than trusting whatever the browser claims its own address is.
Use your real domain here (below), not the temporary `*.netlify.app`
address, so it's correct from the start.

Then trigger a re-deploy (Netlify → Deploys → Trigger deploy) so the
functions pick up the new variables.

### 3b. Connect your domain (theoldflourshop.co.nz, bought via Crazy Domains)
Netlify will first give your site a temporary address like
`something-random.netlify.app`. To use your real domain instead:

1. In Netlify: **Site configuration → Domain management → Add a
   domain** → enter `theoldflourshop.co.nz`
2. Netlify will show you DNS records to add — usually an **A record**
   pointing to Netlify's load balancer IP, plus a **CNAME record** for
   the `www` version. Netlify displays the exact values to use.
3. Log into your **Crazy Domains** account → find
   `theoldflourshop.co.nz` → **DNS / Nameservers management** → add
   those same records there.
4. DNS changes can take anywhere from a few minutes to ~24 hours to
   take effect. Netlify's domain page will show a green checkmark once
   it detects the domain correctly pointing at them.
5. Netlify issues a **free SSL certificate** automatically once the
   domain is verified — no extra step needed for `https://` to work.

*(Known quirk: some users report Crazy Domains' free DNS hosting
doesn't support TXT records, which you may need later — e.g. to verify
a custom sending domain in Resend for branded confirmation emails. If
you hit that limitation, Netlify can manage your DNS directly instead
— point Crazy Domains' nameservers at Netlify's, and manage all
records from the Netlify dashboard going forward.)*

Once the domain is connected, double check `SITE_URL` above still
exactly matches whichever version of the domain you actually land on
(`https://www.theoldflourshop.co.nz` vs `https://theoldflourshop.co.nz`
without the `www` — Netlify's domain settings show you which one is
primary).

### 4. Test it
Use Stripe's test card `4242 4242 4242 4242`, any future expiry date,
any 3-digit CVC. A successful test payment will show up in your Stripe
Dashboard under **Payments** (make sure you're viewing "test mode",
toggle top-right).

### 5. Go live
Swap the `STRIPE_SECRET_KEY` environment variable to your **live**
secret key (`sk_live_...`) once you're ready to take real payments,
and re-deploy.

### 6. Tell Google the site exists
Once live at your real domain, submit it in **Google Search
Console** (search.google.com/search-console — free):
1. Add your property: `https://www.theoldflourshop.co.nz`
2. Verify ownership (Search Console gives a few options — DNS TXT
   record via Crazy Domains, or an HTML file upload, are the usual
   paths)
3. Under **Sitemaps**, submit: `sitemap.xml`

This isn't required for Google to eventually find the site, but it
meaningfully speeds up indexing rather than waiting for it to be
discovered on its own.

## Ordering more than one cake

Customers can add multiple cakes to their order in one checkout — either
several of the same cake, or a mix of different ones. Step 1 of the order
flow is a cart: each cake shows a quantity stepper (+/−) and a remove
link, plus a dropdown to add another cake before moving on.

This is enforced server-side too, not just in the browser: the checkout
function validates every cake ID in the cart against the same price
allowlist, caps quantities at a sane maximum, and builds one Stripe line
item per cake type (each with its correct quantity), plus a single
delivery line item if applicable — so a cart of 2x Lemon Mousse Cake +
1x Tiramisu Cake shows as three clean, correctly priced lines on
Stripe's payment page, not one lump sum.

## What's in the Stripe payment
Each cake in the cart becomes its own line item (with its own quantity),
and — if delivery was chosen — the delivery fee is added as one more
line item. The customer's full order details (a plain-text summary of
everything in the cart, pickup/delivery date, time window, address if
delivering, cake message, allergy notes, phone number) are attached to
the payment as **metadata**, visible when you open that payment in your
Stripe Dashboard.

## Getting automatic order emails

By default, Stripe just logs a successful payment in your Dashboard —
nothing gets emailed to anyone. This package includes a second function
that fixes that: the moment a payment succeeds, Stripe notifies it
directly, and it sends **two emails**:
1. To the **bakery** — full order details (cake, date, pickup/delivery,
   address, cake message, allergy notes, phone)
2. To the **customer** — a branded confirmation of their order with the
   same key details, plus your contact info if they need to make a change

This uses **Resend** (a straightforward email-sending service with a
generous free tier) to actually send both.

### 1. Create a free Resend account
Sign up at **resend.com** → **API Keys** → create one → copy it.

### 2. Add it to Netlify
**Site configuration → Environment variables → Add a variable**
- Key: `RESEND_API_KEY`
- Value: the key from step 1

*(Optional) also add `BAKERY_NOTIFICATION_EMAIL` if you want order
emails to go somewhere other than theoldflourshop@gmail.com.*

### 3. Tell Stripe where to send the "payment succeeded" signal
In your **Stripe Dashboard → Developers → Webhooks → Add endpoint**:
- Endpoint URL: `https://YOUR-SITE.netlify.app/.netlify/functions/stripe-webhook`
- Events to listen for: `checkout.session.completed` **and**
  `checkout.session.async_payment_succeeded`

*(The second event only matters if you ever switch on a slower payment
type in Stripe, such as a bank debit. Those complete checkout before the
money arrives, so the order is only processed once Stripe confirms the
payment has cleared. Card payments always use the first event.)*

After creating it, Stripe shows a **Signing secret** (starts with
`whsec_...`). Add that in Netlify too:
- Key: `STRIPE_WEBHOOK_SECRET`
- Value: that signing secret

Re-deploy after adding these so the function picks them up.

### 4. Test it
Make a test payment (card `4242 4242 4242 4242`, using a real email
address you can check). Within a few seconds the bakery address should
get an order notification, and the email you paid with should get a
confirmation. If not, check **Stripe Dashboard → Webhooks →
[your endpoint] → recent attempts** — it shows exactly what was sent
and any error returned, which is the fastest way to debug this if
something's not quite right.

### About the "from" address
Emails currently send from `onboarding@resend.dev`, which works
immediately with no setup — but it's a shared Resend address, not
yours. Once you're ready, you can verify your own domain in Resend
(if you have one, e.g. `theoldflourshop.co.nz`) so emails come from
something like `orders@theoldflourshop.co.nz` instead — more
professional, and less likely to land in spam.

## Tracking orders in Airtable

By default you'd have to check Stripe or your email to see what's been
ordered. This adds a row to an Airtable base the moment a payment
succeeds, so staff can see all orders — including what's coming up
this week — in one place, without touching Stripe.

### 1. Create the Airtable base and table
1. Sign up free at **airtable.com**
2. Create a new base — call it something like "Cake Orders"
3. In that base, create (or rename the default) table to **Orders**
4. Add these fields to the table, with these **exact names** and types
   (the "Cake" field will hold a summary like "2x Lemon Mousse Cake,
   1x Tiramisu Cake" for multi-item orders — make it wide enough to
   read comfortably):

| Field name | Type |
|---|---|
| Cake | Single line text |
| Fulfilment | Single line text |
| Pickup/Delivery Date | Single line text |
| Time Window | Single line text |
| Suburb | Single line text |
| Delivery Address | Single line text |
| Customer Name | Single line text |
| Phone | Phone number (or single line text) |
| Email | Email |
| Cake Message | Single line text |
| Allergy Notes | Long text |
| Amount Paid | Currency or Number |
| Stripe Session ID | Single line text |

A **Created time** field (Airtable's built-in field type) is worth
adding too, so you automatically get an "order placed at" timestamp
without this code needing to send one.

*(Field names must match exactly, including spacing and capitalisation
— Airtable won't create missing fields automatically, it'll just fail
to log that field silently.)*

### 2. Get your API credentials
1. In Airtable: click your account icon → **Developer hub** → **Personal
   access tokens** → create one
2. Give it **read and write** access, scoped to the base you just made
3. Copy the token (starts with `pat...`)
4. Find your **Base ID**: open the base, click **Help → API
   documentation** — the Base ID (starts with `app...`) is shown at
   the top

### 3. Add the credentials to Netlify
**Site configuration → Environment variables → Add a variable**:

| Key | Value |
|---|---|
| `AIRTABLE_API_KEY` | your personal access token from step 2 |
| `AIRTABLE_BASE_ID` | your Base ID from step 2 |
| `AIRTABLE_TABLE_NAME` | `Orders` (only needed if you named the table something else) |

Re-deploy after adding these.

### 4. Test it
Make a test payment. Within a few seconds a new row should appear in
your Airtable base. If it doesn't, check **Stripe Dashboard →
Webhooks → [your endpoint] → recent attempts**, and also the function
logs in Netlify (**Functions → stripe-webhook → real-time logs**) —
Airtable errors (like a mismatched field name) get logged there.

### What staff actually see day-to-day
Once orders are landing in Airtable, switch the table to **Calendar
view** grouped by "Pickup/Delivery Date" — that gives a genuine
week-at-a-glance view of what's due when, which is the main thing this
was for. Sort/filter by Fulfilment to separate pickup from delivery
orders, or by date to see what's coming up next.

## Latest round of fixes

- **The docket now updates live while typing**, not just after leaving a
  step. Name, email, phone, delivery address, message, and notes were
  previously only copied into the reviewable state when Continue was
  clicked — so the docket could show a stale or blank value mid-typing.
  Every keystroke now syncs state and refreshes the docket immediately.
- **`setCartLineQty()` hardened to match `addToCart()`'s rigor.** Not
  reachable through the UI today (the +/- buttons always pass clean
  integers), but it previously had a real latent bug: an invalid quantity
  (`NaN`) would have silently corrupted a cart line's quantity to `NaN`
  rather than being caught. Now coerced/validated the same way
  `resolveCartItem()` already does everywhere else.
- **Added a small "shared kitchen" caution directly next to both
  gluten-free checkboxes** (the cake card and the modal's add-a-cake
  row), on top of the existing allergen accordion — belt-and-suspenders
  against the option being misread as an allergen-safe guarantee.
- **Fixed `Orange &amp; Almond Cake` → `Orange & Almond Cake` in the raw
  data.** The HTML entity was correct when rendered via `innerHTML`
  (which is most places), but leaked through literally wherever the
  value hit a non-HTML-parsing context (Stripe line item names, JSON
  metadata). The backend's copy of this data was already correct — only
  the frontend had the stray entity.
- **JSON parsing hardened against non-JSON error responses.** If
  Netlify's own infrastructure has an outage, a request can come back
  as an HTML error page rather than JSON — this previously threw an
  unhandled parse error inside the generic catch block (harmless, but
  swallowed the HTTP status). A new `parseJsonSafely()` helper now
  preserves that status in the fallback message.
- **Confirmation screen now shows a short reference number** (the last
  8 characters of the Stripe session ID) — something concrete a
  customer can quote if they need to contact you about a specific order.
- **Documented, not changed**: a comment now explicitly states the
  assumption behind rendering cake data via `innerHTML` without escaping
  — safe because this data is source-controlled, and would need
  revisiting if cake names/descriptions ever came from an external or
  user-editable source.

### Two things deliberately left as open questions, not decided for you

- **The 20-item cap is per cart *line* (per cake + dietary variant), not
  per cake overall.** Since standard and no-added-gluten versions are
  separate lines, a customer can technically reach 40 of the same base
  cake (20 standard + 20 no-added-gluten). If you intend the limit to be
  20 *per variant*, this is already correct. If you intend 20 total per
  cake regardless of variant, both `index.html` and
  `create-checkout-session.js` would need to sum quantities across
  variants of the same cake ID before checking the cap — not implemented,
  since which behaviour you actually want is a business call, not a bug.
- **There's still no total-cart quantity or dollar cap.** A customer can
  add the maximum of every cake and variant in one order. This may be
  entirely fine for you — the existing code comments already document
  that daily production capacity is a backend/business-process concern,
  not something this file enforces. Flagging again only because it
  compounds with the point above (many variants × high per-line caps
  can add up to a very large single order) — not because it's assumed
  to need fixing.

- **`validateDate()` no longer bails out silently when the date is
  cleared.** Clearing the date field used to leave a stale "inside our
  48-hour window" warning visible, skip refreshing the docket, and
  skip saving the draft — so a cleared date could still come back after
  a refresh. The empty-date branch now clears the warning, updates the
  docket, and saves the draft, same as every other branch.
- **Changing the suburb now saves the draft immediately**, not just on
  the next unrelated save — previously picking a suburb and refreshing
  right after could lose that specific selection.
- **Restored time is now derived from fulfilment, never trusted from
  storage.** A stale or hand-edited draft could previously contain a
  mismatched pair like `fulfil: 'pickup'` alongside a leftover
  "Delivery time TBC". `timeWindowFor()`/`timeNoteMessageFor()` are now
  the single source of truth for this mapping, used identically whether
  the customer just clicked Pickup/Delivery or a draft is being restored.
- **Keyboard focus now moves into the Stripe-return confirmation modal**
  when it appears, matching how the ordinary order modal already
  behaves — previously only the *close* side of this was fixed, not
  the open side.
- **The confirmation icon now reflects what's actually happening.** It
  used to be a permanent green tick regardless of outcome — including
  sitting right next to "Payment not confirmed", which read as
  contradictory. It now shows a neutral "…" while checking, the tick
  only once genuinely confirmed, and a warning "!" (in the same tone
  used elsewhere on the site for warnings) if verification fails.
- **Mobile cart cramping addressed.** Reduced overlay/modal/docket
  padding and allowed cart line items to wrap on narrow phones,
  instead of forcing a 48px image, name, quantity stepper and Remove
  button into one unbroken row. Worth an actual look on a real device
  or emulator rather than taking this as a guarantee — CSS changes
  like this are inherently something to eyeball, not just reason about.
- **Long text in the docket can no longer overflow its column.** Email
  addresses, delivery addresses, and notes now wrap rather than
  potentially pushing the docket wider than its container, especially
  relevant on mobile.
- **Switching from Delivery back to Pickup now actually clears the
  delivery address**, both the input field and `state.address` — not
  just at the final payload-building step. Previously the value stayed
  hidden but present, and the pickup payload technically still sent it
  (the backend already ignored it regardless, so not a security issue —
  just untidy).

- **Delivery suburb can no longer be silently defaulted.** The suburb
  dropdown now starts on a real placeholder ("Choose your area")
  instead of quietly landing on the first real suburb in the list.
  Step 2 now explicitly requires a suburb to be selected *and* pass
  validation before Continue enables — previously only the address
  field length was checked. Combined, a stale or tampered restored
  suburb now visibly shows as unselected and blocks progress, rather
  than silently defaulting to whichever suburb happens to be first.
- **`currentDeliveryFee()` returns `null`, not `0`, when nothing valid
  is selected.** The docket now shows "select your area below" in that
  state instead of a misleading `$0.00` delivery line.
- **`addToCart()` hardened** to reject unknown cake IDs, coerce/clamp
  quantity, and only allow the no-added-gluten flag for cakes that
  actually offer it — and now shares its validation logic with
  `sanitizeCartArray()` (both call a new `resolveCartItem()` helper)
  so the two can't drift apart from each other over time.
- **Multi-cake message clarity improved without a redesign.** The
  message field keeps its single textarea, but now has a persistent
  helper line (not just placeholder text, which disappears once
  typing starts) explaining the "Cake name: message" convention for
  orders with more than one cake.
- **Daily production capacity — explicitly still not handled, on
  purpose.** Added clear comments in both files stating this needs to
  be enforced in the backend if it's ever needed, never trusted to the
  frontend. No capacity logic was added — this is a documentation-only
  change flagging a known gap for later.
- **Frontend price displays explicitly documented as preview-only.**
  A comment above `cartSubtotal()` spells out that nothing it or
  `currentDeliveryFee()` compute is ever sent to or trusted by the
  backend — `create-checkout-session.js` independently recalculates
  the real price and delivery fee from its own data every time.
- **Confirmation wording no longer claims a receipt was emailed.**
  Since this template is distributed for you to deploy yourself, and
  the automatic email system depends on you completing the Resend/
  webhook setup covered elsewhere in this README, the on-page success
  message now says "We'll be in touch to confirm the details" instead
  of asserting an email was sent — accurate regardless of whether
  you've finished that setup yet. (The actual emails sent by
  `stripe-webhook.js`, once configured, are unaffected — this only
  changed the on-page confirmation text.)
- **Orange & Almond Cake's tag is unchanged, confirmed intentional.**
  It carries `No Added Gluten` (already gluten-free by nature) rather
  than `No Added Gluten Option` (an optional substitution), so it
  correctly shows no preparation checkbox — this was a deliberate
  distinction from the start, not an oversight.

- **Gluten-free checkbox on the cake cards now resets after adding.**
  Previously it stayed checked after a successful "Add to cart," so
  adding the same cake again later (meaning to get the standard
  version this time) could silently add another no-added-gluten line
  instead, since the customer had no reason to notice a checkbox
  sitting behind an already-closed modal.
- **Draft saving is now genuinely continuous, not just at checkpoints.**
  Previously, typing into name/email/phone/address/message/notes only
  got saved when the customer hit Continue, closed the modal, or
  reached Stripe — so a refresh mid-typing could lose whatever hadn't
  been captured yet. All seven free-text fields now trigger a debounced
  save (500ms after the customer stops typing) on every keystroke, so
  the "on every meaningful change" claim below is now actually true
  rather than true-with-caveats.
- **Restored delivery suburb is now validated, not just length-capped.**
  A saved draft's suburb is checked against the real `DELIVERY_ZONES`
  list before being trusted — if a draft is stale (e.g. saved before a
  suburb was removed from that list) or manually tampered with via
  devtools, it now falls back to no-suburb-selected rather than
  restoring a value that can no longer resolve to a real fee.
- **Focus-return fixed for the Stripe success screen.** Closing an
  ordinary order modal correctly returns keyboard focus to whatever
  button opened it. The post-payment confirmation modal is different —
  it opens on a fresh page load from Stripe's redirect, with no button
  click on *this* page load to return to — so it now explicitly points
  focus back at the header's order button on close, rather than leaving
  it nowhere in particular.

- **Blackout dates set to your actual closures**: Christmas Day
  (25 Dec 2026) and New Year's Day (1 Jan 2027). Edit `BLACKOUT_DATES`
  in both `index.html` and `create-checkout-session.js` (same list,
  must match) whenever your closures change.
- **Gluten wording corrected everywhere.** The site's main allergen
  disclosure already correctly says freedom from allergens/cross-contact
  can't be guaranteed — but the checkout was inconsistently saying
  "gluten-free" in a couple of places, which reads as a stronger,
  allergen-safe claim than what's actually being offered in a shared
  kitchen. Every instance — the checkbox, the cart line, the Stripe line
  item, the order summary used in emails/Airtable — now consistently
  says **"no added gluten"**, never "gluten-free".
- **Dietary preparation is now a proper cart-line variant, not a flag
  on an existing line.** Previously, "no added gluten" applied to an
  entire cart line's whole quantity — so 1× standard + 1× no-added-
  gluten of the *same* cake wasn't possible. Choosing the option now
  happens at add-time (a checkbox next to "Add a cake", shown only for
  eligible cakes), and creates its own separate cart line — so a
  customer genuinely can order one of each variant of the same cake.
  To change a line's variant, remove it and re-add with the checkbox
  set as wanted, same as changing any other cart line.
- **Stripe cancellation recovery is now complete**, not partial. It
  used to restore the cart and contact details but not fulfilment
  method, delivery suburb/address, or date — meaning a customer had to
  redo those after cancelling and returning. All of it is now saved
  and restored together (see "Draft persistence" below).
- **Closing the order modal mid-flow no longer loses progress.**
  Previously `openOrder()` unconditionally reset everything back to a
  blank Step 1 every time it ran — so a customer who reached Step 3,
  accidentally closed the modal, then reopened it, started completely
  over (only the cart itself survived, via the older cart-only
  persistence). The whole in-progress order is now retained for the
  rest of that browser tab's session and restored automatically.
- **Draft persistence, unified.** The separate "cart-only" and
  "pending-order" sessionStorage mechanisms from the previous round
  have been merged into one: the entire draft order (cart, fulfilment,
  date, delivery details, contact fields) saves to sessionStorage on
  every meaningful change, and restores automatically whenever the
  order modal opens — covering an ordinary refresh, a cancelled Stripe
  payment, and a closed-and-reopened modal with one mechanism instead
  of three overlapping ones.
- **Restored data is now sanitised, not trusted blindly.** Anything
  pulled back out of sessionStorage — which a customer could hand-edit
  via devtools, even though doing so can't affect what they're actually
  charged — is re-validated before being trusted: unknown cake IDs are
  dropped, quantities are clamped to 1–20, and a "no added gluten" flag
  is only kept for cakes that actually offer it.
- **Maximum booking window added: 6 months ahead.** The date picker
  previously had no upper bound at all — someone could book indefinitely
  far in the future. Enforced both as the date picker's `max` (immediate
  feedback) and authoritatively server-side.
- **Backend validation, confirmed line-by-line.** Every value the
  browser sends is independently checked in
  `create-checkout-session.js` before a Stripe session is ever created —
  cake IDs against the allowlist, quantities against sane bounds, the
  "no added gluten" flag only honoured where actually offered, delivery
  suburbs against the allowlist, the date against both the 48-hour
  cutoff *and* the new 6-month ceiling *and* blackout dates, and email/
  phone against real format checks. None of this can be bypassed from
  the frontend alone — see the numbered comments directly in that file.

## Production-readiness fixes in this version

- **Cart quantity cap can no longer be bypassed.** Clicking "Add to
  cart" repeatedly (rather than using the +/− stepper) used to be able
  to push a single cake's quantity past the intended cap of 20. Fixed
  on the client, and — more importantly — already correctly enforced
  server-side regardless (see `create-checkout-session.js`, which
  rejects any quantity outside 1–20 before a Stripe session is ever
  created).
- **Gluten-free is now a real, selectable option** — not something a
  customer has to think to type into the notes field. Cakes that
  actually offer it (currently Raspberry Cheesecake, Lemon Mousse Cake,
  Passionfruit Cheesecake — controlled by `glutenFreeOption: true` in
  both `index.html`'s `CAKES` array and the matching object in
  `create-checkout-session.js`) show a "make this one gluten-free"
  checkbox per cart line. The choice is validated server-side too — a
  gluten-free request for a cake that doesn't actually offer it is
  silently ignored rather than blocking payment, and Orange & Almond
  (already gluten-free by nature) intentionally has no checkbox at all.
- **Custom messages now show which cakes actually support them.** Only
  cakes tagged "Custom Message Available" offer piped messages — the
  order form now shows a live note beneath the message field naming
  which cart items currently qualify (or explains that none do), so a
  customer isn't left guessing whether a message on, say, a cheesecake
  will actually happen.
- **Closed / blackout dates.** A `BLACKOUT_DATES` list (Christmas Day,
  Boxing Day, New Year's Day are the current placeholders — edit both
  copies, in `index.html` and `create-checkout-session.js`, to match
  your actual closures) is now checked both for immediate feedback on
  the date picker and authoritatively before a Stripe session is
  created. **This only blocks specific closed dates — it does not limit
  how many cakes can be booked for a single open day.** A genuine
  per-day production capacity limit would need a live count of existing
  orders for that date (e.g. querying Airtable at checkout time) rather
  than a static list, and isn't included here — a reasonable next step
  if order volume grows enough that this becomes a real constraint.
- **The order review step shows everything before payment.** The
  Step 4 docket now includes delivery address, email, and phone
  alongside the cakes, method, date, message and allergy notes — so a
  customer can actually catch a typo in their address before paying,
  not just after.
- **Stripe verification failures are now recoverable.** Previously, if
  the one-time "did this payment actually succeed?" check hit a
  temporary error, the page immediately stripped the session ID from
  the URL regardless of outcome — meaning a refresh could no longer
  retry, even though the payment itself may have gone through fine. The
  session ID is now only removed from the URL after a *successful*
  verification; a failed or errored check leaves it in place so
  refreshing the page tries again.
- **The confirmation heading now matches reality.** It used to say
  "Order placed!" even while still checking, or after a failed
  verification. It now reads "Checking payment…", "Order confirmed!",
  or "Payment not confirmed" depending on what's actually happened.
- **Stronger email/phone validation.** Email now uses the input's own
  browser-level validation (`checkValidity()`) rather than just
  checking for an "@" character, so something like `hello@` no longer
  passes. Phone now requires a reasonable number of digits (7–15) on
  both the client and server, rather than just "not empty".
- **Cart survives more than just a cancelled Stripe payment now.** The
  cart is saved to `sessionStorage` on every change (not only right
  before a Stripe redirect), and silently restored on an ordinary page
  refresh — not just the Stripe-cancel path that was handled before.
- **Stale form fields no longer carry over between separate orders in
  one visit.** Starting a second order after finishing (or abandoning)
  a first one used to leave the previous order's name/email/phone/
  address still sitting in the form fields. `openOrder()` now clears
  all of them explicitly.
- **Confirmation screen output is escaped**, even though it comes from
  our own server rather than directly from the customer — a small
  extra safeguard rather than relying solely on that trust boundary.

- **Cart survives a cancelled Stripe payment.** Clicking "pay" is a full
  page redirect to Stripe — if a customer cancels and comes back, the
  page reloads from scratch, which used to silently empty their cart.
  The cart and contact details are now stashed in `sessionStorage`
  right before the redirect and restored automatically if they return
  via the cancel path, so they don't have to rebuild their order.
- **Webhook duplicate protection.** Stripe explicitly documents that it
  can deliver the same webhook event more than once. This function now
  checks (a) a fast in-memory record for the current warm instance, and
  (b) whether this Stripe Session ID is already logged in Airtable —
  so a retried delivery skips re-sending both emails and re-logging the
  order, instead of duplicating them.
- **Basic rate limiting** on `create-checkout-session` and
  `verify-checkout-session` — max 10 checkout attempts / 20 verify
  attempts per IP per 5 minutes. **Worth knowing the limits of this**:
  it's a free, in-memory, best-effort check with no extra service to
  set up — it resets on a cold start and isn't shared across multiple
  concurrent function instances, so it won't stop a determined,
  distributed attacker. It will stop the more likely case: an accidental
  retry loop or a casual script hitting the endpoint from one place. If
  this site ever needs to withstand deliberate abuse at real scale, a
  proper distributed rate limiter (e.g. Upstash Redis) would be the next
  step — not included here to avoid adding a paid dependency before
  it's actually needed.

## Still worth adding later (not included yet)
- **Refunds** — handled manually via the Stripe Dashboard for now.

## Staff text alerts (ClickSend)

When a payment succeeds, the webhook texts a new-order alert to the staff
phone (**+64273399264**), e.g.:
*"New order: 1x Key Lime Pie (no added gluten). Pickup Sat, 3 Oct 2026,
10am - 12pm. Sarah Jones 021 123 4567. $136.50 paid"*

Customers are **not** texted; they get the confirmation email only.

If the ClickSend variables below aren't set, no text is sent and
everything else works exactly as before.

### Setup
1. In ClickSend: **Developers → API Credentials**. Copy your API
   username and API key.
2. In Netlify → **Site configuration → Environment variables**, add:

| Key | Value |
|---|---|
| `CLICKSEND_USERNAME` | your ClickSend API username |
| `CLICKSEND_API_KEY` | your ClickSend API key |
| `BAKERY_SMS_NUMBER` | *(optional)* only if alerts should go somewhere other than +64273399264 |
| `CLICKSEND_FROM` | *(optional)* a dedicated ClickSend number in `+64...` format. Leave out to use ClickSend's shared number |

3. Trigger a re-deploy so the function picks them up.
4. Place a test order (Stripe test card `4242 4242 4242 4242`). The staff
   phone should get the alert within a few seconds. If not, check
   **Netlify → Logs → Functions → stripe-webhook** for a
   `ClickSend error` line, and your ClickSend dashboard's SMS history.

### Things to know
- **Credit:** every alert uses ClickSend credit. Keep auto top-up on, or
  alerts silently stop when the balance runs out (orders and emails
  still work).
- **No links:** ClickSend holds back texts containing web links on new
  accounts, so the alert deliberately contains none.

## If something goes wrong saving an order

When a payment succeeds, the webhook saves the order record first:
Airtable if it's set up, otherwise the bakery email. If that step fails
(for example Airtable or Resend is briefly down), the webhook tells Stripe
so, and **Stripe automatically tries again**, repeatedly for up to 3 days.
Nothing is emailed or texted until the order has been saved, so a retry
never sends double emails.

The customer email and staff text are sent after that, and a failure
there is logged but doesn't trigger a retry.

You can see any retries in **Stripe Dashboard → Developers → Webhooks →
your endpoint**, where failed attempts show in red with the time of the
next retry.

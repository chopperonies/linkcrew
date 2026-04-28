// Creates the 3 Stripe products + recurring prices for the new pricing tier.
//
// Crew: $49/mo (1 seat)
// Team: $99/mo (5 seats) — only run if you want to bump from $97
// Pro:  $199/mo (15 seats) — replaces old $165/10-seat Pro
//
// Usage:
//   STRIPE_SECRET_KEY=sk_live_xxx node fieldsync/scripts/create-stripe-prices.js
//
// Or to also create a new Team price (otherwise existing $97 is kept):
//   STRIPE_SECRET_KEY=sk_live_xxx CREATE_TEAM=1 node fieldsync/scripts/create-stripe-prices.js
//
// Idempotent on the Stripe side: each run creates NEW price objects (you can have many prices
// per product). Old prices keep working for any active subscribers.

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('Missing STRIPE_SECRET_KEY env var.');
  console.error('Run: STRIPE_SECRET_KEY=sk_live_... node fieldsync/scripts/create-stripe-prices.js');
  process.exit(1);
}
const stripe = require('stripe')(stripeKey);

const NEW_PRICES = [
  { key: 'STRIPE_PRICE_CREW', name: 'LinkCrew Crew',  amount: 4900,  desc: '1 crew member · solo operators' },
  { key: 'STRIPE_PRICE_PRO',  name: 'LinkCrew Pro',   amount: 19900, desc: '15 crew members · AI voice receptionist included' },
];
if (process.env.CREATE_TEAM === '1') {
  NEW_PRICES.splice(1, 0, { key: 'STRIPE_PRICE_TEAM', name: 'LinkCrew Team', amount: 9900, desc: '5 crew members · most popular' });
}

(async () => {
  console.log(`Stripe key mode: ${stripeKey.startsWith('sk_live_') ? 'LIVE' : 'TEST'}\n`);
  const results = [];

  for (const p of NEW_PRICES) {
    console.log(`Creating product: ${p.name}…`);
    const product = await stripe.products.create({
      name: p.name,
      description: p.desc,
    });
    console.log(`  product:  ${product.id}`);

    console.log(`Creating $${p.amount/100}/mo recurring price…`);
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: p.amount,
      recurring: { interval: 'month' },
    });
    console.log(`  price:    ${price.id}\n`);

    results.push({ key: p.key, priceId: price.id });
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Add these to Render env vars on the linkcrew service:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const r of results) {
    console.log(`${r.key}=${r.priceId}`);
  }
})();

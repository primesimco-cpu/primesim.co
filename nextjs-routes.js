/**
 * Next.js App Router — API Routes
 * app.primesimobile.com/api/...
 *
 * File structure (copy to your Next.js project):
 *
 * app/
 *   api/
 *     plans/route.js              → GET  /api/plans
 *     orders/route.js             → POST /api/orders
 *     orders/[id]/refund/route.js → POST /api/orders/:id/refund
 *     coupons/validate/route.js   → POST /api/coupons/validate
 *     esims/[iccid]/usage/route.js→ GET  /api/esims/:iccid/usage
 *     webhooks/
 *       stripe/route.js           → POST /api/webhooks/stripe
 *       esimaccess/route.js       → POST /api/webhooks/esimaccess
 *     health/route.js             → GET  /api/health
 */

// ────────────────────────────────────────────────────────────────
// app/api/plans/route.js
// ────────────────────────────────────────────────────────────────
const { NextResponse } = require('next/server');
const { routePackages } = require('../../esim-access/esim-router');

async function GET_plans(request) {
  const { searchParams } = new URL(request.url);
  const country = searchParams.get('country');
  try {
    const data = await routePackages(country);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ────────────────────────────────────────────────────────────────
// app/api/orders/route.js
// ────────────────────────────────────────────────────────────────
const { createPaymentIntent, validateCoupon } = require('../../stripe/stripe.service');
const { v4: uuidv4 } = require('uuid');

async function POST_orders(request) {
  try {
    const body = await request.json();
    const { packageCode, price, customerEmail, couponCode, userId, planName, country } = body;

    if (!packageCode || !price || !customerEmail)
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });

    const orderId = uuidv4();
    const payment = await createPaymentIntent({
      amount: price, orderId, customerEmail, couponCode,
      metadata: { userId, planName, country, packageCode },
    });

    return NextResponse.json({ success: true, orderId, ...payment });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ────────────────────────────────────────────────────────────────
// app/api/webhooks/stripe/route.js
// ⚠️  CRITICAL: rawBody must be Buffer — do NOT parse JSON
// ────────────────────────────────────────────────────────────────
const { constructWebhookEvent, handleWebhookEvent, createRefund } = require('../../stripe/stripe.service');
const { routeOrder } = require('../../esim-access/esim-router');

async function POST_stripe_webhook(request) {
  const sig  = request.headers.get('stripe-signature');
  const body = await request.arrayBuffer();
  const raw  = Buffer.from(body);

  let event;
  try {
    event = constructWebhookEvent(raw, sig);
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const action = handleWebhookEvent(event);

  if (action.action === 'PROVISION_ESIM') {
    try {
      const { orderId, metadata, amount } = action;

      const esim = await routeOrder({
        transactionId: orderId,
        packageCode:   metadata.packageCode,
        price:         parseFloat((amount * 0.6).toFixed(2)),
      });

      console.log(`✓ Provisioned ICCID: ${esim.iccid}`);

      // TODO: save to DB, send email, send push notification

      return NextResponse.json({ received: true, iccid: esim.iccid });
    } catch (err) {
      console.error('Provision failed:', err);
      return NextResponse.json({ received: true, provision: 'failed' });
    }
  }

  return NextResponse.json({ received: true });
}

// Next.js config to disable body parsing for webhook route:
// export const config = { api: { bodyParser: false } };

module.exports = { GET_plans, POST_orders, POST_stripe_webhook };

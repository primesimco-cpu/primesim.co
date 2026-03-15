/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  API Route Handlers — PrimeSIM Mobile                           ║
 * ║  app.primesimobile.com                                          ║
 * ║                                                                  ║
 * ║  Compatible with: Next.js App Router / Express / Fastify        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const { createPaymentIntent, constructWebhookEvent,
        handleWebhookEvent, validateCoupon, createRefund } = require('../stripe/stripe.service');
const { routeOrder, routeUsage, routePackages,
        getProviderStatus }                                = require('../esim-access/esim-router');
const { v4: uuidv4 }                                       = require('uuid');

// ════════════════════════════════════════════════════════════════
// PLANS
// GET /api/plans?country=JP
// ════════════════════════════════════════════════════════════════
async function getPlans(req, res) {
  try {
    const country = req.query?.country || req.params?.country || null;
    const results = await routePackages(country);
    return res.json({ success: true, data: results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// VALIDATE COUPON
// POST /api/coupons/validate
// Body: { code }
// ════════════════════════════════════════════════════════════════
async function validateCouponRoute(req, res) {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'code required' });
    const result = await validateCoupon(code);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// CREATE ORDER  (Step 1: Create Payment Intent)
// POST /api/orders
// Body: { packageCode, price, customerEmail, couponCode?, userId? }
// ════════════════════════════════════════════════════════════════
async function createOrder(req, res) {
  try {
    const { packageCode, price, customerEmail, couponCode, userId, planName, country } = req.body;

    if (!packageCode || !price || !customerEmail)
      return res.status(400).json({ success: false, error: 'packageCode, price, customerEmail required' });

    const orderId = uuidv4();

    // 1. Create Stripe Payment Intent
    const payment = await createPaymentIntent({
      amount:        price,
      orderId,
      customerEmail,
      couponCode,
      metadata:      { userId, planName, country },
    });

    // 2. Store pending order in DB (pseudo-code — replace with your DB call)
    // await db.orders.create({ id: orderId, packageCode, price, customerEmail, status: 'PENDING_PAYMENT' });

    return res.json({
      success:     true,
      orderId,
      clientSecret: payment.clientSecret,
      amount:       payment.amount,
    });
  } catch (err) {
    console.error('[createOrder]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK  (Step 2: Payment confirmed → provision eSIM)
// POST /api/webhooks/stripe
// ⚠️  Must receive RAW body — disable bodyParser for this route
// ════════════════════════════════════════════════════════════════
async function stripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = constructWebhookEvent(req.rawBody || req.body, sig);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const action = handleWebhookEvent(event);
  console.log(`[Stripe Webhook] ${action.action} — order ${action.orderId}`);

  // ── Payment succeeded → provision eSIM ────────────────────────
  if (action.action === 'PROVISION_ESIM') {
    try {
      const { orderId, metadata } = action;

      // Fetch order from DB (replace with real DB call)
      // const order = await db.orders.findById(orderId);

      // Provision eSIM via router
      const esim = await routeOrder({
        transactionId: orderId,
        packageCode:   metadata.packageCode || 'FALLBACK_CODE', // get from order in DB
        price:         action.amount * 0.6, // wholesale price
      });

      // Update order in DB
      // await db.orders.update(orderId, { status: 'ACTIVE', iccid: esim.iccid, lpaCode: esim.lpaCode });

      // Send QR code email (replace with your email service)
      // await emailService.sendESIMDelivery({ email: order.customerEmail, ...esim });

      // Push notification (Firebase FCM)
      // await fcm.send({ token: userFcmToken, title: 'eSIM Hazır!', body: 'QR kodunuz hazır.' });

      console.log(`[Provision] ✓ eSIM provisioned: ICCID ${esim.iccid} for order ${orderId}`);
      return res.json({ received: true, iccid: esim.iccid });

    } catch (err) {
      console.error(`[Provision] ✗ Failed for order ${action.orderId}:`, err);
      // IMPORTANT: still return 200 to Stripe — handle retry internally
      // await db.orders.update(action.orderId, { status: 'PROVISION_FAILED', error: err.message });
      return res.json({ received: true, error: 'provision_failed' });
    }
  }

  // ── Payment failed ─────────────────────────────────────────────
  if (action.action === 'PAYMENT_FAILED') {
    // await db.orders.update(action.orderId, { status: 'PAYMENT_FAILED' });
    // await emailService.sendPaymentFailed({ orderId: action.orderId });
    console.log(`[Payment] Failed: ${action.failureMessage}`);
  }

  // ── Refund issued ──────────────────────────────────────────────
  if (action.action === 'REFUND_ISSUED') {
    // await db.orders.update(action.orderId, { status: 'REFUNDED' });
    // Revoke eSIM if still unused
    // await esimAccess.revokeProfile(order.iccid, action.orderId).catch(() => {});
    console.log(`[Refund] Issued for order ${action.orderId}`);
  }

  return res.json({ received: true });
}

// ════════════════════════════════════════════════════════════════
// eSIM USAGE
// GET /api/esims/:iccid/usage
// ════════════════════════════════════════════════════════════════
async function getUsage(req, res) {
  try {
    const iccid = req.params?.iccid;
    if (!iccid) return res.status(400).json({ success: false, error: 'iccid required' });
    const usage = await routeUsage(iccid);
    return res.json({ success: true, data: usage });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// REFUND
// POST /api/orders/:orderId/refund
// Body: { paymentIntentId, amount? }
// ════════════════════════════════════════════════════════════════
async function refundOrder(req, res) {
  try {
    const { paymentIntentId, amount } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });
    const refund = await createRefund(paymentIntentId, amount || null);
    return res.json({ success: true, refund });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// eSIM WEBHOOK (from eSIM Access provider)
// POST /api/webhooks/esimaccess
// ════════════════════════════════════════════════════════════════
async function esimAccessWebhook(req, res) {
  try {
    const { parseWebhook } = require('../esim-access/esimaccess.service');
    const evt = parseWebhook(req.body);
    console.log(`[eSIM Webhook] ${evt.event} — ICCID: ${evt.iccid}`);

    if (evt.event === 'profile.activated') {
      // await db.esims.update(evt.iccid, { status: 'ACTIVE', activatedAt: new Date() });
    }
    if (evt.event === 'usage.low_data') {
      // await fcm.send({ iccid: evt.iccid, title: 'Düşük Veri!', body: '%10 kaldı.' });
    }
    if (evt.event === 'usage.exhausted') {
      // await fcm.send({ iccid: evt.iccid, title: 'Veri Bitti!', body: 'Top-up yapın.' });
    }

    return res.json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
// HEALTH CHECK
// GET /api/health
// ════════════════════════════════════════════════════════════════
async function healthCheck(req, res) {
  const providers = getProviderStatus();
  const allHealthy = providers.every(p => p.healthy);
  return res.status(allHealthy ? 200 : 503).json({
    status:    allHealthy ? 'healthy' : 'degraded',
    providers,
    timestamp: new Date().toISOString(),
    version:   '3.0.0',
    domain:    'app.primesimobile.com',
  });
}

module.exports = {
  getPlans, validateCouponRoute, createOrder,
  stripeWebhook, getUsage, refundOrder,
  esimAccessWebhook, healthCheck,
};

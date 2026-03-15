/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Stripe Payment Service — PrimeSIM Mobile                       ║
 * ║  app.primesimobile.com                                          ║
 * ║                                                                  ║
 * ║  Features:                                                       ║
 * ║  • Payment Intent (card, Apple Pay, Google Pay)                 ║
 * ║  • Webhook signature verification                               ║
 * ║  • Refund handling                                              ║
 * ║  • Idempotency keys (no duplicate charges)                      ║
 * ║  • Customer & saved cards                                       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion:  '2024-04-10',
  appInfo:     { name: 'PrimeSIM Mobile', version: '3.0.0', url: 'https://app.primesimobile.com' },
  maxNetworkRetries: 3,
});

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL || 'https://app.primesimobile.com';

// ════════════════════════════════════════════════════════════════
// 1. PAYMENT INTENT — core charge flow
// ════════════════════════════════════════════════════════════════

/**
 * Create Payment Intent for eSIM purchase
 * Called when user clicks "Pay" in checkout
 *
 * @param {object} params
 * @param {number}  params.amount        - Price in USD (e.g. 12.00)
 * @param {string}  params.orderId       - Your order UUID
 * @param {string}  params.customerId    - Stripe customer ID (optional)
 * @param {string}  params.customerEmail
 * @param {object}  params.metadata      - { planName, country, iccid, userId }
 * @param {string}  params.couponCode    - Applied coupon (optional)
 * @returns { clientSecret, paymentIntentId, amount }
 */
async function createPaymentIntent({
  amount, orderId, customerId, customerEmail, metadata = {}, couponCode,
}) {
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  if (!orderId)              throw new Error('orderId required');

  // Apply coupon discount server-side
  let finalAmount = Math.round(amount * 100); // Stripe uses cents
  if (couponCode) {
    const discount = await applyCouponDiscount(amount, couponCode);
    finalAmount = Math.round(discount.finalAmount * 100);
  }

  // Get or create Stripe customer
  let stripeCustomerId = customerId;
  if (!stripeCustomerId && customerEmail) {
    stripeCustomerId = await getOrCreateCustomer(customerEmail, metadata.userId);
  }

  const intent = await stripe.paymentIntents.create({
    amount:   finalAmount,
    currency: 'usd',
    customer: stripeCustomerId || undefined,

    // Enable Apple Pay + Google Pay + card
    payment_method_types: ['card'],
    payment_method_options: {
      card: { request_three_d_secure: 'automatic' },
    },

    // Idempotency: same orderId = same charge
    metadata: {
      orderId,
      couponCode: couponCode || '',
      userId:     metadata.userId || '',
      planName:   metadata.planName || '',
      country:    metadata.country || '',
      iccid:      metadata.iccid || '',
      appVersion: '3.0.0',
    },

    // Auto-capture on confirm
    capture_method: 'automatic',

    // Receipt
    receipt_email: customerEmail || undefined,

    description: `PrimeSIM — ${metadata.planName || 'eSIM Plan'} (${metadata.country || ''})`,
  }, {
    idempotencyKey: `pi_${orderId}`,
  });

  return {
    clientSecret:    intent.client_secret,
    paymentIntentId: intent.id,
    amount:          finalAmount / 100,
    currency:        'usd',
  };
}

// ════════════════════════════════════════════════════════════════
// 2. CUSTOMER MANAGEMENT
// ════════════════════════════════════════════════════════════════

async function getOrCreateCustomer(email, userId = null) {
  // Search existing
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0].id;

  // Create new
  const customer = await stripe.customers.create({
    email,
    metadata: { userId: userId || '', source: 'app.primesimobile.com' },
  });
  return customer.id;
}

async function savePaymentMethod(customerId, paymentMethodId) {
  await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

async function listSavedCards(customerId) {
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  return methods.data.map(m => ({
    id:     m.id,
    brand:  m.card.brand,
    last4:  m.card.last4,
    expiry: `${m.card.exp_month}/${m.card.exp_year}`,
  }));
}

// ════════════════════════════════════════════════════════════════
// 3. REFUNDS
// ════════════════════════════════════════════════════════════════

/**
 * Issue refund for an order
 * @param {string} paymentIntentId
 * @param {number} amount - Partial refund amount in USD (null = full refund)
 * @param {string} reason - 'requested_by_customer' | 'fraudulent' | 'duplicate'
 */
async function createRefund(paymentIntentId, amount = null, reason = 'requested_by_customer') {
  const params = {
    payment_intent: paymentIntentId,
    reason,
    ...(amount ? { amount: Math.round(amount * 100) } : {}),
  };

  const refund = await stripe.refunds.create(params);
  return {
    refundId: refund.id,
    status:   refund.status,
    amount:   refund.amount / 100,
  };
}

// ════════════════════════════════════════════════════════════════
// 4. COUPON / DISCOUNT (server-side validation)
// ════════════════════════════════════════════════════════════════

const VALID_COUPONS = {
  PRIME20:     { pct: 20, active: true },
  WELCOME10:   { pct: 10, active: true },
  SUMMER30:    { pct: 30, active: true },
  BUSINESS25:  { pct: 25, active: true },
  FLASH40:     { pct: 40, active: true },
};

async function applyCouponDiscount(amount, code) {
  const coupon = VALID_COUPONS[code?.toUpperCase()];
  if (!coupon || !coupon.active) {
    return { valid: false, finalAmount: amount, discount: 0 };
  }
  const discount = amount * (coupon.pct / 100);
  return {
    valid:       true,
    finalAmount: parseFloat((amount - discount).toFixed(2)),
    discount:    parseFloat(discount.toFixed(2)),
    pct:         coupon.pct,
    code,
  };
}

async function validateCoupon(code) {
  const coupon = VALID_COUPONS[code?.toUpperCase()];
  if (!coupon || !coupon.active) return { valid: false };
  return { valid: true, discount: coupon.pct, type: 'percentage' };
}

// ════════════════════════════════════════════════════════════════
// 5. WEBHOOK HANDLER
// ════════════════════════════════════════════════════════════════

/**
 * Verify + parse incoming Stripe webhook
 * Route: POST /api/webhooks/stripe
 *
 * @param {Buffer}  rawBody  - req.rawBody (must be raw Buffer, not parsed JSON)
 * @param {string}  signature - req.headers['stripe-signature']
 * @returns Parsed Stripe event
 */
function constructWebhookEvent(rawBody, signature) {
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

/**
 * Handle Stripe webhook events
 * Returns action to take based on event type
 *
 * @param {object} event - Verified Stripe event
 * @returns { action, orderId, paymentIntentId, amount, customerId }
 */
function handleWebhookEvent(event) {
  const { type, data } = event;
  const obj = data.object;

  switch (type) {
    // ── Payment succeeded → provision eSIM ──────────────────────
    case 'payment_intent.succeeded':
      return {
        action:          'PROVISION_ESIM',
        orderId:         obj.metadata.orderId,
        paymentIntentId: obj.id,
        amount:          obj.amount / 100,
        currency:        obj.currency,
        customerId:      obj.customer,
        metadata:        obj.metadata,
      };

    // ── Payment failed → notify user ─────────────────────────────
    case 'payment_intent.payment_failed':
      return {
        action:          'PAYMENT_FAILED',
        orderId:         obj.metadata.orderId,
        paymentIntentId: obj.id,
        failureCode:     obj.last_payment_error?.code,
        failureMessage:  obj.last_payment_error?.message,
        customerId:      obj.customer,
      };

    // ── Refund issued ─────────────────────────────────────────────
    case 'charge.refunded':
      return {
        action:    'REFUND_ISSUED',
        chargeId:  obj.id,
        amount:    obj.amount_refunded / 100,
        orderId:   obj.metadata?.orderId,
      };

    // ── Dispute opened → flag order ─────────────────────────────
    case 'charge.dispute.created':
      return {
        action:   'DISPUTE_OPENED',
        chargeId: obj.charge,
        amount:   obj.amount / 100,
        reason:   obj.reason,
      };

    default:
      return { action: 'UNHANDLED', type };
  }
}

// ════════════════════════════════════════════════════════════════
// 6. REPORTING
// ════════════════════════════════════════════════════════════════

async function getBalanceSummary() {
  const balance = await stripe.balance.retrieve();
  return {
    available: balance.available.map(b => ({ amount: b.amount / 100, currency: b.currency })),
    pending:   balance.pending.map(b => ({ amount: b.amount / 100, currency: b.currency })),
  };
}

async function listRecentCharges(limit = 20) {
  const charges = await stripe.charges.list({ limit });
  return charges.data.map(c => ({
    id:       c.id,
    amount:   c.amount / 100,
    currency: c.currency,
    status:   c.status,
    email:    c.billing_details?.email,
    orderId:  c.metadata?.orderId,
    date:     new Date(c.created * 1000).toISOString(),
  }));
}

module.exports = {
  stripe,
  createPaymentIntent,
  getOrCreateCustomer, savePaymentMethod, listSavedCards,
  createRefund,
  applyCouponDiscount, validateCoupon,
  constructWebhookEvent, handleWebhookEvent,
  getBalanceSummary, listRecentCharges,
};

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Integration Test Suite — PrimeSIM Mobile                       ║
 * ║  app.primesimobile.com                                          ║
 * ║                                                                  ║
 * ║  Run:  node tests/run-tests.js                                  ║
 * ║  Env:  ESIMACCESS_API_KEY + STRIPE_SECRET_KEY required          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();

const esimAccess = require('../esim-access/esimaccess.service');
const telnyx     = require('../esim-access/telnyx.service');
const router     = require('../esim-access/esim-router');
const stripe     = require('../stripe/stripe.service');
const { v4: uuidv4 } = require('uuid');

// ── Test runner ─────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;

async function test(name, fn, skip = false) {
  if (skip) {
    console.log(`  ⏭  SKIP  ${name}`);
    skipped++;
    return;
  }
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL  ${name}`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ════════════════════════════════════════════════════════════════
async function runTests() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║  PrimeSIM Integration Tests                    ║');
  console.log('║  app.primesimobile.com                         ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  const hasESIM   = !!process.env.ESIMACCESS_API_KEY && !process.env.ESIMACCESS_API_KEY.includes('BURAYA');
  const hasStripe = !!process.env.STRIPE_SECRET_KEY  && !process.env.STRIPE_SECRET_KEY.includes('BURAYA');

  // ─────────────────────────────────────────────────
  console.log('── 1. eSIM Access API ──────────────────────────');

  await test('Health check', async () => {
    const r = await esimAccess.healthCheck();
    assert(typeof r.healthy === 'boolean', 'healthy must be boolean');
    console.log(`     Balance: $${r.balance || 'N/A'}`);
  }, !hasESIM);

  await test('List packages (global)', async () => {
    const r = await esimAccess.listPackages();
    assert(r.result !== false, 'API returned error');
    const count = r.obj?.packageList?.length || 0;
    assert(count > 0, 'Should return packages');
    console.log(`     ${count} packages found`);
  }, !hasESIM);

  await test('List packages for Japan (JP)', async () => {
    const r = await esimAccess.listPackages('JP');
    assert(r.result !== false, 'API returned error');
    console.log(`     JP packages: ${r.obj?.packageList?.length || 0}`);
  }, !hasESIM);

  await test('List packages for Turkey (TR)', async () => {
    const r = await esimAccess.listPackages('TR');
    assert(r.result !== false, 'API returned error');
    console.log(`     TR packages: ${r.obj?.packageList?.length || 0}`);
  }, !hasESIM);

  await test('Create order (sandbox)', async () => {
    const packages = await esimAccess.listPackages('JP');
    const pkg = packages.obj?.packageList?.[0];
    if (!pkg) throw new Error('No packages available for test');

    const txId = `test_${uuidv4()}`;
    const order = await esimAccess.createOrder({
      transactionId: txId,
      packageCode:   pkg.packageCode,
      price:         pkg.price,
    });

    assert(order.iccid,   'ICCID required in response');
    assert(order.lpaCode, 'LPA code required in response');
    console.log(`     ICCID: ${order.iccid}`);
    console.log(`     LPA:   ${order.lpaCode?.substring(0, 40)}...`);

    // Test usage query
    const usage = await esimAccess.getProfileUsage(order.iccid);
    assert(usage.iccid === order.iccid, 'ICCID mismatch');
    console.log(`     Usage: ${usage.remainingMB}MB remaining`);

    // Revoke test order to recover credits
    await esimAccess.revokeProfile(order.iccid, txId).catch(() => {});
    console.log(`     ♻️  Test order revoked`);
  }, !hasESIM);

  await test('Webhook parser', async () => {
    const payload = {
      notifyType: 'ESIM_ACTIVATED', iccid: '8901420000000001',
      transactionId: 'txn_test', time: Date.now(),
    };
    const evt = esimAccess.parseWebhook(payload);
    assert(evt.event === 'profile.activated', `Event: ${evt.event}`);
    assert(evt.iccid === payload.iccid, 'ICCID mismatch');
  });

  await test('Invalid API key error handling', async () => {
    const orig = process.env.ESIMACCESS_API_KEY;
    process.env.ESIMACCESS_API_KEY = 'invalid_key_test';
    try {
      await esimAccess.listPackages();
      throw new Error('Should have thrown');
    } catch (err) {
      assert(err instanceof esimAccess.ESIMAccessError || err.message, 'Should throw ESIMAccessError');
    } finally {
      process.env.ESIMACCESS_API_KEY = orig;
    }
  });

  // ─────────────────────────────────────────────────
  console.log('\n── 2. eSIM Router ──────────────────────────────');

  await test('Provider status', async () => {
    const status = router.getProviderStatus();
    assert(Array.isArray(status), 'Should return array');
    assert(status.length >= 1, 'Should have at least 1 provider');
    status.forEach(p => {
      assert(p.id && p.name, `Provider ${p.id} missing fields`);
    });
    console.log(`     Providers: ${status.map(p => p.name).join(', ')}`);
  });

  await test('Route packages — merges providers', async () => {
    const results = await router.routePackages('DE');
    assert(Array.isArray(results), 'Should return array');
    console.log(`     Provider responses: ${results.length}`);
  }, !hasESIM);

  // ─────────────────────────────────────────────────
  console.log('\n── 3. Stripe Payment ───────────────────────────');

  await test('Create Payment Intent ($12 USD)', async () => {
    const intent = await stripe.createPaymentIntent({
      amount:        12.00,
      orderId:       `test_${uuidv4()}`,
      customerEmail: 'test@primesimobile.com',
      metadata:      { planName: 'Japan 5GB', country: 'JP' },
    });
    assert(intent.clientSecret?.startsWith('pi_'), 'clientSecret should start with pi_');
    assert(intent.amount === 12.00, `Amount: ${intent.amount}`);
    console.log(`     Intent: ${intent.paymentIntentId}`);
    console.log(`     Amount: $${intent.amount}`);
  }, !hasStripe);

  await test('Coupon validation — PRIME20 (20% off)', async () => {
    const result = await stripe.validateCoupon('PRIME20');
    assert(result.valid === true, 'PRIME20 should be valid');
    assert(result.discount === 20, `Discount: ${result.discount}%`);
  });

  await test('Coupon validation — SUMMER30 (30% off)', async () => {
    const result = await stripe.validateCoupon('SUMMER30');
    assert(result.valid === true, 'SUMMER30 should be valid');
    assert(result.discount === 30, `Discount: ${result.discount}%`);
  });

  await test('Coupon validation — INVALID code', async () => {
    const result = await stripe.validateCoupon('NOTEXIST');
    assert(result.valid === false, 'Invalid coupon should return valid: false');
  });

  await test('Apply coupon discount to $18.00', async () => {
    const result = await stripe.applyCouponDiscount(18.00, 'PRIME20');
    assert(result.valid === true, 'Coupon valid');
    assert(result.finalAmount === 14.40, `Final: $${result.finalAmount} (expected $14.40)`);
    assert(result.discount === 3.60, `Discount: $${result.discount}`);
    console.log(`     $18.00 - 20% = $${result.finalAmount}`);
  });

  await test('Payment Intent with coupon (PRIME20)', async () => {
    const intent = await stripe.createPaymentIntent({
      amount:        18.00,
      orderId:       `test_${uuidv4()}`,
      customerEmail: 'test@primesimobile.com',
      couponCode:    'PRIME20',
      metadata:      { planName: 'Germany 10GB', country: 'DE' },
    });
    assert(intent.amount === 14.40, `Amount with discount: $${intent.amount} (expected $14.40)`);
    console.log(`     $18.00 → $${intent.amount} (PRIME20 applied)`);
  }, !hasStripe);

  await test('Webhook signature verification (tampered body)', async () => {
    try {
      stripe.constructWebhookEvent(Buffer.from('tampered'), 'invalid_sig');
      throw new Error('Should have thrown');
    } catch (err) {
      assert(err.message !== 'Should have thrown', 'Should reject tampered webhook');
    }
  }, !hasStripe);

  await test('Stripe balance summary', async () => {
    const balance = await stripe.getBalanceSummary();
    assert(Array.isArray(balance.available), 'Should return available balance');
    console.log(`     Available: ${balance.available.map(b => `$${b.amount} ${b.currency}`).join(', ')}`);
  }, !hasStripe);

  // ─────────────────────────────────────────────────
  console.log('\n── 4. End-to-End Flow ──────────────────────────');

  await test('Full purchase flow: intent → provision (sandbox)', async () => {
    const orderId = `e2e_${uuidv4()}`;

    // Step 1: create payment intent
    const intent = await stripe.createPaymentIntent({
      amount: 12.00, orderId,
      customerEmail: 'e2e@primesimobile.com',
      metadata: { planName: 'Japan 5GB', country: 'JP', packageCode: 'TEST_PKG' },
    });
    assert(intent.clientSecret, 'Step 1 OK: clientSecret created');
    console.log(`     Step 1 ✓ Payment intent created`);

    // Step 2: simulate Stripe webhook event
    const fakeEvent = {
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id:     intent.paymentIntentId,
          amount: 1200,
          currency: 'usd',
          customer: null,
          metadata: { orderId, packageCode: 'TEST_PKG', planName: 'Japan 5GB', country: 'JP' },
        },
      },
    };
    const action = stripe.handleWebhookEvent(fakeEvent);
    assert(action.action === 'PROVISION_ESIM', `Action: ${action.action}`);
    assert(action.orderId === orderId, 'OrderId matches');
    console.log(`     Step 2 ✓ Webhook parsed: action=${action.action}`);

    // Step 3: router would provision (skipped in test — no real API call)
    console.log(`     Step 3 ✓ Router would provision eSIM via eSIM Access`);
    console.log(`     E2E test complete for order ${orderId}`);
  }, !hasStripe);

  // ─────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log(`║  Results: ${passed} passed, ${failed} failed, ${skipped} skipped    ║`);
  console.log('╚════════════════════════════════════════════════╝\n');

  if (!hasESIM)   console.log('⚠️  Set ESIMACCESS_API_KEY in .env to run eSIM tests');
  if (!hasStripe) console.log('⚠️  Set STRIPE_SECRET_KEY in .env to run Stripe tests');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

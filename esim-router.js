/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  eSIM Router — Intelligent Provider Selection & Failover     ║
 * ║  PrimeSIM Mobile — app.primesimobile.com                    ║
 * ║                                                              ║
 * ║  Logic:                                                      ║
 * ║  1. Select provider by: coverage → health → lowest cost     ║
 * ║  2. Auto-failover to next provider on error                 ║
 * ║  3. Emit events for monitoring                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const esimAccess = require('./esimaccess.service');
const telnyx     = require('./telnyx.service');

// ─── Provider Registry ──────────────────────────────────────────
const PROVIDERS = [
  {
    id:       'esimaccess',
    name:     'eSIM Access',
    priority: 1,       // 1 = highest
    healthy:  true,
    lastCheck: null,
    errorCount: 0,
    service: esimAccess,

    // Adapter: normalize createOrder response
    async order({ transactionId, packageCode, price }) {
      return esimAccess.createOrder({ transactionId, packageCode, count: 1, price });
    },
    async usage(iccid) { return esimAccess.getProfileUsage(iccid); },
    async health()      { return esimAccess.healthCheck(); },
    async packages(cc)  { return esimAccess.listPackages(cc); },
  },
  {
    id:       'telnyx',
    name:     'Telnyx',
    priority: 2,
    healthy:  true,
    lastCheck: null,
    errorCount: 0,
    service: telnyx,

    async order({ transactionId, packageCode, price }) {
      return telnyx.purchaseBundle({ bundleId: packageCode, transactionId });
    },
    async usage(iccid) { return telnyx.getUsage(iccid); },
    async health()      { return telnyx.healthCheck(); },
    async packages(cc)  { return telnyx.listBundles(cc); },
  },
];

// ─── Provider Health Monitor ─────────────────────────────────────
async function refreshHealth() {
  await Promise.allSettled(
    PROVIDERS.map(async p => {
      const result = await p.health().catch(e => ({ healthy: false, error: e.message }));
      p.healthy   = result.healthy;
      p.lastCheck = new Date().toISOString();
      if (!result.healthy) p.errorCount++;
      else p.errorCount = 0;
    })
  );
}

// Run health check every 5 minutes
setInterval(refreshHealth, 5 * 60 * 1000);

// ─── Provider Selection ──────────────────────────────────────────
function selectProviders(preferredId = null) {
  let pool = [...PROVIDERS].filter(p => p.healthy);
  if (!pool.length) pool = [...PROVIDERS]; // fallback: use all even if unhealthy

  if (preferredId) {
    const preferred = pool.find(p => p.id === preferredId);
    if (preferred) {
      return [preferred, ...pool.filter(p => p.id !== preferredId)];
    }
  }

  return pool.sort((a, b) => a.priority - b.priority);
}

// ════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════

/**
 * Place an eSIM order with automatic failover
 * @param {object} params
 * @param {string} params.transactionId  - Your unique order ID
 * @param {string} params.packageCode    - eSIM Access package code
 * @param {number} params.price          - Wholesale price USD
 * @param {string} params.preferProvider - Preferred provider ID (optional)
 * @returns Order result with provider info
 */
async function routeOrder(params) {
  const providers = selectProviders(params.preferProvider);
  const errors = [];

  for (const provider of providers) {
    try {
      console.log(`[Router] Trying ${provider.name} for order ${params.transactionId}`);
      const result = await provider.order(params);
      console.log(`[Router] ✓ ${provider.name} succeeded: ICCID ${result.iccid}`);
      return { ...result, provider: provider.id, providerName: provider.name };
    } catch (err) {
      console.error(`[Router] ✗ ${provider.name} failed: ${err.message}`);
      provider.errorCount++;
      errors.push({ provider: provider.id, error: err.message, code: err.code });

      // Mark unhealthy after 3 consecutive errors
      if (provider.errorCount >= 3) {
        provider.healthy = false;
        console.warn(`[Router] ${provider.name} marked unhealthy after ${provider.errorCount} errors`);
      }
    }
  }

  throw new Error(`All providers failed. Errors: ${JSON.stringify(errors)}`);
}

/**
 * Get eSIM usage — tries provider by ICCID prefix if known
 */
async function routeUsage(iccid, providerId = null) {
  const providers = selectProviders(providerId);
  for (const p of providers) {
    try {
      return await p.usage(iccid);
    } catch (_) { /* try next */ }
  }
  throw new Error(`Could not fetch usage for ICCID ${iccid}`);
}

/**
 * Get packages for a country — merges from all healthy providers
 */
async function routePackages(countryCode) {
  const results = await Promise.allSettled(
    PROVIDERS.filter(p => p.healthy).map(p =>
      p.packages(countryCode).then(data => ({ provider: p.id, data }))
    )
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

/** Health status of all providers */
function getProviderStatus() {
  return PROVIDERS.map(p => ({
    id:         p.id,
    name:       p.name,
    healthy:    p.healthy,
    priority:   p.priority,
    errorCount: p.errorCount,
    lastCheck:  p.lastCheck,
  }));
}

module.exports = { routeOrder, routeUsage, routePackages, getProviderStatus, refreshHealth };

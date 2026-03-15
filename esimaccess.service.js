/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  eSIM Access API Service — PrimeSIM Mobile                      ║
 * ║  app.primesimobile.com                                          ║
 * ║  Provider: eSIM Access (Qualcomm-backed, GSMA SM-DP+ certified) ║
 * ║  Docs: https://docs.esimaccess.com                              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const BASE_URL = process.env.ESIMACCESS_BASE_URL || 'https://api.esimaccess.com/api/v1';
const API_KEY  = process.env.ESIMACCESS_API_KEY;

// ─── Custom Error ────────────────────────────────────────────────────
class ESIMAccessError extends Error {
  constructor(message, code, raw) {
    super(message);
    this.name = 'ESIMAccessError';
    this.code = code;
    this.raw  = raw;
  }
}

// ─── Retry with exponential backoff ─────────────────────────────────
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 500));
    }
  }
}

// ─── Base request ─────────────────────────────────────────────────
async function req(endpoint, method = 'GET', body = null) {
  if (!API_KEY) throw new ESIMAccessError('ESIMACCESS_API_KEY is not configured', 'CONFIG_ERROR');

  const res = await fetchWithRetry(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'RT-AccessCode': API_KEY,
      'User-Agent': 'PrimeSIM/3.0 app.primesimobile.com',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json();

  if (!res.ok || data.result === false) {
    throw new ESIMAccessError(
      data.errorMessage || data.msg || `HTTP ${res.status}`,
      data.errorCode || res.status,
      data
    );
  }
  return data;
}

// ════════════════════════════════════════════════════════════════════
// PACKAGES
// ════════════════════════════════════════════════════════════════════

/** List all available plans — optionally filtered by country ISO code */
async function listPackages(locationCode = null) {
  const qs = locationCode ? `?locationCode=${locationCode.toUpperCase()}` : '';
  return req(`/open/package/list${qs}`);
}

/** Get real-time price & availability for a specific package */
async function getPackageInfo(packageCode) {
  return req(`/open/package/info?packageCode=${encodeURIComponent(packageCode)}`);
}

// ════════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════════

/**
 * Create eSIM order → returns ICCID + LPA code for installation
 * @param {{ transactionId, packageCode, count?, price }} params
 * @returns {{ orderId, iccid, lpaCode, qrCodeUrl, smdpAddress, matchingId }}
 */
async function createOrder({ transactionId, packageCode, count = 1, price }) {
  if (!transactionId || !packageCode || !price)
    throw new ESIMAccessError('transactionId, packageCode, price are required', 'VALIDATION');

  const data = await req('/open/package/order', 'POST', {
    transactionId,
    packageInfoList: [{ packageCode, count, price }],
  });

  const profile = Array.isArray(data.obj) ? data.obj[0] : data.obj;

  return {
    orderId:     transactionId,
    iccid:       profile.iccid,
    lpaCode:     profile.lpaCode || profile.ac,
    qrCodeUrl:   profile.qrCodeUrl || null,
    smdpAddress: profile.smdpAddress || 'smdp.esimaccess.com',
    matchingId:  profile.matchingId || profile.ac?.split('$')[2],
    raw:         profile,
  };
}

/** Get order status by your transaction ID */
async function getOrderStatus(transactionId) {
  return req(`/open/package/order/info?transactionId=${transactionId}`);
}

// ════════════════════════════════════════════════════════════════════
// PROFILE MANAGEMENT
// ════════════════════════════════════════════════════════════════════

/** Query live data usage & profile status */
async function getProfileUsage(iccid) {
  const data = await req(`/open/esim/query?iccid=${iccid}`);
  const o = data.obj || {};
  return {
    iccid,
    status:          o.esimStatus,        // ACTIVE | INACTIVE | EXPIRED
    totalMB:         o.totalVolume,
    usedMB:          o.usedVolume,
    remainingMB:     o.remainingVolume,
    remainingPct:    o.totalVolume ? Math.round((o.remainingVolume / o.totalVolume) * 100) : 0,
    expiresAt:       o.expireTime,
    activatedAt:     o.activateTime,
    raw:             o,
  };
}

/** Top-up an existing eSIM with more data */
async function topUp({ iccid, packageCode, transactionId, price }) {
  return req('/open/package/topup', 'POST', { iccid, packageCode, transactionId, price });
}

/** Revoke unused eSIM (refund credits to account) */
async function revokeProfile(iccid, transactionId) {
  return req('/open/package/revoke', 'POST', { iccid, transactionId });
}

// ════════════════════════════════════════════════════════════════════
// ACCOUNT
// ════════════════════════════════════════════════════════════════════

async function getBalance() {
  const data = await req('/open/account/balance');
  return { balance: data.obj?.balance, currency: data.obj?.currency || 'USD' };
}

async function healthCheck() {
  try {
    const b = await getBalance();
    return { healthy: true, provider: 'eSIM Access', balance: b.balance, ts: new Date().toISOString() };
  } catch (err) {
    return { healthy: false, error: err.message, ts: new Date().toISOString() };
  }
}

// ════════════════════════════════════════════════════════════════════
// WEBHOOK PARSER (incoming from eSIM Access)
// ════════════════════════════════════════════════════════════════════

const EVENT_MAP = {
  ESIM_ACTIVATED:  'profile.activated',
  ESIM_TOPUP:      'profile.topped_up',
  ESIM_DELETED:    'profile.deleted',
  DATA_LOW:        'usage.low_data',
  DATA_EXHAUSTED:  'usage.exhausted',
  PACKAGE_EXPIRED: 'package.expired',
};

function parseWebhook(payload) {
  return {
    event:     EVENT_MAP[payload.notifyType] || payload.notifyType,
    iccid:     payload.iccid,
    orderId:   payload.transactionId,
    timestamp: payload.time || Date.now(),
    raw:       payload,
  };
}

module.exports = {
  listPackages, getPackageInfo,
  createOrder, getOrderStatus,
  getProfileUsage, topUp, revokeProfile,
  getBalance, healthCheck, parseWebhook,
  ESIMAccessError,
};

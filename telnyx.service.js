/**
 * Telnyx eSIM API Service — Secondary Provider
 * PrimeSIM Mobile — app.primesimobile.com
 * Coverage: 180+ countries, 650+ networks
 */

const BASE = 'https://api.telnyx.com/v2';
const KEY  = process.env.TELNYX_API_KEY;

class TelnyxError extends Error {
  constructor(message, code, raw) {
    super(message); this.name = 'TelnyxError'; this.code = code; this.raw = raw;
  }
}

async function req(endpoint, method = 'GET', body = null) {
  if (!KEY) throw new TelnyxError('TELNYX_API_KEY not set', 'CONFIG');
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new TelnyxError(data.errors?.[0]?.detail || `HTTP ${res.status}`, res.status, data);
  return data;
}

async function listBundles(countryCode = null) {
  const qs = countryCode ? `?filter[country_code]=${countryCode}` : '';
  return req(`/esim_bundles${qs}`);
}

async function purchaseBundle({ bundleId, msisdn, transactionId }) {
  const data = await req('/esim_purchases', 'POST', {
    bundle_id: bundleId,
    msisdn,
    reference_id: transactionId,
  });
  const d = data.data || {};
  return {
    iccid:    d.iccid,
    lpaCode:  d.lpa,
    qrUrl:    d.qr_code_url,
    status:   d.status,
    raw:      d,
  };
}

async function getPurchaseStatus(purchaseId) {
  return req(`/esim_purchases/${purchaseId}`);
}

async function getUsage(iccid) {
  const data = await req(`/esim_purchases?filter[iccid]=${iccid}`);
  const d = data.data?.[0] || {};
  return {
    iccid,
    status:       d.status,
    remainingMB:  d.remaining_data_mb,
    totalMB:      d.total_data_mb,
    usedMB:       d.used_data_mb,
  };
}

async function healthCheck() {
  try {
    await req('/esim_bundles?page[size]=1');
    return { healthy: true, provider: 'Telnyx', ts: new Date().toISOString() };
  } catch (e) {
    return { healthy: false, error: e.message, ts: new Date().toISOString() };
  }
}

module.exports = { listBundles, purchaseBundle, getPurchaseStatus, getUsage, healthCheck, TelnyxError };

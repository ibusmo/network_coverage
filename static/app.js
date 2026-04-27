/* global Chart */

if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#9aa3b5';
  Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.08)';
  Chart.defaults.font.family =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 16;
}

const charts = { c24: null, c5: null, c6: null };
let pollTimer = null;

/** Auto repeat scan: countdown between runs (seconds). Change here to adjust interval. */
const DEFAULT_AUTO_SCAN_GAP_SEC = 10;
let autoScanCountdownTimer = null;
let autoScanSecondsLeft = 0;
let scanElapsedTimer = null;
let scanElapsedSec = 0;

/** Last summary for resize redraw */
let lastSummary = null;
let historyItems = [];
let lastDisplayedLink = null;
let demoMode = false;

/** Networks table sort */
let tableSortCol = 'channel';
let tableSortDir = 1;

/** Matches ``static/style.css`` ``:root`` for spectrum canvases. */
const SPECTRUM_THEME = {
  pageBg: '#0f1117',
  plotBg: '#0f1117',
  grid: 'rgba(226, 230, 240, 0.085)',
  axisLabel: 'rgba(226, 230, 240, 0.9)',
  axisMuted: 'rgba(122, 128, 153, 0.92)',
  emptySub: 'rgba(122, 128, 153, 0.5)',
  jamStroke: 'rgba(247, 201, 72, 0.88)',
  jamText: 'rgba(247, 201, 72, 0.8)',
  crosshairBg: 'rgba(26, 29, 39, 0.96)',
  crosshairBorder: '#2a2d3a',
};

const SPECTRUM_COLORS = [
  '#5cff7a',
  '#e8e020',
  '#ff9f43',
  '#ff6b9d',
  '#e040fb',
  '#4fc3f7',
  '#ff5252',
  '#69f0ae',
  '#ffd740',
  '#b388ff',
];

function colorForAp(ap, idx) {
  // Key off identity (bssid preferred, ssid otherwise) so the SAME AP gets the
  // SAME color everywhere — spectrum peak labels, bar-strip row/cards, tooltip.
  // ``idx`` is only used as a last-resort fallback when all stable fields are
  // missing; channel/rssi/width fallback keeps hidden rows consistent cross-views.
  const stable = (ap.bssid && String(ap.bssid).trim())
    || (ap.ssid && String(ap.ssid).trim())
    || `${ap.channel ?? 'ch?'}|${ap.rssi ?? 'r?'}|${ap.width_mhz ?? 'w?'}`
    || `__idx:${idx}`;
  let h = 0;
  for (let i = 0; i < stable.length; i += 1) h = (h * 31 + stable.charCodeAt(i)) | 0;
  return SPECTRUM_COLORS[Math.abs(h) % SPECTRUM_COLORS.length];
}

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Center MHz at integer channels 1..14 for Hermite interpolation along the 2.4 GHz axis. */
const FREQ24_INTEGER_MHZ = (() => {
  const a = [];
  for (let ch = 1; ch <= 13; ch += 1) a.push(2412 + 5 * (ch - 1));
  a.push(2484);
  return a;
})();

/** ~20 MHz primary lobe width in “channel” units — wider ⇒ more overlap (bandwidth jam). */
function sigmaFromWidthMhz(w) {
  if (w == null || w <= 20) return 2.9;
  if (w <= 40) return 3.75;
  if (w <= 80) return 5.2;
  return 6.8;
}

/** dBm at fractional channel x for one AP (Gaussian in linear power). ``sigmaMult`` widens lobes on 5 GHz (channel steps are wider in MHz). */
function dbmAtChannel(ap, x, sigmaMult = 1) {
  const rssi = ap.rssi;
  if (rssi == null || !Number.isFinite(rssi)) return -100;
  const ch = Number(ap.channel);
  if (!Number.isFinite(ch)) return -100;
  const sigma = sigmaFromWidthMhz(ap.width_mhz) * sigmaMult;
  const d = x - ch;
  const ratio = Math.exp(-0.5 * (d / sigma) ** 2);
  const p0 = 10 ** (rssi / 10);
  const p = p0 * Math.max(ratio, 1e-18);
  return 10 * Math.log10(p);
}

/**
 * Center frequency (MHz) along the 2.4 GHz plot’s horizontal axis (fractional channel index).
 * Uniform 5 MHz/channel so MHz-based parabolic lobes are symmetric in channel-space. The only
 * casualty is channel 14 (real 2484 MHz, here treated as 2477 MHz = ch13 + 5); ch 14 is
 * Japan-only and almost never present, and the chart labels stay correct as channel indices.
 */
function freqMHzAlong24(xFrac) {
  const c = Number(xFrac);
  if (!Number.isFinite(c)) return null;
  return 2412 + 5 * (c - 1);
}

/** Cubic Hermite on t ∈ [0,1] with endpoint values p0,p1 and tangents m0,m1 (w.r.t. t). */
function cubicHermite01(t, p0, p1, m0, m1) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

/**
 * Pure inverted parabola vs **Δf in MHz**: ``dbm = peak − span · u²`` with ``u = |Δf| / half``
 * and ``span = peak − floor``. At ``u = 1`` the value lands exactly on the −100 dBm floor, so no
 * Hermite blend is needed — combined with the linear channel axis this draws as a true parabola.
 */
function dbmLobeSmoothMhz(peakDbm, dMhz, bwMhz) {
  const floor = -100;
  const w = Math.max(8, Number(bwMhz) || 20);
  const half = Math.max(4, w / 2);
  const ad = Math.abs(Number(dMhz));
  if (ad >= half) {
    return floor;
  }
  const span = peakDbm - floor;
  if (!(span > 0)) {
    return floor;
  }
  const u = ad / half;
  return peakDbm - span * u * u;
}

/**
 * Very rough distance (meters) from RSSI — assumes ~20 dBm AP, indoor n=3 path loss, 2.4/5 GHz in ``freqMHz``.
 * For comparison only; real range depends on walls, antenna, and TX power.
 */
function estimateDistanceMetersFromRssi(rssiInput, freqMHz) {
  const rssi = Number(rssiInput);
  if (!Number.isFinite(rssi)) return null;
  const f = Math.max(200, Number(freqMHz) || 2437);
  const txDbm = 20;
  const n = 3;
  const pl0 = 20 * Math.log10(f) - 27.55;
  const d = Math.pow(10, (txDbm - rssi - pl0) / (10 * n));
  const clamped = Math.max(0.5, Math.min(450, d));
  return Math.round(clamped * 10) / 10;
}

function dbmAtChannelMhz24(ap, xFrac) {
  const rssi = ap.rssi;
  if (rssi == null || !Number.isFinite(rssi)) return -100;
  const chAp = Number(ap.channel);
  if (!Number.isFinite(chAp)) return -100;
  const fAp = centerFreqMHz24(chAp);
  const fX = freqMHzAlong24(xFrac);
  if (fAp == null || fX == null) return -100;
  const wMhz = ap.width_mhz != null && Number.isFinite(Number(ap.width_mhz)) ? Number(ap.width_mhz) : 20;
  const dMhz = fX - fAp;
  return dbmLobeSmoothMhz(rssi, dMhz, wMhz);
}

function dbmAtChannelMhz5(ap, xFrac) {
  const rssi = ap.rssi;
  if (rssi == null || !Number.isFinite(rssi)) return -100;
  const chAp = Number(ap.channel);
  if (!Number.isFinite(chAp) || chAp < 36) return -100;
  const fAp = centerFreqMHz5(chAp);
  const x = Number(xFrac);
  if (!Number.isFinite(x)) return -100;
  const fX = 5000 + 5 * x;
  if (fAp == null) return -100;
  const wMhz = ap.width_mhz != null && Number.isFinite(Number(ap.width_mhz)) ? Number(ap.width_mhz) : 20;
  const dMhz = fX - fAp;
  return dbmLobeSmoothMhz(rssi, dMhz, wMhz);
}

function dbmAtXForSpectrum(ap, x, sigmaMult, bandOpts) {
  if (bandOpts.lobeMode === 'mhz24') return dbmAtChannelMhz24(ap, x);
  if (bandOpts.lobeMode === 'mhz5') return dbmAtChannelMhz5(ap, x);
  return dbmAtChannel(ap, x, sigmaMult);
}

/** Inverse of ``freqMHzAlong24`` (monotone increasing). */
function inverseFreqMHzAlong24(targetMhz) {
  const y = Number(targetMhz);
  if (!Number.isFinite(y)) return null;
  let lo = 0.25;
  let hi = 14.75;
  for (let iter = 0; iter < 72; iter += 1) {
    const mid = (lo + hi) * 0.5;
    const fv = freqMHzAlong24(mid);
    if (fv == null) return mid;
    if (fv < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Lobe samples **uniform in MHz** (not in channel index) so symmetric Δf maps to a symmetric curve
 * on the chart; uniform channel stepping warped wide lobes (e.g. 40 MHz near ch 11–14).
 */
function mhzUniformLobeSamples(ap, bandOpts, xLo, xHi, padMhz) {
  const rssi = ap.rssi;
  if (rssi == null || !Number.isFinite(rssi)) return null;
  const wMhz = ap.width_mhz != null && Number.isFinite(Number(ap.width_mhz)) ? Number(ap.width_mhz) : 20;
  const half = Math.max(4, wMhz / 2);
  const pad = Math.max(2, Number(padMhz) || 4);
  const pts = [];
  const n = 520;

  if (bandOpts.lobeMode === 'mhz24') {
    const chAp = Number(ap.channel);
    const fAp = centerFreqMHz24(chAp);
    if (fAp == null || !Number.isFinite(chAp)) return null;
    const f0 = fAp - half - pad;
    const f1 = fAp + half + pad;
    for (let i = 0; i <= n; i += 1) {
      const fX = f0 + (i / n) * (f1 - f0);
      const x = inverseFreqMHzAlong24(fX);
      if (x == null || !Number.isFinite(x)) continue;
      if (x < xLo || x > xHi) continue;
      const dMhz = fX - fAp;
      pts.push({ x, dbm: dbmLobeSmoothMhz(rssi, dMhz, wMhz) });
    }
  } else if (bandOpts.lobeMode === 'mhz5') {
    const chAp = Number(ap.channel);
    if (!Number.isFinite(chAp) || chAp < 36) return null;
    const fAp = centerFreqMHz5(chAp);
    if (fAp == null) return null;
    const f0 = fAp - half - pad;
    const f1 = fAp + half + pad;
    for (let i = 0; i <= n; i += 1) {
      const fX = f0 + (i / n) * (f1 - f0);
      const x = (fX - 5000) / 5;
      if (x < xLo || x > xHi) continue;
      const dMhz = fX - fAp;
      pts.push({ x, dbm: dbmLobeSmoothMhz(rssi, dMhz, wMhz) });
    }
  } else {
    return null;
  }

  pts.sort((a, b) => a.x - b.x);
  const out = [];
  for (const p of pts) {
    if (!out.length || p.x > out[out.length - 1].x + 1e-6) out.push(p);
  }
  return out.length ? out : null;
}

/** Interior samples only; caller closes the fill with vertical sides at xLo / xHi. */
function buildMhzAccurateLobePolyline(ap, bandOpts, xLo, xHi, clipDbm) {
  const interior = mhzUniformLobeSamples(ap, bandOpts, xLo, xHi, 4);
  if (!interior || interior.length < 2) return null;
  const out = [];
  for (const p of interior) {
    const c = clipDbm(p.dbm);
    if (!out.length || Math.abs(p.x - out[out.length - 1].x) > 1e-5) {
      out.push({ x: p.x, dbm: c });
    } else {
      out[out.length - 1] = { x: p.x, dbm: c };
    }
  }
  return out.length >= 2 ? out : null;
}

const spectrumHitRegions = {};

/** Wheel zoom + drag pan + dbl‑click reset for spectrum canvases (view is channel range). */
const spectrumPanZoom = {};

/** @type {{ regionId: string, startClientX: number, initV0: number, initV1: number, plotW: number, full0: number, full1: number } | null} */
let spectrumDrag = null;

let spectrumCrosshairRaf = null;
/** @type {{ canvasId: string, regionId: string, xCss: number } | null} */
let spectrumCrosshairPending = null;

/** 802.11 2.4 GHz center frequency (MHz) for channels 1–13; ch 14 = 2484. */
function centerFreqMHz24(ch) {
  const c = Number(ch);
  if (!Number.isFinite(c)) return null;
  if (c >= 1 && c <= 13) return 2412 + 5 * (c - 1);
  if (c === 14) return 2484;
  return null;
}

/** 5 GHz center frequency (MHz) — matches common ``5000 + 5×channel`` numbering (e.g. 36→5180). */
function centerFreqMHz5(ch) {
  const c = Number(ch);
  if (!Number.isFinite(c) || c < 36) return null;
  return 5000 + 5 * c;
}

/**
 * Center frequency (MHz) for RSSI→distance; uses ``band_key`` when set, else infers from channel.
 */
function centerFreqMHzForAp(ap) {
  const ch = Number(ap.channel);
  const bk = String(ap.band_key || '');
  if (!Number.isFinite(ch)) return null;
  if (bk === '6') return 5955 + 5 * (ch - 1);
  if (bk === '5') return centerFreqMHz5(ch);
  if (bk === '2.4') return centerFreqMHz24(ch);
  if (ch >= 36) return centerFreqMHz5(ch);
  if (ch >= 1 && ch <= 14) return centerFreqMHz24(ch);
  return null;
}

function centerFreqMHzForLink(channel, bandKey, bandLabel) {
  const ch = Number(channel);
  if (!Number.isFinite(ch)) return null;
  const bk = String(bandKey || '').trim();
  const bl = String(bandLabel || '').toLowerCase();
  if (bk === '6' || bl.includes('6')) return 5955 + 5 * (ch - 1);
  if (bk === '5' || bl.includes('5')) return centerFreqMHz5(ch);
  if (bk === '2.4' || bl.includes('2.4') || (ch >= 1 && ch <= 14)) return centerFreqMHz24(ch);
  if (ch >= 36) return centerFreqMHz5(ch);
  return centerFreqMHz24(ch);
}

function maskedBssidText(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return '';
  const p = t.split(':');
  if (p.length !== 6) return 'xx:xx:xx:xx:xx:xx';
  return `${p[0]}:${p[1]}:${p[2]}:xx:xx:xx`;
}

function displaySsidText(raw) {
  const t = String(raw || '').trim();
  if (!demoMode) return t;
  if (!t || t === '(hidden)' || t === '(hidden SSID — see BSSID)') return '(hidden)';
  if (t === 'Connected') return 'Live <redacted>';
  return '<redacted>';
}

function displayBssidText(raw) {
  const t = String(raw || '').trim();
  if (!demoMode) return t;
  return maskedBssidText(t);
}

function displayScanTimeText(raw) {
  const t = String(raw || '').trim();
  if (!demoMode) return t;
  return t ? 'demo capture' : '—';
}

function displaySourceText(raw) {
  const t = String(raw || '').trim();
  if (!demoMode) return t;
  return t ? 'local survey' : '—';
}

function updateDemoModeUi() {
  const btn = document.getElementById('btnDemoMode');
  if (btn) {
    btn.textContent = demoMode ? 'Demo on' : 'Demo mode';
    btn.classList.toggle('btn-primary', demoMode);
    btn.classList.toggle('btn-secondary', !demoMode);
  }
}

function toggleDemoMode() {
  demoMode = !demoMode;
  updateDemoModeUi();
  if (lastSummary) {
    applySummary(lastSummary);
  }
}

function resolveLinkForDisplay(linkIn, nets, prevLink) {
  const link = { ...(linkIn || {}) };
  let usedHistory = false;
  let ssidFromHistory = Boolean(link.ssid_from_history);
  let bssidFromHistory = Boolean(link.bssid_from_history);
  const rows = Array.isArray(nets) ? nets : [];
  const bs = (link.bssid || '').toLowerCase();
  let row = null;
  if (bs) {
    row = rows.find(r => String(r.bssid || '').toLowerCase() === bs) || null;
  }
  if (!row && rows.length) {
    row = [...rows].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))[0];
  }
  if (row) {
    if (!link.ssid && row.ssid) link.ssid = row.ssid;
    if (!link.bssid && row.bssid) link.bssid = row.bssid;
    if (link.rssi == null && row.rssi != null) link.rssi = row.rssi;
    if (link.channel == null && row.channel != null) link.channel = row.channel;
    if (!link.band && row.band) link.band = row.band;
    if (!link.band_key && row.band_key) link.band_key = row.band_key;
  }
  if (prevLink) {
    const need =
      !link.ssid || link.rssi == null || link.channel == null || !link.band || !link.bssid;
    if (need) {
      usedHistory = true;
      if (!link.ssid && prevLink.ssid) {
        link.ssid = prevLink.ssid;
        ssidFromHistory = true;
      }
      if (!link.bssid && prevLink.bssid) {
        link.bssid = prevLink.bssid;
        bssidFromHistory = true;
      }
      if (link.rssi == null && prevLink.rssi != null) link.rssi = prevLink.rssi;
      if (link.channel == null && prevLink.channel != null) link.channel = prevLink.channel;
      if (!link.band && prevLink.band) link.band = prevLink.band;
      if (!link.band_key && prevLink.band_key) link.band_key = prevLink.band_key;
    }
  }
  return { link, usedHistory, ssidFromHistory, bssidFromHistory };
}

/** SSID line — same rules as spectrum peak label (hidden nets show BSSID snippet). */
function formatApSsidLine(ap, maxLen = 28) {
  if (demoMode) return '<redacted>';
  const ssidRaw =
    ap.ssid && String(ap.ssid).trim()
      ? String(ap.ssid).trim()
      : `(hidden) ${ap.bssid ? ap.bssid.slice(0, 14) : '—'}`;
  return truncateSsidLabel(ssidRaw, maxLen);
}

/** Spectrum peak line 2: center MHz and width (no channel prefix). */
function formatApTechLine(ap, mhz) {
  const wNum =
    ap.width_mhz != null && Number.isFinite(Number(ap.width_mhz))
      ? Number(ap.width_mhz)
      : null;
  const mhzTxt = mhz != null && Number.isFinite(Number(mhz)) ? `${mhz} MHz` : null;
  const bwTxt = wNum != null ? `${wNum} MHz` : null;
  const parts = [mhzTxt, bwTxt].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Spectrum peak line 3: ``~m · dBm``. Returns ``null`` if distance cannot be estimated (chart omits line).
 * Optional ``rssiFallback`` when ``ap.rssi`` is missing (canvas uses clipped peak).
 */
function formatApDistRssiLine(ap, mhz, rssiFallback) {
  const distM = estimateDistanceMetersFromRssi(ap.rssi, mhz);
  if (distM == null) return null;
  let rVal = Number(ap.rssi);
  if (!Number.isFinite(rVal) && rssiFallback != null && Number.isFinite(Number(rssiFallback))) {
    rVal = Number(rssiFallback);
  }
  const rStr = Number.isFinite(rVal) ? `${rVal.toFixed(0)} dBm` : '—';
  return `~${distM} m · ${rStr}`;
}

function formatApCenterMHzLine(mhz) {
  return mhz != null && Number.isFinite(Number(mhz)) ? `${Number(mhz)} MHz` : '—';
}

function formatApWidthMHzLine(ap) {
  const w = ap.width_mhz;
  return w != null && Number.isFinite(Number(w)) ? `${Number(w)} MHz` : '—';
}

/** Typical 20 MHz primary channels for vertical grid lines. */
function fiveGGridPrimaries(chLo, chHi) {
  const lo = Math.ceil(chLo);
  const hi = Math.floor(chHi);
  const prim = [];
  let c;
  for (c = 36; c <= 64; c += 4) prim.push(c);
  for (c = 100; c <= 144; c += 4) prim.push(c);
  for (c = 149; c <= 177; c += 4) prim.push(c);
  let out = prim.filter(x => x >= lo && x <= hi);
  if (!out.length) {
    for (c = lo; c <= hi; c += 4) out.push(c);
  }
  return out;
}

let spectrumResizeBound = false;

function ensureSpectrumResizeObserver() {
  if (spectrumResizeBound) return;
  if (typeof ResizeObserver === 'undefined') return;
  spectrumResizeBound = true;
  const ro = new ResizeObserver(() => {
    if (lastSummary) {
      drawSpectrum24(lastSummary);
      drawSpectrum5(lastSummary);
      renderBandBarStrips(lastSummary);
    }
  });
  document.querySelectorAll('.spectrum-wrap').forEach(el => ro.observe(el));
}

/** Stronger RSSI wins; if the winner has no SSID, take it from the other row (same BSSID). */
function pickMergedApRow(a, b) {
  const ra = a.rssi ?? -999;
  const rb = b.rssi ?? -999;
  const win = rb > ra ? b : a;
  const lose = rb > ra ? a : b;
  const out = { ...win };
  const sw = out.ssid && String(out.ssid).trim();
  const sl = lose.ssid && String(lose.ssid).trim();
  if (!sw && sl) out.ssid = lose.ssid;
  return out;
}

/** One row per BSSID so the first list entry cannot hide another row’s SSID. */
function dedupeNetworksByBssidForSpectrum(nets) {
  const extras = [];
  const byBid = new Map();
  for (const n of nets) {
    const bidRaw = n.bssid && String(n.bssid).trim();
    if (!bidRaw) {
      extras.push(n);
      continue;
    }
    const k = bidRaw.toLowerCase();
    if (!byBid.has(k)) {
      byBid.set(k, { ...n });
      continue;
    }
    byBid.set(k, pickMergedApRow(byBid.get(k), n));
  }
  return [...byBid.values(), ...extras];
}

/**
 * @param {object} bandOpts
 * @param {(n: object) => boolean} bandOpts.filterNet
 * @param {{ min: number, max: number } | 'auto'} bandOpts.chRange
 * @param {number} [bandOpts.autoPad]
 * @param {[number, number]} [bandOpts.autoClamp]
 * @param {number} bandOpts.sigmaMult
 * @param {(ch: number) => number|null} bandOpts.freqMHzFn
 * @param {'every-int'|'five-primaries'} bandOpts.gridMode
 * @param {string} [bandOpts.xAxisTitle] — bottom-center label (default “Wi‑Fi channels”)
 * @param {'solid'|'dotted'} [bandOpts.horizontalGridStyle]
 * @param {string} [bandOpts.emptyDetail]
 * @param {string} [bandOpts.cardId] — hide card when empty
 */
function drawSpectrumBand(summary, canvasId, bandOpts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  ensureSpectrumResizeObserver();

  const card = bandOpts.cardId ? document.getElementById(bandOpts.cardId) : null;
  const allNets = summary.networks || [];
  const nets = dedupeNetworksByBssidForSpectrum(allNets.filter(bandOpts.filterNet));

  const seen = new Set();
  const aps = [];
  nets.forEach((n, i) => {
    const bid = n.bssid && String(n.bssid).trim();
    const id = bid
      ? bid.toLowerCase()
      : `idx:${i}:ch:${n.channel}:r:${n.rssi ?? ''}:${n.ssid ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    aps.push(n);
  });

  const strongestRssi =
    aps.length > 0
      ? Math.max(
          ...aps.map(a =>
            Number.isFinite(Number(a.rssi)) ? Number(a.rssi) : -100
          )
        )
      : -100;

  if (card && bandOpts.hideWhenEmpty) {
    if (!aps.length) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
  }

  let chMin;
  let chMax;
  if (bandOpts.chRange === 'auto') {
    const chs = aps.map(a => Number(a.channel)).filter(Number.isFinite);
    if (!chs.length) {
      if (card && bandOpts.hideWhenEmpty) card.classList.add('hidden');
      return;
    }
    const pad = bandOpts.autoPad ?? 8;
    const [clampLo, clampHi] = bandOpts.autoClamp || [32, 185];
    chMin = Math.max(clampLo, Math.min(...chs) - pad);
    chMax = Math.min(clampHi, Math.max(...chs) + pad);
    if (chMax - chMin < 18) {
      const mid = (chMin + chMax) / 2;
      chMin = Math.max(clampLo, mid - 12);
      chMax = Math.min(clampHi, mid + 12);
    }
  } else {
    chMin = bandOpts.chRange.min;
    chMax = bandOpts.chRange.max;
  }

  const hitKey = bandOpts.hitRegionId;
  if (hitKey) {
    let st = spectrumPanZoom[hitKey] || { zoomed: false };
    st.fullMin = chMin;
    st.fullMax = chMax;
    const fullW = chMax - chMin;
    const minZoomSpan = hitKey === 'spectrum24' ? 1.75 : Math.min(8, fullW * 0.15);
    if (!st.zoomed) {
      st.viewMin = chMin;
      st.viewMax = chMax;
    } else {
      st.viewMin = Math.max(chMin, st.viewMin);
      st.viewMax = Math.min(chMax, st.viewMax);
      if (st.viewMax - st.viewMin < minZoomSpan - 1e-6) {
        st.zoomed = false;
        st.viewMin = chMin;
        st.viewMax = chMax;
      }
    }
    chMin = st.viewMin;
    chMax = st.viewMax;
    spectrumPanZoom[hitKey] = st;
  }

  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  let cssW = wrap.clientWidth;
  if (!cssW || cssW < 80) {
    const container = document.querySelector('.container');
    cssW = (container && container.clientWidth) ? container.clientWidth - 40 : 1060;
  }
  if (!cssW || cssW < 80) {
    requestAnimationFrame(() => drawSpectrumBand(summary, canvasId, bandOpts));
    return;
  }
  const cssH = Math.min(480, Math.max(320, Math.round(cssW * 0.42)));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ovr = document.getElementById(`${canvasId}-crosshair`);
  if (ovr) {
    ovr.style.width = `${cssW}px`;
    ovr.style.height = `${cssH}px`;
    ovr.width = Math.round(cssW * dpr);
    ovr.height = Math.round(cssH * dpr);
    const octx = ovr.getContext('2d');
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, cssW, cssH);
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 70;
  const padR = 20;
  const padT = 44;
  const padB = 56;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const dbMin = -100;
  /** Top grid label (dBm); plot top moves up when APs are strong so curves aren’t flattened. */
  const dbMaxTick = -30;
  const dbPlotDefault = dbMaxTick + 8;
  const labelHeadroomDb = bandOpts.showPeakLabels ? 12 : 0;
  const dbPlotMax = Math.min(
    -10,
    Math.max(dbPlotDefault, strongestRssi + 10 + labelHeadroomDb)
  );
  const sigmaMult = bandOpts.sigmaMult ?? 1;
  /** Upper dBm clip (was fixed ≈ −20 and caused a flat “table” on the jam envelope). */
  const dbmClipHi = Math.min(5, Math.max(dbPlotMax + 2, strongestRssi + 8));
  const clipDbm = v => Math.max(dbMin, Math.min(dbmClipHi, v));

  const xToPx = ch => padL + ((ch - chMin) / (chMax - chMin)) * plotW;
  const yToPx = db => padT + ((db - dbPlotMax) / (dbMin - dbPlotMax)) * plotH;

  ctx.fillStyle = SPECTRUM_THEME.plotBg;
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.strokeStyle = SPECTRUM_THEME.grid;
  ctx.lineWidth = 1;
  ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = SPECTRUM_THEME.axisLabel;

  const hGridDash = bandOpts.horizontalGridStyle === 'dotted' ? [2, 6] : null;
  for (let db = dbMaxTick; db >= dbMin; db -= 10) {
    const y = yToPx(db);
    ctx.beginPath();
    if (hGridDash) ctx.setLineDash(hGridDash);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    if (hGridDash) ctx.setLineDash([]);
    ctx.textAlign = 'right';
    ctx.fillText(String(db), padL - 14, y + 5);
  }

  ctx.save();
  ctx.translate(20, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = SPECTRUM_THEME.axisMuted;
  ctx.font = '17px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('Signal strength [dBm]', 0, 0);
  ctx.restore();

  let gridChs;
  if (bandOpts.gridMode === 'every-int') {
    gridChs = [];
    for (let ch = Math.ceil(chMin); ch <= Math.floor(chMax); ch += 1) gridChs.push(ch);
  } else {
    gridChs = fiveGGridPrimaries(chMin, chMax);
  }
  const labelEvery = gridChs.length > 22 ? 2 : 1;
  gridChs.forEach((ch, gi) => {
    const x = xToPx(ch);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    if (gi % labelEvery === 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = SPECTRUM_THEME.axisLabel;
      ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(String(ch), x, padT + plotH + 28);
    }
  });

  ctx.save();
  ctx.fillStyle = SPECTRUM_THEME.axisMuted;
  ctx.font = '17px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  const xAxisTitle =
    bandOpts.xAxisTitle !== undefined && bandOpts.xAxisTitle !== null
      ? bandOpts.xAxisTitle
      : 'Wi‑Fi channels';
  ctx.fillText(xAxisTitle, padL + plotW / 2, cssH - 10);
  ctx.restore();

  aps.sort((a, b) => (a.rssi ?? -999) - (b.rssi ?? -999));

  const linkBssid = ((summary.link || {}).bssid || '').toLowerCase();
  const span = chMax - chMin;
  const edge = Math.min(0.55, span * 0.04);
  const xLo = chMin - edge;
  const xHi = chMax + edge;
  const step = Math.max(0.028, span / 960);

  const dbmAp = (ap, x) => clipDbm(dbmAtXForSpectrum(ap, x, sigmaMult, bandOpts));

  const useMhzAccurateLobe =
    bandOpts.lobeMode === 'mhz24' || bandOpts.lobeMode === 'mhz5';

  aps.forEach((ap, idx) => {
    const col = colorForAp(ap, idx);
    ctx.beginPath();
    const poly =
      useMhzAccurateLobe &&
      buildMhzAccurateLobePolyline(ap, bandOpts, xLo, xHi, clipDbm);
    if (poly) {
      const yL = clipDbm(dbmAtXForSpectrum(ap, xLo, sigmaMult, bandOpts));
      const yR = clipDbm(dbmAtXForSpectrum(ap, xHi, sigmaMult, bandOpts));
      ctx.moveTo(xToPx(xLo), yToPx(dbMin));
      ctx.lineTo(xToPx(xLo), yToPx(yL));
      for (let k = 0; k < poly.length; k += 1) {
        ctx.lineTo(xToPx(poly[k].x), yToPx(poly[k].dbm));
      }
      ctx.lineTo(xToPx(xHi), yToPx(yR));
      ctx.lineTo(xToPx(xHi), yToPx(dbMin));
      ctx.closePath();
    } else {
      let topStarted = false;
      for (let x = xLo; x <= xHi; x += step) {
        const dbm = dbmAp(ap, x);
        const px = xToPx(x);
        const py = yToPx(dbm);
        if (!topStarted) {
          ctx.moveTo(px, py);
          topStarted = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.lineTo(xToPx(xHi), yToPx(dbMin));
      ctx.lineTo(xToPx(xLo), yToPx(dbMin));
      ctx.closePath();
    }
    ctx.fillStyle = hexToRgba(col, 0.42);
    ctx.fill();
  });

  aps.forEach((ap, idx) => {
    const col = colorForAp(ap, idx);
    const isLink = ap.bssid && ap.bssid.toLowerCase() === linkBssid;
    ctx.beginPath();
    const poly =
      useMhzAccurateLobe &&
      buildMhzAccurateLobePolyline(ap, bandOpts, xLo, xHi, clipDbm);
    if (poly) {
      const yL = clipDbm(dbmAtXForSpectrum(ap, xLo, sigmaMult, bandOpts));
      const yR = clipDbm(dbmAtXForSpectrum(ap, xHi, sigmaMult, bandOpts));
      ctx.moveTo(xToPx(xLo), yToPx(yL));
      for (let k = 0; k < poly.length; k += 1) {
        ctx.lineTo(xToPx(poly[k].x), yToPx(poly[k].dbm));
      }
      ctx.lineTo(xToPx(xHi), yToPx(yR));
    } else {
      let strokeStarted = false;
      for (let x = xLo; x <= xHi; x += step) {
        const dbm = dbmAp(ap, x);
        const px = xToPx(x);
        const py = yToPx(dbm);
        if (!strokeStarted) {
          ctx.moveTo(px, py);
          strokeStarted = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = isLink ? 2.5 : 1.7;
    if (isLink) {
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
    }
    const dashPat =
      idx % 3 === 0 ? [7, 4] : idx % 3 === 1 ? [4, 4] : [10, 3, 2, 3];
    ctx.setLineDash(isLink ? [] : dashPat);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
  });

  if (aps.length) {
    ctx.beginPath();
    let envStarted = false;
    for (let x = xLo; x <= xHi; x += step) {
      let maxDb = dbMin;
      for (let j = 0; j < aps.length; j += 1) {
        maxDb = Math.max(maxDb, dbmAtXForSpectrum(aps[j], x, sigmaMult, bandOpts));
      }
      maxDb = clipDbm(maxDb);
      const px = xToPx(x);
      const py = yToPx(maxDb);
      if (!envStarted) {
        ctx.moveTo(px, py);
        envStarted = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.strokeStyle = SPECTRUM_THEME.jamStroke;
    ctx.lineWidth = 2.25;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = SPECTRUM_THEME.jamText;
    ctx.textAlign = 'right';
    ctx.fillText('jam envelope (max dBm)', padL + plotW - 4, padT + 18);
  }

  if (bandOpts.showPeakLabels) {
    const freqFn = bandOpts.freqMHzFn;
    const lineStep = 19;
    const peakLift = 60;
    aps.forEach((ap, idx) => {
      const col = colorForAp(ap, idx);
      const line1 = formatApSsidLine(ap, 28);
      const lx = xToPx(Number(ap.channel));
      const peakDb = Math.min(dbPlotMax - 0.5, Math.max(ap.rssi ?? -85, dbMin + 2));
      const ly = yToPx(peakDb) - peakLift;
      ctx.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(0,0,0,0.72)';
      ctx.lineWidth = 3;
      ctx.strokeText(line1, lx, ly);
      ctx.fillText(line1, lx, ly);
      const mhz = freqFn(ap.channel);
      const tech = formatApTechLine(ap, mhz);
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, monospace';
      ctx.fillStyle = hexToRgba(col, 0.88);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeText(tech, lx, ly + lineStep);
      ctx.fillText(tech, lx, ly + lineStep);
      const dline = formatApDistRssiLine(ap, mhz, peakDb);
      if (dline != null) {
        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
        // Match AP colour (slightly dimmer than the SSID/tech lines) so all three label
        // rows read as one block, not “SSID + tech in colour, distance in random gray”.
        ctx.fillStyle = hexToRgba(col, 0.78);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 2;
        ctx.strokeText(dline, lx, ly + lineStep * 2);
        ctx.fillText(dline, lx, ly + lineStep * 2);
      }
    });
  }

  if (hitKey) {
    const st = spectrumPanZoom[hitKey];
    if (st) {
      st.padL = padL;
      st.plotW = plotW;
    }
    spectrumHitRegions[hitKey] = {
      canvasId,
      chMin,
      chMax,
      padL,
      plotW,
      padT,
      plotH,
      dbMin,
      dbPlotMax,
      dbmClipHi,
      lobeMode: bandOpts.lobeMode,
      sigmaMult,
      aps: [...aps],
    };
  }

  if (!aps.length) {
    ctx.font = '19px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = SPECTRUM_THEME.axisMuted;
    ctx.textAlign = 'center';
    const total = allNets.length;
    const msg = !total
      ? 'No survey data — click “Scan air”.'
      : (bandOpts.emptyDetail || 'No access points in this band for the last scan.');
    ctx.fillText(msg, cssW / 2, padT + plotH / 2 - 8);
    ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = SPECTRUM_THEME.emptySub;
    ctx.fillText(
      'Examples: open “Examples (Wifi Analyzer…)” above.',
      cssW / 2,
      padT + plotH / 2 + 16
    );
  }
}

function drawSpectrum24(summary) {
  drawSpectrumBand(summary, 'spectrum24', {
    filterNet(n) {
      const ch = Number(n.channel);
      return Number.isFinite(ch) && ch >= 1 && ch <= 14;
    },
    chRange: { min: 1, max: 14 },
    sigmaMult: 1,
    lobeMode: 'mhz24',
    showPeakLabels: true,
    freqMHzFn: centerFreqMHz24,
    gridMode: 'every-int',
    hitRegionId: 'spectrum24',
    xAxisTitle: 'Wifi Channels',
    horizontalGridStyle: 'dotted',
    emptyDetail:
      `No APs on channels 1–14 (${(summary.networks || []).length} network(s) may be 5 / 6 GHz only).`,
  });
}

function drawSpectrum5(summary) {
  drawSpectrumBand(summary, 'spectrum5', {
    filterNet(n) {
      // band_key is unreliable on some macOS builds (CoreWLAN returns
      // kCWChannelBandUnknown → 'other'). Trust the channel number: anything in
      // 36..177 with band_key NOT explicitly '6' is a 5 GHz AP.
      if (n.band_key === '6') return false;
      const ch = Number(n.channel);
      return Number.isFinite(ch) && ch >= 36 && ch <= 177;
    },
    chRange: 'auto',
    autoPad: 8,
    autoClamp: [32, 185],
    sigmaMult: 1.85,
    lobeMode: 'mhz5',
    showPeakLabels: true,
    freqMHzFn: centerFreqMHz5,
    gridMode: 'five-primaries',
    hideWhenEmpty: true,
    cardId: 'spectrum5Card',
    hitRegionId: 'spectrum5',
    emptyDetail: 'No 5 GHz APs in the last scan.',
  });
}

function rssiBarHeightPct(rssi) {
  const lo = -90;
  const hi = -30;
  const x = Number(rssi);
  if (!Number.isFinite(x)) return 10;
  const c = Math.max(lo, Math.min(hi, x));
  return Math.max(10, Math.round(((c - lo) / (hi - lo)) * 100));
}

function truncateSsidLabel(s, maxLen = 14) {
  const t = String(s ?? '');
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(1, maxLen - 1))}…`;
}

/** Bars grouped by channel; SSID + RSSI + width under each (like labeled Wifi Analyzer bars). */
function renderBandBarStrips(summary) {
  const linkBs = ((summary.link || {}).bssid || '').toLowerCase();

  const maxEstMetersOnChannel = (aps, ch, freqMHzFn) => {
    let m = -1;
    for (const ap of aps) {
      const f = freqMHzFn(ch);
      const d = estimateDistanceMetersFromRssi(ap.rssi, f);
      if (d != null) m = Math.max(m, d);
    }
    return m;
  };

  const renderCol = (colsId, wrapId, filterFn, emptyMsg, freqMHzFn) => {
    const cols = document.getElementById(colsId);
    const wrap = document.getElementById(wrapId);
    if (!cols || !wrap) return;
    const nets = (summary.networks || []).filter(filterFn);
    wrap.classList.remove('hidden');
    if (!nets.length) {
      cols.innerHTML = `<div class="bar-strip-empty">${emptyMsg}</div>`;
      return;
    }
    const byCh = new Map();
    nets.forEach(n => {
      const ch = Number(n.channel);
      if (!Number.isFinite(ch)) return;
      if (!byCh.has(ch)) byCh.set(ch, []);
      byCh.get(ch).push(n);
    });
    const channels = [...byCh.keys()].sort((a, b) => {
      const da = maxEstMetersOnChannel(byCh.get(a), a, freqMHzFn);
      const db = maxEstMetersOnChannel(byCh.get(b), b, freqMHzFn);
      if (da < 0 && db >= 0) return 1;
      if (db < 0 && da >= 0) return -1;
      if (da !== db) return db - da;
      return a - b;
    });
    cols.innerHTML = channels
      .map((ch, rowIdx) => {
        const aps = byCh.get(ch).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
        const best = aps[0];
        const h = rssiBarHeightPct(best.rssi);
        const here = aps.some(
          ap => ap.bssid && String(ap.bssid).toLowerCase() === linkBs
        );
        const tone = rowIdx % 4;
        // Color each row by its strongest AP so it matches the spectrum peak
        // colours above. ``colorForAp`` is stable per AP identity.
        const bestCol = colorForAp(best, rowIdx);
        const fillBg = hexToRgba(bestCol, 0.32);
        const fillBorder = hexToRgba(bestCol, 0.85);
        const blocks = aps
          .map((ap, apI) => {
            const mhz = freqMHzFn(ch);
            const dm = estimateDistanceMetersFromRssi(ap.rssi, mhz);
            const rssiTxt = Number.isFinite(Number(ap.rssi))
              ? `${Number(ap.rssi).toFixed(0)} dBm`
              : '—';
            const distTxt = dm != null ? `~${dm} m` : '—';
            const apCol = colorForAp(ap, apI);
            const apBg = hexToRgba(apCol, 0.14);
            const apBorder = hexToRgba(apCol, 0.55);
            const apStyle = `style="background:${apBg};border-color:${apBorder};"`;
            const nmStyle = `style="color:${apCol};"`;
            return `<div class="ap-block" ${apStyle}><span class="nm" ${nmStyle}>${escapeHtml(formatApSsidLine(ap, 22))}</span><span class="bar-strip-line bar-strip-freq">${escapeHtml(formatApCenterMHzLine(mhz))}</span><span class="bar-strip-line bar-strip-bw">${escapeHtml(formatApWidthMHzLine(ap))}</span><span class="bar-strip-line bar-strip-dist">${escapeHtml(distTxt)}</span><span class="bar-strip-line bar-strip-rssi">${escapeHtml(rssiTxt)}</span></div>`;
          })
          .join('');
        const mhzBest = freqMHzFn(ch);
        const bestDm = estimateDistanceMetersFromRssi(best.rssi, mhzBest);
        const bestRssi = Number.isFinite(Number(best.rssi))
          ? `${Number(best.rssi).toFixed(0)} dBm`
          : '—';
        const onBarTitle = escapeHtml(
          [
            formatApSsidLine(best, 32),
            formatApCenterMHzLine(mhzBest),
            formatApWidthMHzLine(best),
            bestDm != null ? `~${bestDm} m` : '—',
            bestRssi,
          ].join(' — ')
        );
        const onBarText = escapeHtml(truncateSsidLabel(formatApSsidLine(best, 99), 8));
        const moreN = aps.length - 1;
        const moreOnBar =
          moreN > 0
            ? `<span class="bar-strip-ssids-extra" title="${moreN} more AP(s) on Ch ${ch}">+${moreN}</span>`
            : '';
        const fillStyle = `height:${h}%;background:${fillBg};border-color:${fillBorder};`;
        const chStyle = `style="color:${bestCol};"`;
        return `<div class="bar-strip-row bar-strip-tone-${tone}${here ? ' bar-strip-row--here' : ''}">
          <div class="bar-strip-row-left">
            <div class="bar-strip-track"><div class="bar-strip-fill" style="${fillStyle}"><span class="bar-strip-ssid-onbar" title="${onBarTitle}">${onBarText}</span>${moreOnBar}</div></div>
            <div class="bar-strip-ch" ${chStyle}>Ch ${ch}</div>
          </div>
          <div class="bar-strip-row-aps">${blocks}</div>
        </div>`;
      })
      .join('');
  };

  renderCol(
    'barStrip24Cols',
    'barStrip24Wrap',
    n => {
      const c = Number(n.channel);
      return Number.isFinite(c) && c >= 1 && c <= 14;
    },
    'No 2.4 GHz APs on channels 1–14 in this scan.',
    ch => centerFreqMHz24(ch)
  );

  const has5 = (summary.networks || []).some(
    n => n.band_key === '5' && Number(n.channel) >= 36
  );
  const wrap5 = document.getElementById('barStrip5Wrap');
  if (!has5) {
    if (wrap5) wrap5.classList.add('hidden');
    return;
  }
  renderCol(
    'barStrip5Cols',
    'barStrip5Wrap',
    n => n.band_key === '5' && Number(n.channel) >= 36,
    'No 5 GHz APs.',
    ch => centerFreqMHz5(ch)
  );
}

const chartDefaults = {
  type: 'bar',
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: SPECTRUM_THEME.crosshairBg,
        titleColor: '#e2e6f0',
        bodyColor: '#9aa3b5',
        borderColor: SPECTRUM_THEME.crosshairBorder,
        borderWidth: 1,
        padding: 14,
        titleFont: { size: 16 },
        bodyFont: { size: 15 },
        callbacks: {},
      },
      zoom: {
        limits: {
          x: { minRange: 3 },
        },
        pan: {
          enabled: true,
          mode: 'x',
        },
        zoom: {
          wheel: { enabled: true, speed: 0.11 },
          pinch: { enabled: true },
          mode: 'x',
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: '#9aa3b5',
          maxRotation: 0,
          autoSkip: true,
          font: { size: 16 },
        },
        grid: { color: SPECTRUM_THEME.grid },
        border: { display: true, color: 'rgba(226,230,240,0.12)' },
      },
      y: {
        beginAtZero: true,
        ticks: { color: '#9aa3b5', precision: 0, font: { size: 16 } },
        grid: { color: SPECTRUM_THEME.grid },
        border: { display: true, color: 'rgba(226,230,240,0.12)' },
        title: {
          display: true,
          text: 'APs heard',
          color: '#7a8099',
          font: { size: 16 },
        },
      },
    },
  },
};

function channelNetworksMap(summary, bandKey) {
  const m = new Map();
  for (const n of summary.networks || []) {
    if (n.band_key !== bandKey) continue;
    const ch = String(n.channel);
    if (!m.has(ch)) m.set(ch, []);
    m.get(ch).push(n);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }
  return m;
}

function histogramChartOptions(summary, bandKey) {
  const byCh = channelNetworksMap(summary, bandKey);
  const base = chartDefaults.options;
  return {
    ...base,
    onHover(ev, els) {
      const t = ev.native && ev.native.target;
      if (t) t.style.cursor = els.length ? 'pointer' : 'crosshair';
    },
    plugins: {
      ...base.plugins,
      tooltip: {
        ...base.plugins.tooltip,
        callbacks: {
          title(items) {
            if (!items.length) return '';
            const ch = items[0].label;
            const band =
              bandKey === '2.4' ? '2.4 GHz' : bandKey === '5' ? '5 GHz' : '6 GHz';
            return `${band} · Ch ${ch}`;
          },
          label(item) {
            const n = item.raw;
            return `${n} BSSID${n === 1 ? '' : 's'}`;
          },
          afterBody(items) {
            if (!items.length) return [];
            const ch = items[0].label;
            const aps = byCh.get(ch) || [];
            if (!aps.length) return [];
            const out = [];
            for (const ap of aps.slice(0, 8)) {
              const mhz = centerFreqMHzForAp(ap);
              const dm = estimateDistanceMetersFromRssi(ap.rssi, mhz);
              const rline = Number.isFinite(Number(ap.rssi))
                ? `${Number(ap.rssi).toFixed(0)} dBm`
                : '—';
              out.push(` ${formatApSsidLine(ap, 28)}`);
              out.push(` ${formatApCenterMHzLine(mhz)}`);
              out.push(` ${formatApWidthMHzLine(ap)}`);
              out.push(` ${dm != null ? `~${dm} m` : '—'}`);
              out.push(` ${rline}`);
            }
            if (aps.length > 8) out.push(` … +${aps.length - 8} more`);
            return out;
          },
        },
      },
    },
  };
}

function setBanner(text, kind) {
  const el = document.getElementById('statusBanner');
  if (!el) return;
  if (!text) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden', 'err');
  if (kind === 'err') el.classList.add('err');
}

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

function buildHistogram(bandKey, byChannel, link) {
  const counts = byChannel[bandKey] || {};
  const keys = Object.keys(counts)
    .map(k => parseInt(k, 10))
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);

  let labels = keys.map(String);
  let data = keys.map(k => counts[String(k)]);

  if (bandKey === '2.4') {
    labels = [];
    data = [];
    for (let ch = 1; ch <= 14; ch += 1) {
      labels.push(String(ch));
      data.push(counts[String(ch)] || 0);
    }
  }

  const curCh = link && link.band_key === bandKey ? link.channel : null;
  const bg = labels.map(lbl => (curCh && String(curCh) === lbl ? 'rgba(79,142,247,0.85)' : 'rgba(61,220,132,0.55)'));
  const border = labels.map(lbl => (curCh && String(curCh) === lbl ? '#4f8ef7' : 'rgba(61,220,132,0.9)'));

  return { labels, data, bg, border, curCh };
}

function renderChart(canvasId, key, bandKey, summary) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  const { labels, data, bg, border } = buildHistogram(bandKey, summary.by_channel || {}, summary.link || {});
  destroyChart(key);
  el.dataset.chartKey = key;
  if (!el.dataset.resetZoomBound) {
    el.dataset.resetZoomBound = '1';
    el.addEventListener('dblclick', ev => {
      const k = ev.currentTarget.dataset.chartKey;
      const ch = charts[k];
      if (ch && typeof ch.resetZoom === 'function') ch.resetZoom();
    });
  }
  charts[key] = new Chart(el, {
    type: chartDefaults.type,
    options: histogramChartOptions(summary, bandKey),
    data: {
      labels,
      datasets: [
        {
          label: 'Networks',
          data,
          backgroundColor: bg,
          borderColor: border,
          borderWidth: 1,
        },
      ],
    },
  });
}

function refreshCharts(summary) {
  const by = summary.by_channel || {};
  const has6 = Object.keys(by['6'] || {}).length > 0;
  document.getElementById('card6').classList.toggle('hidden', !has6);

  renderChart('chart24', 'c24', '2.4', summary);

  drawSpectrum5(summary);
  const card5 = document.getElementById('spectrum5Card');
  if (card5 && !card5.classList.contains('hidden')) {
    renderChart('chart5', 'c5', '5', summary);
  } else {
    destroyChart('c5');
  }

  if (has6) {
    renderChart('chart6', 'c6', '6', summary);
  } else {
    destroyChart('c6');
  }
}

function rssiClass(rssi) {
  if (rssi == null) return '';
  if (rssi >= -55) return 'rssi-strong';
  if (rssi >= -70) return 'rssi-mid';
  return 'rssi-weak';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function spectrumMinZoomSpan(regionId, st) {
  const fullW = st.fullMax - st.fullMin;
  if (regionId === 'spectrum24') return Math.min(1.75, Math.max(0.5, fullW * 0.12));
  return Math.min(8, Math.max(4, fullW * 0.1));
}

function spectrumRedraw(regionId) {
  if (!lastSummary) return;
  if (regionId === 'spectrum24') drawSpectrum24(lastSummary);
  else if (regionId === 'spectrum5') drawSpectrum5(lastSummary);
}

function onSpectrumWheel(regionId, canvas, ev) {
  const st = spectrumPanZoom[regionId];
  if (!st || st.fullMax - st.fullMin < 1e-6) return;
  if (st.padL == null || st.plotW == null) return;
  const rect = canvas.getBoundingClientRect();
  const xCss = ev.clientX - rect.left;
  if (xCss < st.padL || xCss > st.padL + st.plotW) return;
  ev.preventDefault();
  const vMin = st.viewMin;
  const vMax = st.viewMax;
  const span = vMax - vMin;
  const focal = vMin + ((xCss - st.padL) / st.plotW) * span;
  const zoomIn = ev.deltaY < 0;
  const factor = zoomIn ? 0.87 : 1.14;
  let newSpan = span * factor;
  const lo = spectrumMinZoomSpan(regionId, st);
  const hi = st.fullMax - st.fullMin;
  newSpan = Math.max(lo, Math.min(hi, newSpan));
  if (newSpan >= hi - 0.02) {
    st.zoomed = false;
    st.viewMin = st.fullMin;
    st.viewMax = st.fullMax;
  } else {
    const rel = span > 1e-9 ? (focal - vMin) / span : 0.5;
    let nMin = focal - rel * newSpan;
    let nMax = focal + (1 - rel) * newSpan;
    if (nMin < st.fullMin) {
      nMin = st.fullMin;
      nMax = nMin + newSpan;
    }
    if (nMax > st.fullMax) {
      nMax = st.fullMax;
      nMin = nMax - newSpan;
    }
    st.zoomed = true;
    st.viewMin = nMin;
    st.viewMax = nMax;
  }
  spectrumPanZoom[regionId] = st;
  spectrumRedraw(regionId);
}

function spectrumResetView(regionId) {
  const st = spectrumPanZoom[regionId];
  if (st && st.fullMin != null && st.fullMax != null) {
    st.zoomed = false;
    st.viewMin = st.fullMin;
    st.viewMax = st.fullMax;
    spectrumPanZoom[regionId] = st;
  }
  spectrumRedraw(regionId);
}

function onSpectrumPanStart(regionId, canvas, ev) {
  if (ev.button !== 0) return;
  const st = spectrumPanZoom[regionId];
  if (!st || st.plotW == null || st.plotW < 8) return;
  const rect = canvas.getBoundingClientRect();
  const xCss = ev.clientX - rect.left;
  if (xCss < st.padL || xCss > st.padL + st.plotW) return;
  spectrumDrag = {
    regionId,
    canvasId: canvas.id,
    startClientX: ev.clientX,
    initV0: st.viewMin,
    initV1: st.viewMax,
    plotW: st.plotW,
    full0: st.fullMin,
    full1: st.fullMax,
  };
  clearSpectrumCrosshairLayer(canvas.id);
  canvas.style.cursor = 'grabbing';
  ev.preventDefault();
}

function onSpectrumPanMove(ev) {
  if (!spectrumDrag) return;
  const d = spectrumDrag;
  const span = d.initV1 - d.initV0;
  const dx = ev.clientX - d.startClientX;
  const dCh = -(dx / d.plotW) * span;
  let n0 = d.initV0 + dCh;
  let n1 = d.initV1 + dCh;
  if (n0 < d.full0) {
    n0 = d.full0;
    n1 = d.full0 + span;
  }
  if (n1 > d.full1) {
    n1 = d.full1;
    n0 = d.full1 - span;
  }
  const st = spectrumPanZoom[d.regionId];
  if (!st) return;
  st.viewMin = n0;
  st.viewMax = n1;
  st.zoomed = n1 - n0 < d.full1 - d.full0 - 1e-4;
  spectrumPanZoom[d.regionId] = st;
  spectrumRedraw(d.regionId);
}

function onSpectrumPanEnd() {
  if (spectrumDrag) {
    const c = document.getElementById(spectrumDrag.canvasId);
    if (c) c.style.cursor = 'crosshair';
  }
  spectrumDrag = null;
}

function ensureSpectrumDocumentPan() {
  if (ensureSpectrumDocumentPan.done) return;
  ensureSpectrumDocumentPan.done = true;
  document.addEventListener('mousemove', onSpectrumPanMove);
  document.addEventListener('mouseup', onSpectrumPanEnd);
}

function clearSpectrumCrosshairLayer(canvasId) {
  const ocan = document.getElementById(`${canvasId}-crosshair`);
  if (!ocan || !ocan.width) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = ocan.getContext('2d');
  const w = ocan.width / dpr;
  const h = ocan.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
}

function paintSpectrumCrosshair(canvasId, regionId, xCss) {
  const ocan = document.getElementById(`${canvasId}-crosshair`);
  const r = spectrumHitRegions[regionId];
  if (!ocan || !ocan.width) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = ocan.width / dpr;
  const cssH = ocan.height / dpr;
  const ctx = ocan.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!r || xCss == null || Number.isNaN(xCss)) return;
  if (xCss < r.padL || xCss > r.padL + r.plotW) return;
  if (Math.abs(r.chMax - r.chMin) < 1e-9) return;

  const ch = r.chMin + ((xCss - r.padL) / r.plotW) * (r.chMax - r.chMin);
  const bandStub = { lobeMode: r.lobeMode, sigmaMult: r.sigmaMult ?? 1 };
  const clipDbm = v =>
    Math.max(r.dbMin, Math.min(r.dbmClipHi ?? r.dbPlotMax + 2, v));
  let envDb = r.dbMin;
  if (r.aps.length) {
    envDb = r.dbMin;
    for (let j = 0; j < r.aps.length; j += 1) {
      envDb = Math.max(
        envDb,
        dbmAtXForSpectrum(r.aps[j], ch, r.sigmaMult ?? 1, bandStub)
      );
    }
    envDb = clipDbm(envDb);
  }

  const yEnv = r.padT + ((envDb - r.dbPlotMax) / (r.dbMin - r.dbPlotMax)) * r.plotH;

  ctx.strokeStyle = 'rgba(226, 230, 240, 0.28)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(xCss, r.padT);
  ctx.lineTo(xCss, r.padT + r.plotH);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r.padL, yEnv);
  ctx.lineTo(r.padL + r.plotW, yEnv);
  ctx.stroke();
  ctx.setLineDash([]);

  // Lightweight crosshair readout near the horizontal line (single clean row).
  const chNum = ch.toFixed(1);
  const rssiTxt = r.aps.length ? `${envDb.toFixed(0)} dBm` : '—';
  const text = `Ch ${chNum} · ${rssiTxt}`;
  const textFont = '600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const padX = 9;
  const boxH = 20;
  ctx.font = textFont;
  const boxW = Math.ceil(ctx.measureText(text).width + padX * 2);
  let bx = xCss + 14;
  if (bx + boxW > r.padL + r.plotW - 4) bx = xCss - boxW - 14;
  bx = Math.max(r.padL + 4, Math.min(bx, r.padL + r.plotW - boxW - 4));
  let by = yEnv - boxH - 8;
  if (by < r.padT + 4) by = yEnv + 8;
  by = Math.max(r.padT + 4, Math.min(by, r.padT + r.plotH - boxH - 4));
  const radius = 8;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'rgba(18, 20, 28, 0.9)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(bx, by, boxW, boxH, radius);
  } else {
    // Fallback for old canvas impls.
    ctx.moveTo(bx + radius, by);
    ctx.arcTo(bx + boxW, by, bx + boxW, by + boxH, radius);
    ctx.arcTo(bx + boxW, by + boxH, bx, by + boxH, radius);
    ctx.arcTo(bx, by + boxH, bx, by, radius);
    ctx.arcTo(bx, by, bx + boxW, by, radius);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1, radius - 0.5);
  } else {
    ctx.moveTo(bx + radius + 0.5, by + 0.5);
    ctx.arcTo(bx + boxW - 0.5, by + 0.5, bx + boxW - 0.5, by + boxH - 0.5, radius - 0.5);
    ctx.arcTo(bx + boxW - 0.5, by + boxH - 0.5, bx + 0.5, by + boxH - 0.5, radius - 0.5);
    ctx.arcTo(bx + 0.5, by + boxH - 0.5, bx + 0.5, by + 0.5, radius - 0.5);
    ctx.arcTo(bx + 0.5, by + 0.5, bx + boxW - 0.5, by + 0.5, radius - 0.5);
    ctx.closePath();
  }
  ctx.stroke();
  const textY = by + boxH / 2 + 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = textFont;
  ctx.fillStyle = r.aps.length ? '#e6eaf5' : 'rgba(226, 230, 240, 0.65)';
  ctx.fillText(text, bx + padX, textY);
  ctx.textBaseline = 'alphabetic';
}

function scheduleSpectrumCrosshair(canvasId, regionId, xCss) {
  spectrumCrosshairPending = { canvasId, regionId, xCss };
  if (spectrumCrosshairRaf != null) return;
  spectrumCrosshairRaf = requestAnimationFrame(() => {
    spectrumCrosshairRaf = null;
    const p = spectrumCrosshairPending;
    spectrumCrosshairPending = null;
    if (p) paintSpectrumCrosshair(p.canvasId, p.regionId, p.xCss);
  });
}

function spectrumTooltipHtml(ch, apsNear, bandLabel, allAps) {
  const head = `${escapeHtml(bandLabel)} · Ch ${ch.toFixed(1)}`;
  const parts = [`<strong>${head}</strong>`];
  apsNear.slice(0, 12).forEach(ap => {
    const mhz = centerFreqMHzForAp(ap);
    const dm = estimateDistanceMetersFromRssi(ap.rssi, mhz);
    const rline = Number.isFinite(Number(ap.rssi))
      ? `${Number(ap.rssi).toFixed(0)} dBm`
      : '—';
    // Match the canvas AP colour: ``colorForAp`` keys off (bssid|ssid)+idx, where idx is the
    // position in the band's sorted aps array — pass that same index in or the colours diverge.
    const apIdx = allAps ? allAps.indexOf(ap) : -1;
    const col = colorForAp(ap, apIdx >= 0 ? apIdx : 0);
    const mhzTxt = formatApCenterMHzLine(mhz);
    const bwTxt = formatApWidthMHzLine(ap);
    const distTxt = dm != null ? `~${dm} m` : '—';
    // Keep the same compact 3-line tooltip format as spectrum peak labels.
    const line1 = escapeHtml(formatApSsidLine(ap, 36));
    const line2 = escapeHtml([mhzTxt, bwTxt].join(' · '));
    const line3 = escapeHtml(`${distTxt} · ${rline}`);
    const colStyle = `style="color:${col}"`;
    const dimStyle = `style="color:${hexToRgba(col, 0.78)}"`;
    const body =
      `<span class="spectrum-tip-ssid" ${colStyle}>${line1}</span>` +
      `<br><span class="spectrum-tip-tech" ${colStyle}>${line2}</span>` +
      `<br><span class="spectrum-tip-muted" ${dimStyle}>${line3}</span>`;
    parts.push(`<div class="spectrum-tip-ap">${body}</div>`);
  });
  if (apsNear.length > 12) {
    parts.push(escapeHtml(`… +${apsNear.length - 12} more`));
  }
  return parts.join('');
}

function attachSpectrumHover(canvasId, regionId, bandLabel) {
  const canvas = document.getElementById(canvasId);
  const tip = document.getElementById('spectrumTooltip');
  if (!canvas || !tip) return;
  if (canvas.dataset.hoverBound) return;
  canvas.dataset.hoverBound = '1';
  canvas.style.cursor = 'crosshair';
  ensureSpectrumDocumentPan();

  canvas.addEventListener(
    'wheel',
    ev => {
      onSpectrumWheel(regionId, canvas, ev);
    },
    { passive: false }
  );

  canvas.addEventListener('mousedown', ev => {
    onSpectrumPanStart(regionId, canvas, ev);
  });

  canvas.addEventListener('dblclick', ev => {
    ev.preventDefault();
    spectrumResetView(regionId);
  });

  canvas.addEventListener('mousemove', ev => {
    if (spectrumDrag) {
      tip.classList.add('hidden');
      clearSpectrumCrosshairLayer(canvasId);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const xCss = ev.clientX - rect.left;
    const r = spectrumHitRegions[regionId];
    if (r && xCss >= r.padL && xCss <= r.padL + r.plotW) {
      scheduleSpectrumCrosshair(canvasId, regionId, xCss);
    } else {
      clearSpectrumCrosshairLayer(canvasId);
    }
    if (!r || !r.aps.length) {
      tip.classList.add('hidden');
      return;
    }
    if (xCss < r.padL || xCss > r.padL + r.plotW) {
      tip.classList.add('hidden');
      return;
    }
    const ch = r.chMin + ((xCss - r.padL) / r.plotW) * (r.chMax - r.chMin);
    const near = r.aps
      .filter(ap => Math.abs(Number(ap.channel) - ch) <= 1.25)
      .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
    if (!near.length) {
      tip.classList.add('hidden');
      return;
    }
    tip.innerHTML = spectrumTooltipHtml(ch, near, bandLabel, r.aps);
    tip.classList.remove('hidden');
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY + 14}px`;
  });
  canvas.addEventListener('mouseleave', () => {
    tip.classList.add('hidden');
    clearSpectrumCrosshairLayer(canvasId);
  });
}

function ensureSpectrumHover() {
  if (ensureSpectrumHover.done) return;
  ensureSpectrumHover.done = true;
  attachSpectrumHover('spectrum24', 'spectrum24', '2.4 GHz');
  attachSpectrumHover('spectrum5', 'spectrum5', '5 GHz');
}

function compareNetRows(a, b, col, dir) {
  const mul = dir;
  let cmp = 0;
  switch (col) {
    case 'ssid': {
      const va = (a.ssid || '').toLowerCase();
      const vb = (b.ssid || '').toLowerCase();
      cmp = va.localeCompare(vb);
      break;
    }
    case 'bssid': {
      const va = (a.bssid || '').toLowerCase();
      const vb = (b.bssid || '').toLowerCase();
      cmp = va.localeCompare(vb);
      break;
    }
    case 'rssi': {
      const va = a.rssi != null && Number.isFinite(Number(a.rssi)) ? Number(a.rssi) : -999;
      const vb = b.rssi != null && Number.isFinite(Number(b.rssi)) ? Number(b.rssi) : -999;
      cmp = va === vb ? 0 : va < vb ? -1 : 1;
      break;
    }
    case 'channel': {
      const va = a.channel != null && Number.isFinite(Number(a.channel)) ? Number(a.channel) : 9999;
      const vb = b.channel != null && Number.isFinite(Number(b.channel)) ? Number(b.channel) : 9999;
      cmp = va === vb ? 0 : va < vb ? -1 : 1;
      break;
    }
    case 'band': {
      const va = (a.band || '').toLowerCase();
      const vb = (b.band || '').toLowerCase();
      cmp = va.localeCompare(vb);
      break;
    }
    case 'width': {
      const va = a.width_mhz != null && Number.isFinite(Number(a.width_mhz)) ? Number(a.width_mhz) : -1;
      const vb = b.width_mhz != null && Number.isFinite(Number(b.width_mhz)) ? Number(b.width_mhz) : -1;
      cmp = va === vb ? 0 : va < vb ? -1 : 1;
      break;
    }
    case 'est_m': {
      const fa = centerFreqMHzForAp(a);
      const fb = centerFreqMHzForAp(b);
      const da = estimateDistanceMetersFromRssi(a.rssi, fa);
      const db = estimateDistanceMetersFromRssi(b.rssi, fb);
      const va = da != null && Number.isFinite(da) ? da : -1;
      const vb = db != null && Number.isFinite(db) ? db : -1;
      cmp = va === vb ? 0 : va < vb ? -1 : 1;
      break;
    }
    default:
      return 0;
  }
  if (cmp !== 0) return cmp * mul;
  return 0;
}

function sortNetTable(col) {
  if (tableSortCol === col) {
    tableSortDir *= -1;
  } else {
    tableSortCol = col;
    tableSortDir = col === 'rssi' || col === 'est_m' ? -1 : 1;
  }
  if (lastSummary) renderTable(lastSummary);
}

function syncTableSortHeaders() {
  const tbl = document.getElementById('netTable');
  if (!tbl) return;
  tbl.querySelectorAll('thead th[data-col]').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    th.removeAttribute('aria-sort');
    if (th.dataset.col === tableSortCol) {
      const asc = tableSortDir === 1;
      th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');
      th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });
}

function setupTableSort() {
  const tbl = document.getElementById('netTable');
  if (!tbl || tbl.dataset.sortBound === '1') return;
  tbl.dataset.sortBound = '1';
  const head = tbl.querySelector('thead');
  if (!head) return;
  head.addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    sortNetTable(th.dataset.col);
  });
}

function renderTable(summary) {
  const body = document.getElementById('netBody');
  const empty = document.getElementById('emptyNetworks');
  const nets = summary.networks || [];
  const link = summary.link || {};
  const curBssid = (link.bssid || '').toLowerCase();

  document.getElementById('netCount').textContent = nets.length
    ? `${nets.length} BSSIDs`
    : '';

  if (!nets.length) {
    body.innerHTML = '';
    empty.classList.remove('hidden');
    syncTableSortHeaders();
    return;
  }
  empty.classList.add('hidden');

  const rows = [...nets].sort((a, b) => {
    const c = compareNetRows(a, b, tableSortCol, tableSortDir);
    if (c !== 0) return c;
    const sa = (a.ssid || '').toLowerCase();
    const sb = (b.ssid || '').toLowerCase();
    return sa.localeCompare(sb);
  });

  syncTableSortHeaders();

  body.innerHTML = rows
    .map(n => {
      const ssid =
        n.ssid && String(n.ssid).trim()
          ? String(n.ssid).trim()
          : '(hidden SSID — see BSSID)';
      const bssid = displayBssidText(n.bssid || '') || '—';
      const mark =
        n.bssid && curBssid && n.bssid.toLowerCase() === curBssid ? ' mark-row' : '';
      const rssiTxt = n.rssi != null ? `${n.rssi} dBm` : '—';
      const w = n.width_mhz != null ? `${n.width_mhz} MHz` : '—';
      const fm = centerFreqMHzForAp(n);
      const estM = estimateDistanceMetersFromRssi(n.rssi, fm);
      const farTxt = estM != null ? `~${estM} m` : '—';
      return `<tr class="${mark}">
        <td>${escapeHtml(displaySsidText(ssid))}</td>
        <td class="mono">${escapeHtml(bssid)}</td>
        <td class="${rssiClass(n.rssi)}">${rssiTxt}</td>
        <td>${n.channel != null ? n.channel : '—'}</td>
        <td>${escapeHtml(n.band || '—')}</td>
        <td>${escapeHtml(w)}</td>
        <td class="mono" title="From RSSI (same model as charts)">${escapeHtml(farTxt)}</td>
      </tr>`;
    })
    .join('');
}

function renderSuggestions(s) {
  const grid = document.getElementById('suggestGrid');
  if (!s || !grid) {
    if (grid) grid.innerHTML = '';
    return;
  }
  const parts = [];
  ['2.4 GHz', '5 GHz', '6 GHz'].forEach(band => {
    const block = s[band];
    if (!block) return;
    const rec = block.recommended != null ? block.recommended : '—';
    parts.push(`<div class="suggest-card">
      <div class="band">${escapeHtml(band)}</div>
      <div class="rec">Ch ${escapeHtml(rec)}</div>
      <div class="note">${escapeHtml(block.note || '')}</div>
    </div>`);
  });
  const cur = s.current_vs_recommended;
  if (cur && cur.recommended != null) {
    const same = cur.same ? 'Matches recommendation.' : 'Different from recommendation.';
    parts.push(`<div class="suggest-card" style="grid-column: 1 / -1">
      <div class="band">Current join</div>
      <div class="rec">Ch ${escapeHtml(cur.current_channel)}</div>
      <div class="note">${escapeHtml(same)} Suggested: ${escapeHtml(cur.recommended)}.</div>
    </div>`);
  }
  grid.innerHTML = parts.join('');
}

function applySummary(summary) {
  const prevLink = lastDisplayedLink ? { ...lastDisplayedLink } : null;
  lastSummary = summary;
  const { link, usedHistory, ssidFromHistory, bssidFromHistory } = resolveLinkForDisplay(
    summary.link || {},
    summary.networks || [],
    prevLink
  );
  lastDisplayedLink = { ...link };
  const ssidText = link.ssid || '(hidden)';
  const shownSsid = displaySsidText(ssidText) || '(hidden)';
  document.getElementById('linkSsid').textContent = ssidFromHistory ? `${shownSsid} (history)` : shownSsid;
  const bs = displayBssidText(link.bssid ? link.bssid : '');
  document.getElementById('linkBssid').textContent = bs
    ? bssidFromHistory
      ? `BSSID (history) ${bs}`
      : `BSSID ${bs}`
    : '';
  const ch = link.channel != null ? `Ch ${link.channel}` : '—';
  const mhz = centerFreqMHzForLink(link.channel, link.band_key, link.band);
  const mhzTxt = mhz != null ? `${mhz} MHz` : null;
  const band = link.band ? [ch, link.band, mhzTxt].filter(Boolean).join(' · ') : ch;
  document.getElementById('linkCh').textContent = band;
  document.getElementById('linkRssi').textContent =
    link.rssi != null ? `${link.rssi} dBm` : '—';
  document.getElementById('linkTime').textContent = displayScanTimeText(summary.scanned_at || '—');
  const shownSource = displaySourceText(summary.source || '');
  const src = shownSource ? `Source: ${shownSource}` : '';
  const nnote = summary.note ? ` · ${summary.note}` : '';
  const hnote = usedHistory ? ' · Link fields filled from history.' : '';
  const dnote = demoMode ? ' · Demo mode masks identifiers and scan metadata.' : '';
  document.getElementById('linkSource').textContent = (src + nnote + hnote + dnote).trim() || '';

  renderSuggestions(summary.suggestions || null);
  refreshCharts(summary);
  renderTable(summary);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        drawSpectrum24(summary);
        drawSpectrum5(summary);
        renderBandBarStrips(summary);
      } catch (err) {
        console.error('Network Coverage charts:', err);
      }
    });
  });

  const meta = document.getElementById('metaLine');
  if (meta) {
    const n = (summary.networks || []).length;
    meta.textContent = demoMode
      ? n
        ? `${n} BSSIDs in this demo view.`
        : 'Run a survey to populate demo data.'
      : n
        ? `${n} BSSIDs (cumulative across Scan air runs this session) — overlapping lobes show 2.4 GHz bandwidth jam.`
        : 'Run a survey to map channel usage near this Mac.';
  }
}

function historyOptionLabel(item) {
  const ts = item.scanned_at || '—';
  const n = Number(item.network_count) || 0;
  const src = item.source ? ` · ${item.source}` : '';
  return `${ts} · ${n} BSSIDs${src}`;
}

function renderHistoryTable(items) {
  const body = document.getElementById('historyBody');
  const empty = document.getElementById('emptyHistory');
  if (!body || !empty) return;
  historyItems = Array.isArray(items) ? items : [];
  if (!historyItems.length) {
    body.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  body.innerHTML = historyItems
    .map(
      (x, idx) => `<tr>
        <td class="mono">${escapeHtml(demoMode ? `scan ${idx + 1}` : (x.scanned_at || '—'))}</td>
        <td>${escapeHtml(displaySsidText(x.connected_ssid || '(hidden)'))}</td>
        <td>${x.link_rssi != null ? `${escapeHtml(String(x.link_rssi))} dBm` : '—'}</td>
        <td>${escapeHtml(String(Number(x.count_24) || 0))}</td>
        <td>${escapeHtml(String(Number(x.count_5) || 0))}</td>
        <td>${escapeHtml(String(Number(x.network_count) || 0))}</td>
        <td>${escapeHtml(displaySourceText(x.source || '—'))}</td>
        <td><button type="button" class="btn-secondary btn-small" data-history-id="${escapeHtml(
          x.id || ''
        )}">Load</button></td>
      </tr>`
    )
    .join('');
}

async function loadHistoryList() {
  try {
    const data = await fetch('/api/survey/history').then(r => r.json());
    renderHistoryTable(data.items || []);
  } catch (e) {
    renderHistoryTable([]);
  }
}

async function loadHistoryById(scanId) {
  if (!scanId) return;
  try {
    const data = await fetch(`/api/survey/history/${encodeURIComponent(scanId)}`).then(r =>
      r.json()
    );
    if (data && data.summary) {
      applySummary(data.summary);
      setBanner('', null);
    }
  } catch (e) {
    setBanner('Could not load saved scan.', 'err');
  }
}

async function loadLatest() {
  try {
    const res = await fetch('/api/survey/latest');
    const data = await res.json();
    if (data.summary) {
      applySummary(data.summary);
      if (data.summary.error) {
        setBanner(data.summary.error, 'err');
      } else {
        setBanner('', null);
      }
    }
    await loadHistoryList();
  } catch (e) {
    setBanner('Could not load /api/survey/latest — is the server running?', 'err');
  }
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function isAutoScanOn() {
  const el = document.getElementById('autoScanToggle');
  return Boolean(el && el.checked);
}

function getAutoScanGapSec() {
  const el = document.getElementById('autoScanInterval');
  const raw = el ? Number(el.value) : DEFAULT_AUTO_SCAN_GAP_SEC;
  const sec = Number.isFinite(raw) ? Math.round(raw) : DEFAULT_AUTO_SCAN_GAP_SEC;
  const clamped = Math.max(5, Math.min(300, sec));
  if (el && Number(el.value) !== clamped) el.value = String(clamped);
  return clamped;
}

/**
 * Auto-scan countdown: line under “Auto scan”; Scan air label unchanged. Hides line while scanning.
 */
function refreshAutoScanIdleUi() {
  const btn = document.getElementById('btnScan');
  const nextLine = document.getElementById('autoScanNextLine');
  const ban = document.getElementById('statusBanner');
  const waiting = isAutoScanOn() && autoScanSecondsLeft > 0;

  if (nextLine) {
    if (btn && !btn.disabled && waiting) {
      nextLine.textContent = `Next scan in ${autoScanSecondsLeft}s`;
      nextLine.classList.remove('hidden');
    } else {
      nextLine.textContent = '';
      nextLine.classList.add('hidden');
    }
  }

  if (!btn || btn.disabled) return;

  const errShowing = ban && ban.classList.contains('err');
  btn.textContent = 'Scan air';

  if (waiting) return;

  if (!errShowing && ban && ban.textContent.startsWith('Next scan in')) {
    setBanner('', null);
  }
}

function clearScanElapsedTimer() {
  if (scanElapsedTimer != null) {
    clearInterval(scanElapsedTimer);
    scanElapsedTimer = null;
  }
  scanElapsedSec = 0;
}

function startScanElapsedTimer() {
  clearScanElapsedTimer();
  const btn = document.getElementById('btnScan');
  if (btn) btn.textContent = 'Scanning…';
  scanElapsedTimer = setInterval(() => {
    scanElapsedSec += 1;
    const b = document.getElementById('btnScan');
    if (b) b.textContent = `Scanning ${scanElapsedSec}s…`;
  }, 1000);
}

function clearAutoScanCountdown() {
  if (autoScanCountdownTimer != null) {
    clearInterval(autoScanCountdownTimer);
    autoScanCountdownTimer = null;
  }
  autoScanSecondsLeft = 0;
  refreshAutoScanIdleUi();
}

function scheduleNextAutoScan() {
  if (!isAutoScanOn()) return;
  clearAutoScanCountdown();
  autoScanSecondsLeft = getAutoScanGapSec();
  refreshAutoScanIdleUi();
  autoScanCountdownTimer = setInterval(() => {
    autoScanSecondsLeft -= 1;
    if (autoScanSecondsLeft <= 0) {
      clearInterval(autoScanCountdownTimer);
      autoScanCountdownTimer = null;
      autoScanSecondsLeft = 0;
      refreshAutoScanIdleUi();
      if (isAutoScanOn()) startSurvey({ auto: true });
    } else {
      refreshAutoScanIdleUi();
    }
  }, 1000);
}

function onAutoScanToggleChange() {
  if (!isAutoScanOn()) {
    clearAutoScanCountdown();
    refreshAutoScanIdleUi();
    return;
  }
  clearAutoScanCountdown();
  scheduleNextAutoScan();
}

function onAutoScanIntervalChange() {
  getAutoScanGapSec();
  if (isAutoScanOn()) {
    scheduleNextAutoScan();
  } else {
    refreshAutoScanIdleUi();
  }
}

async function startSurvey(opts = {}) {
  const replace = opts.replace === true;
  const auto = opts.auto === true;
  const btn = document.getElementById('btnScan');
  const btnFresh = document.getElementById('btnScanFresh');

  clearAutoScanCountdown();
  clearScanElapsedTimer();

  if (auto) {
    setBanner('Auto scan… Merging into session after multi-pass CoreWLAN (~15–45s).', null);
  } else {
    setBanner(
      replace
        ? 'Scanning (fresh)… replacing accumulated data after this run.'
        : 'Scanning… Merging into session data after ~15–45s (multi-pass CoreWLAN).',
      null
    );
  }
  btn.disabled = true;
  if (btnFresh) btnFresh.disabled = true;
  try {
    const url = replace ? '/api/survey?replace=1' : '/api/survey';
    const res = await fetch(url, { method: 'POST' });
    if (res.status === 409) {
      setBanner('A scan is already running.', null);
      btn.disabled = false;
      if (btnFresh) btnFresh.disabled = false;
      if (isAutoScanOn()) scheduleNextAutoScan();
      else refreshAutoScanIdleUi();
      return;
    }
  } catch (e) {
    setBanner('Could not start scan.', 'err');
    btn.disabled = false;
    if (btnFresh) btnFresh.disabled = false;
    if (isAutoScanOn()) scheduleNextAutoScan();
    else refreshAutoScanIdleUi();
    return;
  }

  startScanElapsedTimer();
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const st = await fetch('/api/survey/status').then(r => r.json());
      if (st.message) setBanner(st.status === 'running' ? st.message : '', null);
      if (st.status !== 'running') {
        stopPoll();
        clearScanElapsedTimer();
        btn.disabled = false;
        if (btnFresh) btnFresh.disabled = false;
        await loadLatest();
        if (st.message) {
          setBanner(st.message, 'err');
        }
        if (isAutoScanOn()) scheduleNextAutoScan();
        else refreshAutoScanIdleUi();
      }
    } catch (e) {
      stopPoll();
      clearScanElapsedTimer();
      btn.disabled = false;
      if (btnFresh) btnFresh.disabled = false;
      if (isAutoScanOn()) scheduleNextAutoScan();
      else refreshAutoScanIdleUi();
    }
  }, 600);
}

window.addEventListener('load', () => {
  const qs = new URLSearchParams(window.location.search || '');
  demoMode = qs.get('demo') === '1' || qs.get('public') === '1';
  ensureSpectrumHover();
  setupTableSort();
  updateDemoModeUi();
  document.getElementById('autoScanToggle')?.addEventListener('change', onAutoScanToggleChange);
  document
    .getElementById('autoScanInterval')
    ?.addEventListener('change', onAutoScanIntervalChange);
  document.getElementById('historyBody')?.addEventListener('click', ev => {
    const btn = ev.target.closest('button[data-history-id]');
    if (!btn) return;
    loadHistoryById(btn.dataset.historyId || '');
  });
  loadLatest();
});

let spectrumResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(spectrumResizeTimer);
  spectrumResizeTimer = setTimeout(() => {
    if (lastSummary) {
      drawSpectrum24(lastSummary);
      drawSpectrum5(lastSummary);
      renderBandBarStrips(lastSummary);
      ['c24', 'c5', 'c6'].forEach(k => {
        if (charts[k]) charts[k].resize();
      });
    }
  }, 120);
});

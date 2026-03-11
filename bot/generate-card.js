'use strict';

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

// Register fonts from @fontsource npm packages (woff2 files work with napi-rs/canvas)
const FONTSOURCE = path.join(__dirname, '..', 'node_modules', '@fontsource');
GlobalFonts.registerFromPath(path.join(FONTSOURCE, 'outfit/files/outfit-latin-400-normal.woff2'), 'Outfit');
GlobalFonts.registerFromPath(path.join(FONTSOURCE, 'outfit/files/outfit-latin-700-normal.woff2'), 'Outfit');
GlobalFonts.registerFromPath(path.join(FONTSOURCE, 'outfit/files/outfit-latin-800-normal.woff2'), 'Outfit');
GlobalFonts.registerFromPath(path.join(FONTSOURCE, 'ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'), 'IBM Plex Mono');
GlobalFonts.registerFromPath(path.join(FONTSOURCE, 'ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2'), 'IBM Plex Mono');

const THEMES = {
  dark: { bg1: '#060608', bg2: '#0e0f14', glow: null },
  orange: { bg1: '#160800', bg2: '#2a1000', glow: '#ff6a00' },
  green: { bg1: '#001508', bg2: '#002810', glow: '#00d46a' },
  purple: { bg1: '#0c0018', bg2: '#1a0030', glow: '#9b00ff' },
};

function fmtAmount(v, currency, rate) {
  const n = Number(v || 0) * (currency === 'IDR' ? (rate || 1) : 1);
  if (!Number.isFinite(n)) return currency === 'IDR' ? 'Rp0' : '$0.00';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (currency === 'IDR') {
    if (abs >= 1e9) return `${sign}Rp${(abs / 1e9).toFixed(2)}M`;   // miliar
    if (abs >= 1e6) return `${sign}Rp${(abs / 1e6).toFixed(2)}jt`;  // juta
    if (abs >= 1e3) return `${sign}Rp${(abs / 1e3).toFixed(1)}rb`;  // ribu
    return `${sign}Rp${Math.round(abs)}`;
  }
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(v) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtDuration(secsDiff) {
  if (!secsDiff || secsDiff < 0) return '—';
  const h = Math.floor(secsDiff / 3600);
  const m = Math.floor((secsDiff % 3600) / 60);
  const s = Math.floor(secsDiff % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Generate a PnL card PNG buffer.
 *
 * @param {object}  data         - API response from /api/pnl-generator
 * @param {object}  options
 * @param {string}  [options.bgPath]        - Path to background image file (optional)
 * @param {string}  [options.theme]         - Theme name: dark|orange|green|purple
 * @param {Set}     [options.hiddenFields]  - Set of field keys to hide: time|deposited|binstep|basefee|pnlpct
 * @param {string}  [options.currency]      - 'USD' or 'IDR'
 * @param {number}  [options.rate]          - USD→IDR exchange rate (required when currency='IDR')
 * @param {object}  [options.user]          - { avatarUrl, displayName }
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generateCard(data, options = {}) {
  const { bgPath, theme = 'dark', hiddenFields = new Set(), currency = 'USD', rate = 1, user = null } = options;

  const W = 800;
  const H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Background ──
  if (bgPath) {
    try {
      const img = await loadImage(bgPath);
      const scale = Math.max(W / img.width, H / img.height);
      const sw = img.width * scale;
      const sh = img.height * scale;
      const sx = (W - sw) / 2;
      const sy = (H - sh) / 2;
      ctx.drawImage(img, sx, sy, sw, sh);
    } catch {
      // Fallback to theme if image fails
      drawThemeBg(ctx, W, H, theme);
    }
  } else {
    drawThemeBg(ctx, W, H, theme);
  }

  // ── Dark left overlay ──
  const leftOverlay = ctx.createLinearGradient(0, 0, W * 0.72, 0);
  leftOverlay.addColorStop(0, 'rgba(0,0,0,0.82)');
  leftOverlay.addColorStop(0.6, 'rgba(0,0,0,0.60)');
  leftOverlay.addColorStop(1, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = leftOverlay;
  ctx.fillRect(0, 0, W, H);

  // ── Drop shadow for text ──
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  // ── Top tag ──
  ctx.font = '500 18px "IBM Plex Mono"';
  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.textAlign = 'center';
  ctx.fillText('#METEORAJAWIR', W - 400, 30);

  // ── Left column ──
  const pnlPositive = (data.pnlUsd ?? 0) >= 0;
  const pnlColor = pnlPositive ? '#5ce69f' : '#ff6f7f';
  const pnlSign = pnlPositive ? '+' : '';

  const lx = 72;
  const ty = 95;

  ctx.textAlign = 'left';

  // Time / Duration
  if (!hiddenFields.has('time')) {
    let timeLabel, timeValue;
    if (data.openedAt && data.closedAt && data.closedAt > data.openedAt) {
      timeLabel = 'TIME';
      timeValue = fmtDuration(data.closedAt - data.openedAt);
    } else if (data.closedAt) {
      timeLabel = 'CLOSED';
      const d = new Date(data.closedAt * 1000);
      timeValue = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
    } else {
      timeLabel = 'TIME';
      timeValue = '—';
    }

    ctx.font = '600 11px "IBM Plex Mono"';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(timeLabel, lx, ty);

    const timeFontSize = timeValue.length > 10 ? 32 : 44;
    ctx.font = `800 ${timeFontSize}px Outfit`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(timeValue, lx, ty + 48);
  }

  // DLMM label
  ctx.font = '700 13px Outfit';
  ctx.fillStyle = '#ff8a1f';
  ctx.fillText('DLMM', lx, ty + 76);

  // Pair name
  const pairName = String(data.pairName || '—');
  const pairFontSize = pairName.length > 12 ? Math.max(32, Math.floor(52 - (pairName.length - 12) * 2)) : 52;
  ctx.font = `800 ${pairFontSize}px Outfit`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(pairName, lx, ty + 134);

  // Profit label + value
  ctx.font = '600 11px "IBM Plex Mono"';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('PROFIT (USD)', lx, ty + 166);

  const profitStr = pnlSign + fmtAmount(data.pnlUsd, currency, rate);
  const profitSize = profitStr.length > 10 ? 48 : 62;
  ctx.font = `800 ${profitSize}px Outfit`;
  ctx.fillStyle = pnlColor;
  ctx.fillText(profitStr, lx, ty + 230);

  // ── User avatar + display name (right side, vertically centered) ──
  if (user?.avatarUrl || user?.displayName) {
    const avatarSize = 64;
    const ax = W - 56 - avatarSize / 2; // center-x of circle
    const ay = H / 2 - 12;             // vertically centered

    if (user.avatarUrl) {
      try {
        const avatarImg = await loadImage(user.avatarUrl);
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        // Circular clip
        ctx.beginPath();
        ctx.arc(ax, ay, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatarImg, ax - avatarSize / 2, ay - avatarSize / 2, avatarSize, avatarSize);
        ctx.restore();
        // Subtle border ring
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.beginPath();
        ctx.arc(ax, ay, avatarSize / 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      } catch { }
    }

    if (user.displayName) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.font = '700 14px Outfit';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(user.displayName, ax, ay + avatarSize / 2 + 22);
      ctx.restore();
    }
  }

  // ── Bottom stats ──
  const statY = H - 24;
  const statLabelY = H - 42;

  const allStats = [
    { key: 'deposited', label: 'DEPOSITED', value: fmtAmount(data.depositedUsd, currency, rate), color: '#ffffff' },
    { key: 'binstep', label: 'BIN STEP', value: data.binStep != null ? String(data.binStep) : '—', color: '#ffffff' },
    { key: 'basefee', label: 'BASE FEE', value: data.baseFeePct != null ? `${data.baseFeePct}%` : '—', color: '#ffffff' },
    { key: 'pnlpct', label: 'PNL', value: data.pnlPct != null ? fmtPct(data.pnlPct) : '—', color: pnlColor },
  ];

  const visibleStats = allStats.filter((s) => !hiddenFields.has(s.key));
  const slotW = W / (visibleStats.length || 1);

  visibleStats.forEach((s, i) => {
    const cx = i * slotW + slotW / 2;
    ctx.font = '600 10px "IBM Plex Mono"';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.textAlign = 'center';
    ctx.fillText(s.label, cx, statLabelY);

    ctx.font = '700 14px Outfit';
    ctx.fillStyle = s.color;
    ctx.textAlign = 'center';
    ctx.fillText(s.value, cx, statY);
  });

  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  return canvas.toBuffer('image/png');
}

function drawThemeBg(ctx, W, H, themeName) {
  const theme = THEMES[themeName] || THEMES.dark;
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, theme.bg1);
  grad.addColorStop(1, theme.bg2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  if (theme.glow) {
    const radial = ctx.createRadialGradient(W * 0.25, H * 0.5, 0, W * 0.25, H * 0.5, W * 0.6);
    radial.addColorStop(0, theme.glow + '22');
    radial.addColorStop(1, 'transparent');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, W, H);
  }
}

module.exports = { generateCard };

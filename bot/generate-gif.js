'use strict';

const ffmpeg      = require('fluent-ffmpeg');
const ffmpegPath  = require('ffmpeg-static');
const fs          = require('fs');
const os          = require('os');
const path        = require('path');
const crypto      = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);

function fmtUsd(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '$0.00';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
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

function escapeDrawtext(s) {
  // ffmpeg drawtext requires escaping certain chars
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

/**
 * Overlay text onto a video clip and export as GIF.
 *
 * @param {string}  videoPath   - Path to source video
 * @param {object}  data        - API response from /api/pnl-generator
 * @param {object}  options
 * @param {Set}     [options.hiddenFields] - Fields to hide
 * @returns {Promise<Buffer>} GIF buffer
 */
async function generateGif(videoPath, data, options = {}) {
  const { hiddenFields = new Set() } = options;

  const pnlPositive = (data.pnlUsd ?? 0) >= 0;
  const pnlColor    = pnlPositive ? '5ce69f' : 'ff6f7f';

  // Build text fields
  const pairName  = escapeDrawtext(String(data.pairName || '—'));
  const profitStr = escapeDrawtext((pnlPositive ? '+' : '') + fmtUsd(data.pnlUsd));

  let timeValue = '—';
  if (data.openedAt && data.closedAt && data.closedAt > data.openedAt) {
    timeValue = fmtDuration(data.closedAt - data.openedAt);
  } else if (data.closedAt) {
    const d = new Date(data.closedAt * 1000);
    timeValue = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  }

  const filters = [];

  // Dark left overlay via colorize + overlay
  filters.push(
    'split=2[orig][ovrl]',
    '[ovrl]drawbox=x=0:y=0:w=iw*0.72:h=ih:color=black@0.7:t=fill[box]',
    '[orig][box]overlay=0:0[base]'
  );

  let lastLabel = 'base';

  // #trackooor tag
  filters.push(
    `[${lastLabel}]drawtext=text='#trackooor':fontsize=13:fontcolor=ffffff@0.55:x=w-tw-24:y=20[tag]`
  );
  lastLabel = 'tag';

  // Time
  if (!hiddenFields.has('time')) {
    filters.push(
      `[${lastLabel}]drawtext=text='${escapeDrawtext(timeValue)}':fontsize=40:fontcolor=ffffff:x=72:y=125[tv]`
    );
    lastLabel = 'tv';
  }

  // DLMM label
  filters.push(
    `[${lastLabel}]drawtext=text='DLMM':fontsize=13:fontcolor=ff8a1f:x=72:y=171[dlmm]`
  );
  lastLabel = 'dlmm';

  // Pair name
  filters.push(
    `[${lastLabel}]drawtext=text='${pairName}':fontsize=48:fontcolor=ffffff:x=72:y=229[pair]`
  );
  lastLabel = 'pair';

  // Profit
  filters.push(
    `[${lastLabel}]drawtext=text='${profitStr}':fontsize=56:fontcolor=${pnlColor}:x=72:y=310[profit]`
  );
  lastLabel = 'profit';

  // Bottom stats
  const allStats = [
    { key: 'deposited', label: 'DEPOSITED', value: fmtUsd(data.depositedUsd) },
    { key: 'binstep',   label: 'BIN STEP',  value: data.binStep != null ? String(data.binStep) : '—' },
    { key: 'basefee',   label: 'BASE FEE',  value: data.baseFeePct != null ? `${data.baseFeePct}%` : '—' },
    { key: 'pnlpct',    label: 'PNL',       value: data.pnlPct != null ? fmtPct(data.pnlPct) : '—' },
  ];
  const visibleStats = allStats.filter((s) => !hiddenFields.has(s.key));
  const slotW = 480 / (visibleStats.length || 1);

  visibleStats.forEach((s, i) => {
    const cx   = Math.round(i * slotW + slotW / 2);
    const outL = `stat_${i}`;
    const fc   = s.key === 'pnlpct' ? pnlColor : 'ffffff';
    filters.push(
      `[${lastLabel}]drawtext=text='${escapeDrawtext(s.label)}':fontsize=10:fontcolor=ffffff@0.65:x=${cx - 20}:y=440[${outL}l]`,
      `[${outL}l]drawtext=text='${escapeDrawtext(s.value)}':fontsize=14:fontcolor=${fc}:x=${cx - 20}:y=458[${outL}]`
    );
    lastLabel = outL;
  });

  const tmpId  = crypto.randomBytes(8).toString('hex');
  const outGif = path.join(os.tmpdir(), `pnl_${tmpId}.gif`);

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .inputOptions(['-t', '5'])
      .complexFilter(filters, lastLabel)
      .outputOptions([
        '-vf', `scale=480:-1:flags=lanczos,fps=15,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
        '-loop', '0',
      ])
      .output(outGif)
      .on('end', () => {
        const buf = fs.readFileSync(outGif);
        try { fs.unlinkSync(outGif); } catch {}
        resolve(buf);
      })
      .on('error', (err) => {
        try { fs.unlinkSync(outGif); } catch {}
        reject(err);
      })
      .run();
  });
}

module.exports = { generateGif };

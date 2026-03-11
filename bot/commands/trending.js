'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ── API ───────────────────────────────────────────────────────────────────────

const DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag';

const VOLUME_MIN = { '5m': 50, '1h': 500, '4h': 2000, '24h': 10000 };

const BASE_FILTERS = [
  'base_token_has_critical_warnings=false',
  'quote_token_has_critical_warnings=false',
  'pool_type=dlmm',
  'base_token_market_cap>=150000',
  'base_token_market_cap<=10000000',
  'base_token_holders>=100',
  'base_token_organic_score>=60',
  'quote_token_organic_score>=60',
].join('&&');

const VALID_TIMEFRAMES = ['5m', '1h', '4h', '24h'];

function buildUrl(timeframe) {
  const volMin  = VOLUME_MIN[timeframe] ?? 500;
  const filters = `${BASE_FILTERS}&&volume>=${volMin}`;
  return `${DISCOVERY_BASE}/pools?page_size=100&filter_by=${encodeURIComponent(filters)}&timeframe=${timeframe}&category=top`;
}

// ── Scoring (mirrors server.js scorePools) ────────────────────────────────────
// Target: avg 700–900, realtime spikes ~1700

function scorePool(pool) {
  const tx = pool.token_x || {};

  const feeScore   = Math.log1p(Number(pool.fee_active_tvl_ratio || 0)) * 300;
  const volScore   = Math.log1p(Number(pool.volume_active_tvl_ratio || 0)) * 200;
  const tradeScore = Math.log1p(Number(pool.unique_traders || 0)) * 12
                   + Math.log1p(Number(pool.swap_count    || 0)) * 5;
  const lpScore    = Math.log1p(Number(pool.unique_lps || 0)) * 8
                   + Number(pool.active_positions_pct || 0) * 0.75;

  const raw = feeScore + volScore + tradeScore + lpScore;

  const mVol = Math.tanh(Number(pool.volume_change_pct || 0) / 200) + 1;
  const mFee = Math.tanh(Number(pool.fee_change_pct    || 0) / 200) + 1;
  const momentum = (mVol + mFee) / 2;

  let penalty = 1.0;
  if (pool.is_blacklisted)                              penalty *= 0.0;
  if (Number(tx.organic_score || 0) < 20)              penalty *= 0.3;
  else if (Number(tx.organic_score || 0) < 40)         penalty *= 0.6;
  if (Number(tx.dev_balance_pct || 0) > 15)            penalty *= 0.4;
  else if (Number(tx.dev_balance_pct || 0) > 5)        penalty *= 0.75;
  if (tx.freeze_authority_disabled === false)           penalty *= 0.7;
  if (Number(pool.total_lps || 0) < 2)                 penalty *= 0.8;
  if (Number(pool.active_positions_pct || 0) === 0)    penalty *= 0.5;

  return Math.round(Math.max(0, raw * momentum * penalty));
}

function scorePools(pools) {
  return pools
    .map((pool) => ({ ...pool, trendScore: scorePool(pool) }))
    .sort((a, b) => b.trendScore - a.trendScore);
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUsd(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n === 0) return '$—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}


function scoreEmoji(score) {
  if (score >= 500) return '🔥';
  if (score >= 250) return '📈';
  if (score >= 100) return '➡️';
  return '❄️';
}

// ── Slash command ─────────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('trending')
  .setDescription('Top 10 trending Meteora DLMM pools by trend score')
  .addStringOption((opt) =>
    opt.setName('timeframe')
      .setDescription('Scoring timeframe (default: 5m)')
      .setRequired(false)
      .addChoices(
        { name: '5m',  value: '5m'  },
        { name: '1h',  value: '1h'  },
        { name: '4h',  value: '4h'  },
        { name: '24h', value: '24h' },
      )
  );

async function execute(interaction) {
  await interaction.deferReply();

  const timeframe = interaction.options.getString('timeframe') || '5m';

  let pools;
  try {
    const res = await fetch(buildUrl(timeframe));
    if (!res.ok) throw new Error(`API ${res.status}`);
    const json = await res.json();
    pools = Array.isArray(json) ? json : (json.pools ?? json.data ?? []);
  } catch (err) {
    return interaction.editReply(`❌ Failed to fetch pools: ${err.message}`);
  }

  if (!pools.length) {
    return interaction.editReply('No pools found for the given filters.');
  }

  const scored = scorePools(pools).slice(0, 10);

  const embed = new EmbedBuilder()
    .setTitle(`Trending Pools · ${timeframe}`)
    .setColor(0xff6a33)
    .setTimestamp()
    .setFooter({ text: `${scored.length} pools · filtered: mcap $150K–$10M · organic ≥60 · vol ≥$1K` });

  const lines = scored.map((pool) => {
    const tx       = pool.token_x || {};
    const name     = pool.name || pool.pool_address?.slice(0, 8) || 'Unknown';
    const score    = pool.trendScore;
    const emoji    = scoreEmoji(score);
    const binStep  = pool.dlmm_params?.bin_step ?? '—';
    const baseFee  = Number(pool.fee_pct || 0).toFixed(2);
    const tvl      = fmtUsd(pool.tvl);
    const fdv      = fmtUsd(tx.market_cap || tx.fdv);
    const url      = `https://app.meteora.ag/dlmm/${pool.pool_address}?utm_campaign=dlmm_revamp&ref_id=0xyunss`;

    return `${emoji} [${name}](${url}) \`${score}\` | bin \`${binStep}\` | \`${baseFee}%\` | ${tvl} | ${fdv}`;
  });

  embed.setDescription(lines.join('\n'));

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute };

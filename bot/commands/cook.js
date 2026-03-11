'use strict';

const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const cheerio = require('cheerio');

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Scraper ───────────────────────────────────────────────────────────────────

async function fetchTokenStats(mint) {
  const cookie = process.env.COOKIN_COOKIE;
  if (!cookie) throw new Error('COOKIN_COOKIE not set in .env');

  const res = await fetch(`https://cookin.fun/token/${mint}`, {
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Referer: 'https://cookin.fun/',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const preview = body.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`HTTP ${res.status} — ${preview || 'no body'}`);
  }
  const html = await res.text();
  return parseStats(html);
}

function parseStats(html) {
  const $ = cheerio.load(html);
  const stats = {};

  // ── 0. Symbol and name ─────────────────────────────────────────────────────
  const strong = $('strong').filter((_, el) => {
    const style = $(el).attr('style') || '';
    return style.includes('font-size: 20px');
  }).first();

  stats.symbol = strong.length ? strong.text().trim() : null;
  if (strong.length) {
    const nameSpan = strong.next('span');
    stats.name = nameSpan.length ? nameSpan.text().trim() : stats.symbol;
  } else {
    stats.name = null;
  }

  // ── 1. Summary metrics via regex ───────────────────────────────────────────
  const patterns = {
    smart_wallets: /Smart Wallets:\s*(\d+)/,
    cook_timer:    /CookTimer:\s*([\d-]+)/,
    conviction:    /Conviction:\s*(\d+)/,
    score:         /Score:\s*([\d.]+)/,
    dumpers_pct:   /Dumpers:\s*([\d.]+)%/,
    jeets_pct:     /Jeets:\s*([\d.]+)%/,
    bundle_pct:    /Bundle:\s*([\d.]+)%/,
    alpha_hands:   /AlphaHands:\s*([\d.]+)%/,
    in_profit:     /InProfit:\s*([\d.]+)%/,
    dirty_pct:     /Dirty:\s*([\d.]+)%/,
  };

  for (const [key, pat] of Object.entries(patterns)) {
    const m = html.match(pat);
    stats[key] = m ? m[1] : null;
  }

  // ── 2. Pump / Dump conditions ──────────────────────────────────────────────
  const pump = html.match(/Pump Conditions \((\d+)\/(\d+)\)/);
  const dump = html.match(/Dump Conditions \((\d+)\/(\d+)\)/);
  stats.pump_conditions = pump ? { met: parseInt(pump[1]), total: parseInt(pump[2]) } : null;
  stats.dump_conditions = dump ? { met: parseInt(dump[1]), total: parseInt(dump[2]) } : null;

  // ── 3. Sell Impact ─────────────────────────────────────────────────────────
  const sell_impact = {};
  for (const label of ['Nuke', 'Large', 'Average', 'Low', 'Positive']) {
    const m = html.match(new RegExp(`${label}:</span>\\s*<span[^>]*>\\s*([\\d.]+)%`));
    sell_impact[label.toLowerCase()] = m ? m[1] : null;
  }
  stats.sell_impact = sell_impact;

  // ── 4. Top holders ─────────────────────────────────────────────────────────
  const holders = [];
  $('span[id^="th-countdown-"]').each((_, el) => {
    const tag     = $(el);
    const wallet  = tag.attr('id').replace('th-countdown-', '');
    const seconds = parseInt(tag.attr('data-seconds') || '0', 10);
    const pctTag  = tag.prevAll('span.gradient-text-holder').first();
    const pct     = pctTag.length ? pctTag.text().trim() : '?';
    holders.push({ wallet, pct_held: pct, seconds_to_sell: seconds, sell_signal: seconds < 0 });
  });
  stats.top_holders = holders;

  // ── 5. Bundles ─────────────────────────────────────────────────────────────
  stats.bundles = null;
  stats.bundle_percentages = [];

  const bundlesLabel = $('span').filter((_, el) => /Bundles:/.test($(el).text())).first();
  if (bundlesLabel.length) {
    const countSpan = bundlesLabel.nextAll('span.gradient-text-holder').first();
    stats.bundles = countSpan.length ? countSpan.text().trim() : null;

    const container = bundlesLabel.parent();
    container.find('span').filter((_, el) => {
      const style = $(el).attr('style') || '';
      return style.includes('#ff8c42') || style.includes('#dc3545');
    }).each((_, el) => {
      const val = $(el).text().trim();
      if (/^[\d.]+%$/.test(val)) {
        const isTop = ($(el).attr('style') || '').includes('#dc3545');
        stats.bundle_percentages.push({ pct: val, is_top: isTop });
      }
    });
  }

  // ── 6. KOLs ───────────────────────────────────────────────────────────────
  const kols = [];
  $('span[id^="kol-countdown-"]').each((_, el) => {
    const tag     = $(el);
    const name    = tag.attr('id').replace('kol-countdown-', '');
    const seconds = parseInt(tag.attr('data-seconds') || '0', 10);
    const pctSpan = tag.prevAll('span').filter((_, s) => /min-width: 48px/.test($(s).attr('style') || '')).first();
    const pct     = pctSpan.length ? pctSpan.text().trim() : '?';
    kols.push({ name, pct_held: pct, seconds_to_sell: seconds, sell_signal: seconds < 0 });
  });
  stats.kols = kols;

  return stats;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(seconds) {
  const neg = seconds < 0;
  const s   = Math.abs(seconds);
  let str;
  if (s < 60)   str = `${s}s`;
  else if (s < 3600) str = `${Math.floor(s / 60)}m`;
  else str = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return neg ? `-${str} (overdue 🚨)` : str;
}

function pctBar(value, width = 10) {
  if (value == null) return 'N/A';
  const v      = parseFloat(value);
  const filled = Math.round((v / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${v.toFixed(1)}%`;
}

function scoreColor(score) {
  if (score == null) return 0x99aab5;
  const s = parseFloat(score);
  if (s >= 7) return 0x57f287;  // green
  if (s >= 4) return 0xfee75c;  // yellow
  return 0xed4245;              // red
}

function scoreEmoji(score) {
  if (score == null) return '❓';
  const s = parseFloat(score);
  if (s >= 7) return '🟢';
  if (s >= 4) return '🟡';
  return '🔴';
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildEmbed(mint, s) {
  const score  = s.score;
  const symbol = s.symbol || mint.slice(0, 8);
  const name   = s.name   || symbol;
  const pc     = s.pump_conditions;
  const dc     = s.dump_conditions;
  const pumpStr = pc ? `${pc.met}/${pc.total}` : '?';
  const dumpStr = dc ? `${dc.met}/${dc.total}` : '?';

  const now = new Date().toLocaleString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Bangkok', hour12: false,
  }) + ' UTC+7';

  const embed = new EmbedBuilder()
    .setTitle(`${scoreEmoji(score)} ${name} ($${symbol})`)
    .setURL(`https://cookin.fun/token/${mint}`)
    .setColor(scoreColor(score))
    .setTimestamp();

  // Core Metrics
  embed.addFields({
    name: '📊 Core Metrics',
    value: [
      '```',
      `Score:         ${s.score         ?? '?'}`,
      `Conviction:    ${s.conviction     ?? '?'}`,
      `CookTimer:     ${s.cook_timer     ?? '?'}`,
      `Smart Wallets: ${s.smart_wallets  ?? '?'}`,
      `Bundles:       ${s.bundles        ?? '?'}`,
      '```',
    ].join('\n'),
    inline: false,
  });

  // Holder Quality
  embed.addFields({
    name: '👥 Holder Quality',
    value: [
      '```',
      `Dumpers:    ${pctBar(s.dumpers_pct)}`,
      `Jeets:      ${pctBar(s.jeets_pct)}`,
      `Bundle:     ${pctBar(s.bundle_pct)}`,
      `AlphaHands: ${pctBar(s.alpha_hands)}`,
      `InProfit:   ${pctBar(s.in_profit)}`,
      `Dirty:      ${pctBar(s.dirty_pct)}`,
      '```',
    ].join('\n'),
    inline: false,
  });

  // Sell Impact
  const si = s.sell_impact || {};
  embed.addFields({
    name: '📉 Sell Impact',
    value: [
      `🔴 Nuke       \`${si.nuke     ?? '?'}%\``,
      `🟠 Large      \`${si.large    ?? '?'}%\``,
      `🟡 Average    \`${si.average  ?? '?'}%\``,
      `🟢 Low        \`${si.low      ?? '?'}%\``,
      `✅ Positive   \`${si.positive ?? '?'}%\``,
    ].join('\n'),
    inline: true,
  });

  // Conditions
  embed.addFields({
    name: '📈 Conditions',
    value: `🟢 Pump: \`${pumpStr}\`\n🔴 Dump: \`${dumpStr}\``,
    inline: true,
  });

  // Top Holders
  const holders = s.top_holders || [];
  if (holders.length) {
    const lines = holders.slice(0, 5).map((h) => {
      const wallet = h.wallet.slice(0, 8) + '…';
      const signal = h.sell_signal ? '🚨' : '⏳';
      return `${signal} \`${wallet}\` ${h.pct_held} → ${fmtTime(h.seconds_to_sell)}`;
    });
    embed.addFields({ name: '🏆 Top Holders', value: lines.join('\n'), inline: false });
  }

  // KOLs
  const kols = s.kols || [];
  if (kols.length) {
    const lines = kols.map((k) => {
      const signal = k.sell_signal ? '🚨' : '⏳';
      return `${signal} **${k.name}** ${k.pct_held} → ${fmtTime(k.seconds_to_sell)}`;
    });
    embed.addFields({ name: '🤝 KOLs', value: lines.join('\n'), inline: false });
  } else {
    embed.addFields({ name: '🤝 KOLs', value: 'No KOLs holding', inline: false });
  }

  // Bundles
  const badges = s.bundle_percentages || [];
  const bundleName = `📦 Bundles (${s.bundles ?? '?'})`;
  if (badges.length) {
    const parts = badges.slice(0, 8).map((b) => `${b.is_top ? '🔴' : '🟠'} \`${b.pct}\``);
    embed.addFields({ name: bundleName, value: parts.join('  '), inline: false });
  } else {
    embed.addFields({ name: bundleName, value: 'No bundle data', inline: false });
  }

  embed.setFooter({ text: `CA: ${mint}  •  ${now}` });
  return embed;
}

// ── Slash command definition ──────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('cook')
  .setDescription('Get cookin.fun stats for a token')
  .addStringOption((opt) =>
    opt.setName('mint').setDescription('Token mint address').setRequired(true)
  );

async function execute(interaction) {
  const mint = interaction.options.getString('mint').trim();

  if (!PUBKEY_RE.test(mint)) {
    return interaction.reply({ content: '❌ Invalid mint address.', ephemeral: true });
  }

  await interaction.deferReply();

  try {
    const stats = await fetchTokenStats(mint);
    const embed = buildEmbed(mint, stats);
    const row   = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`cook_refresh_${mint}`)
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Secondary)
    );
    await interaction.followUp({ embeds: [embed], components: [row] });
  } catch (err) {
    await interaction.followUp({ content: `❌ ${err.message}`, ephemeral: true });
  }
}

async function handleRefresh(interaction) {
  const mint = interaction.customId.replace('cook_refresh_', '');
  await interaction.deferUpdate();
  try {
    const stats = await fetchTokenStats(mint);
    const embed = buildEmbed(mint, stats);
    const row   = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`cook_refresh_${mint}`)
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    await interaction.followUp({ content: `❌ Refresh failed: ${err.message}`, ephemeral: true });
  }
}

module.exports = { data, execute, handleRefresh };

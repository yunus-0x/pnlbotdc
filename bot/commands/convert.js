'use strict';

const { EmbedBuilder } = require('discord.js');

// ── Coin symbol → CoinGecko ID map ───────────────────────────────────────────
const CRYPTO_IDS = {
  btc:   'bitcoin',
  eth:   'ethereum',
  sol:   'solana',
  bnb:   'binancecoin',
  xrp:   'ripple',
  ada:   'cardano',
  doge:  'dogecoin',
  dot:   'polkadot',
  avax:  'avalanche-2',
  matic: 'matic-network',
  link:  'chainlink',
  uni:   'uniswap',
  atom:  'cosmos',
  ltc:   'litecoin',
  near:  'near',
  apt:   'aptos',
  sui:   'sui',
  op:    'optimism',
  arb:   'arbitrum',
  jup:   'jupiter-exchange-solana',
  ray:   'raydium',
  usdc:  'usd-coin',
  usdt:  'tether',
  bonk:  'bonk',
  wif:   'dogwifcoin',
  jto:   'jito-governance-token',
  pyth:  'pyth-network',
  mew:   'cat-in-a-dogs-world',
  popcat:'popcat',
};

const FIAT_SET = new Set([
  'usd','eur','idr','gbp','jpy','sgd','myr','thb','php','vnd',
  'aud','cad','chf','hkd','krw','twd','inr','brl','mxn','try',
  'rub','zar','aed','sar','nok','sek','dkk','nzd','pln','czk',
]);

// Currency prefix symbols
const FIAT_SYMBOLS = {
  usd: '$', eur: '€', gbp: '£', jpy: '¥', idr: 'Rp', sgd: 'S$',
  myr: 'RM', thb: '฿', php: '₱', krw: '₩', inr: '₹', aud: 'A$',
  cad: 'C$', hkd: 'HK$', twd: 'NT$', vnd: '₫', brl: 'R$',
  chf: 'Fr', aed: 'AED', sar: 'SAR',
};

// No decimal places for these currencies
const NO_DECIMAL = new Set(['idr', 'vnd', 'krw', 'jpy']);

const CG_BASE = 'https://api.coingecko.com/api/v3';
const FX_BASE = 'https://open.er-api.com/v6/latest';

function isCrypto(sym) { return sym in CRYPTO_IDS; }
function isFiat(sym)   { return FIAT_SET.has(sym); }

// ── Number formatting ─────────────────────────────────────────────────────────

function fmtFiat(amount, currency) {
  const sym      = FIAT_SYMBOLS[currency] || currency.toUpperCase() + ' ';
  const decimals = NO_DECIMAL.has(currency) ? 0 : 2;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
  return `${sym}${formatted}`;
}

function fmtCrypto(amount, sym) {
  let decimals;
  if (amount >= 1000) decimals = 2;
  else if (amount >= 1) decimals = 4;
  else if (amount >= 0.01) decimals = 6;
  else decimals = 8;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amount)} ${sym.toUpperCase()}`;
}

function fmtResult(amount, sym) {
  return isFiat(sym) ? fmtFiat(amount, sym) : fmtCrypto(amount, sym);
}

// ── Price fetchers ────────────────────────────────────────────────────────────

// Fetch coin data: price, 24h change, name, image
async function getCoinData(cryptoSym, fiatSym) {
  const id  = CRYPTO_IDS[cryptoSym];
  const vs  = isFiat(fiatSym) ? fiatSym : 'usd';
  const url = `${CG_BASE}/coins/markets?vs_currency=${vs}&ids=${id}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`CoinGecko error ${r.status}`);
  const json = await r.json();
  const coin = json[0];
  if (!coin) throw new Error(`No data for ${cryptoSym.toUpperCase()}`);
  return {
    price:     coin.current_price,
    change24h: coin.price_change_percentage_24h,
    name:      coin.name,
    image:     coin.image,
  };
}

async function getFxRate(fromFiat, toFiat) {
  const r = await fetch(`${FX_BASE}/${fromFiat.toUpperCase()}`);
  if (!r.ok) throw new Error(`FX API error ${r.status}`);
  const json = await r.json();
  const rate = json.rates?.[toFiat.toUpperCase()];
  if (rate == null) throw new Error(`No rate for ${fromFiat.toUpperCase()} → ${toFiat.toUpperCase()}`);
  return rate;
}

// ── Build embed ───────────────────────────────────────────────────────────────

function changeEmoji(pct) {
  if (pct == null) return '';
  return pct >= 0 ? '📈' : '📉';
}

function buildEmbed({ amount, from, to, result, coinName, coinImage, change24h, message }) {
  const fromLabel  = from.toUpperCase();
  const toLabel    = to.toUpperCase();
  const amtFmt     = fmtResult(amount, from);
  const resFmt     = fmtResult(result, to);
  const title      = coinName
    ? `${coinName} (${isCrypto(from) ? fromLabel : toLabel})`
    : `${fromLabel} → ${toLabel}`;

  const changeLine = change24h != null
    ? `${changeEmoji(change24h)} ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}% (24h)\n`
    : '';

  const embed = new EmbedBuilder()
    .setColor(change24h == null ? 0x5865f2 : change24h >= 0 ? 0x57f287 : 0xed4245)
    .setAuthor({ name: title, iconURL: coinImage || undefined })
    .setDescription(`**${amtFmt} = ${resFmt}**\n${changeLine}💰 ${amtFmt} = ${resFmt}`)
    .setFooter({
      text: `Requested by ${message.author.username} • Today at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`,
    });

  return embed;
}

// ── Main convert logic ────────────────────────────────────────────────────────

async function handleMessage(message) {
  const parts = message.content.trim().split(/\s+/);
  if (parts.length < 4) {
    return message.reply('Usage: `.cv <amount> <from> <to>`\nExample: `.cv 1 sol idr`');
  }

  const amount = parseFloat(parts[1]);
  if (isNaN(amount) || amount <= 0) return message.reply('❌ Invalid amount.');

  const from = parts[2].toLowerCase();
  const to   = parts[3].toLowerCase();

  if (!isCrypto(from) && !isFiat(from)) return message.reply(`❌ Unknown currency: \`${from.toUpperCase()}\``);
  if (!isCrypto(to)   && !isFiat(to))   return message.reply(`❌ Unknown currency: \`${to.toUpperCase()}\``);

  try {
    let result, coinName, coinImage, change24h;

    if (isCrypto(from) && isFiat(to)) {
      const data = await getCoinData(from, to);
      result    = amount * data.price;
      coinName  = data.name;
      coinImage = data.image;
      change24h = data.change24h;

    } else if (isFiat(from) && isCrypto(to)) {
      const data = await getCoinData(to, from);
      result    = amount / data.price;
      coinName  = data.name;
      coinImage = data.image;
      change24h = data.change24h;

    } else if (isCrypto(from) && isCrypto(to)) {
      const [dataFrom, dataTo] = await Promise.all([
        getCoinData(from, 'usd'),
        getCoinData(to,   'usd'),
      ]);
      result    = amount * (dataFrom.price / dataTo.price);
      coinName  = `${dataFrom.name} → ${dataTo.name}`;
      coinImage = dataFrom.image;
      change24h = dataFrom.change24h;

    } else {
      const rate = await getFxRate(from, to);
      result = amount * rate;
    }

    const embed = buildEmbed({ amount, from, to, result, coinName, coinImage, change24h, message });
    return message.reply({ embeds: [embed] });

  } catch (err) {
    return message.reply(`❌ ${err.message}`);
  }
}

module.exports = { handleMessage };

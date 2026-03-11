'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const crypto = require('crypto');

const DEFAULT_RPC        = 'https://pump.helius-rpc.com';
const METEORA_API_BASE   = 'https://dlmm.datapi.meteora.ag';
const METEORA_FLOW_API   = 'https://dlmm-api.meteora.ag';
const DLMM_PROGRAM_ID    = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const JUP_PRICE_APIS     = ['https://api.jup.ag/price/v3', 'https://lite-api.jup.ag/price/v3'];

const SYMBOL_MAP = new Map([
  ['So11111111111111111111111111111111111111112',  'SOL'],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP'],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6Qf4r7YaB1pPB263', 'BONK'],
]);

function toSymbol(mint) {
  return SYMBOL_MAP.get(String(mint || '')) || String(mint || '?').slice(0, 4).toUpperCase();
}

function safeNum(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function round6(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
}

function uiAmount(raw, decimals) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n)) return 0;
  return n / (10 ** Number(decimals || 0));
}

function extractUsdAmount(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  const explicit = safeNum(entry.amount_usd ?? entry.usd_amount ?? entry.value_usd ?? 0);
  if (explicit > 0) return explicit;
  const x = safeNum(entry.token_x_usd_amount ?? entry.tokenXUsdAmount ?? 0);
  const y = safeNum(entry.token_y_usd_amount ?? entry.tokenYUsdAmount ?? 0);
  const sum = x + y;
  return sum > 0 ? sum : 0;
}

function normalizeFlowArray(raw, key) {
  if (Array.isArray(raw)) return raw.slice();
  if (raw && Array.isArray(raw[key])) return raw[key].slice();
  if (raw && raw.data && Array.isArray(raw.data[key])) return raw.data[key].slice();
  if (raw && Array.isArray(raw.results)) return raw.results.slice();
  if (raw && Array.isArray(raw.items)) return raw.items.slice();
  return [];
}

function computeDisc(snakeName) {
  return Array.from(crypto.createHash('sha256').update(`global:${snakeName}`).digest()).slice(0, 8);
}

const REMOVE_LIQ_DISCS = [
  computeDisc('remove_liquidity'),
  computeDisc('remove_liquidity_by_range'),
  computeDisc('remove_liquidity_one_side'),
  computeDisc('remove_all_liquidity'),
  computeDisc('remove_liquidity2'),
  computeDisc('remove_liquidity_by_range2'),
  computeDisc('remove_liquidity_one_side2'),
];

function isRemoveLiqIx(data) {
  if (!data || data.length < 8) return false;
  for (const disc of REMOVE_LIQ_DISCS) {
    let match = true;
    for (let i = 0; i < 8; i++) { if (data[i] !== disc[i]) { match = false; break; } }
    if (match) return true;
  }
  return false;
}

function getTxAccountKeys(tx) {
  const msg     = tx.transaction.message;
  const statics = msg.staticAccountKeys || msg.accountKeys || [];
  const loaded  = tx.meta?.loadedAddresses;
  return [...statics, ...(loaded?.writable || []), ...(loaded?.readonly || [])].map((k) =>
    typeof k === 'string' ? k : (k.toBase58?.() || String(k))
  );
}

function getTxInstructions(tx) {
  const msg = tx.transaction.message;
  return msg.compiledInstructions || msg.instructions || [];
}

function getIxData(ix) {
  const raw = ix.data;
  if (!raw) return null;
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) return Buffer.from(raw);
  if (typeof raw === 'string') {
    try {
      const bs58 = require('bs58');
      const mod  = bs58.default || bs58;
      return Buffer.from(mod.decode(raw));
    } catch {
      return Buffer.from(raw, 'base64');
    }
  }
  return null;
}

async function fetchPoolMeta(poolAddress) {
  try {
    const res = await fetch(`${METEORA_API_BASE}/pools/${poolAddress}`);
    if (res.ok) {
      const r = await res.json();
      if (r && typeof r === 'object' && !Array.isArray(r)) {
        // token_x can be an object {address, decimals} or a plain string
        const txObj  = r.token_x && typeof r.token_x === 'object' ? r.token_x : null;
        const tyObj  = r.token_y && typeof r.token_y === 'object' ? r.token_y : null;
        const mintX  = String(txObj?.address || r.token_x_mint || r.tokenXMint || r.mint_x || '');
        const mintY  = String(tyObj?.address || r.token_y_mint || r.tokenYMint || r.mint_y || '');
        const decX   = Number(txObj?.decimals ?? r.token_x_decimals ?? 0);
        const decY   = Number(tyObj?.decimals ?? r.token_y_decimals ?? 0);
        const binStep    = Number(r.pool_config?.bin_step  ?? r.bin_step  ?? 0);
        const baseFeePct = safeNum(r.pool_config?.base_fee_pct ?? r.base_fee_pct ?? 0);
        const name       = String(r.name || '');
        // Return as long as we got at least a name or binStep
        if (name || binStep || mintX) {
          return { name, token_x_mint: mintX, token_y_mint: mintY, token_x_decimals: decX, token_y_decimals: decY, bin_step: binStep, base_fee_pct: baseFeePct };
        }
      }
    }
  } catch {}

  return {};
}

async function fetchJupiterPriceMap(mints) {
  const ids = [...new Set(mints.map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return {};
  for (const baseUrl of JUP_PRICE_APIS) {
    try {
      const res  = await fetch(`${baseUrl}?ids=${encodeURIComponent(ids.join(','))}`);
      if (!res.ok) continue;
      const json = await res.json();
      const raw  = json?.data && typeof json.data === 'object' ? json.data : (json || {});
      const out  = {};
      for (const mint of ids) {
        const row   = raw[mint];
        const price = safeNum(row?.price || row?.usdPrice || 0);
        if (price > 0) out[mint] = { price };
      }
      if (Object.keys(out).length) return out;
    } catch {}
  }
  return {};
}

function extractPnlFlowEntry(entry) {
  const raw = Number(
    entry.block_time ?? entry.blockTime ??
    entry.onchain_timestamp ?? entry.onchainTimestamp ??
    entry.timestamp ?? entry.created_at ?? entry.createdAt ??
    entry.tx_time ?? entry.txTime ?? 0
  );
  const timestamp  = raw > 1e12 ? Math.floor(raw / 1000) : raw;
  const amountUsd  = extractUsdAmount(entry);
  const tokenXRaw  = safeNum(entry.token_x_amount ?? entry.tokenXAmount ?? entry.amount_x ?? 0);
  const tokenYRaw  = safeNum(entry.token_y_amount ?? entry.tokenYAmount ?? entry.amount_y ?? 0);
  return { timestamp, amountUsd, tokenXRaw, tokenYRaw };
}

async function fetchPositionFlowData(positionAddress) {
  const out = { deposits: [], withdrawals: [], claimedFees: [] };
  const p   = String(positionAddress || '').trim();
  if (!p) return out;

  const loadArray = async (paths, key) => {
    const bases = [METEORA_FLOW_API, METEORA_API_BASE];
    for (const base of bases) {
      for (const path of paths) {
        try {
          const res  = await fetch(`${base}/position/${encodeURIComponent(p)}/${path}`, { headers: { Accept: 'application/json' } });
          if (!res.ok) continue;
          const json = await res.json();
          const rows = normalizeFlowArray(json, key);
          if (rows.length) return rows;
        } catch {}
      }
    }
    return [];
  };

  try { out.deposits    = (await loadArray(['deposits', 'deposit'], 'deposits')).map(extractPnlFlowEntry); } catch {}
  try { out.withdrawals = (await loadArray(['withdrawals', 'withdraws', 'withdraw'], 'withdrawals')).map(extractPnlFlowEntry); } catch {}
  try { out.claimedFees = (await loadArray(['claim_fees', 'claim-fees', 'claimFees', 'fee_claims', 'fees'], 'claim_fees')).map(extractPnlFlowEntry); } catch {}

  return out;
}

/**
 * Fetch PnL data for a remove-liquidity transaction.
 * @param {string} txSig  - transaction signature
 * @param {string} [rpcUrl]
 * @returns {Promise<object>} PnL data (same shape as /api/pnl-generator response)
 */
async function fetchPnl(txSig, rpcUrl) {
  const connection = new Connection(rpcUrl || DEFAULT_RPC, 'confirmed');

  const tx = await connection.getTransaction(txSig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx) throw new Error('Transaction not found');

  const accountKeys  = getTxAccountKeys(tx);
  const instructions = getTxInstructions(tx);
  const programIdx   = accountKeys.findIndex((k) => k === DLMM_PROGRAM_ID);
  if (programIdx === -1) throw new Error('No DLMM instruction found in this transaction');

  let targetIx = null, anyDlmmIx = null;
  for (const ix of instructions) {
    const pidx = ix.programIdIndex ?? ix.programIndex;
    if (pidx !== programIdx) continue;
    const data = getIxData(ix);
    anyDlmmIx  = ix;
    if (data && isRemoveLiqIx(data)) { targetIx = ix; break; }
  }
  if (!targetIx) targetIx = anyDlmmIx;
  if (!targetIx) throw new Error('No DLMM instruction found');

  const ixAccounts      = targetIx.accountKeyIndexes || targetIx.accounts || [];
  const positionAddress = accountKeys[ixAccounts[0]] || '';
  const lbPairAddress   = accountKeys[ixAccounts[1]] || '';
  if (!positionAddress || !lbPairAddress) throw new Error('Could not extract position/pool addresses');

  const closedAt = tx.blockTime || 0;

  const [poolMeta, flowData, positionSigs] = await Promise.all([
    fetchPoolMeta(lbPairAddress),
    fetchPositionFlowData(positionAddress),
    connection.getSignaturesForAddress(new PublicKey(positionAddress), { limit: 1000, commitment: 'confirmed' }).catch(() => []),
  ]);

  const openedAt = positionSigs.length ? (positionSigs[positionSigs.length - 1].blockTime || 0) : 0;

  const tokenXMint     = String(poolMeta.token_x_mint || '');
  const tokenYMint     = String(poolMeta.token_y_mint || '');
  const tokenXDecimals = Number(poolMeta.token_x_decimals ?? 0);
  const tokenYDecimals = Number(poolMeta.token_y_decimals ?? 0);
  const binStep        = Number(poolMeta.bin_step ?? 0);
  const baseFeePct     = safeNum(poolMeta.base_fee_pct ?? 0);

  const normalise = (entries, decX, decY) => entries.map((e) => ({
    timestamp: e.timestamp,
    amountUsd: round6(e.amountUsd),
    tokenXUi:  round6(uiAmount(e.tokenXRaw, decX)),
    tokenYUi:  round6(uiAmount(e.tokenYRaw, decY)),
  }));

  const deposits    = normalise(flowData.deposits,    tokenXDecimals, tokenYDecimals);
  const withdrawals = normalise(flowData.withdrawals, tokenXDecimals, tokenYDecimals);
  const claimedFees = normalise(flowData.claimedFees, tokenXDecimals, tokenYDecimals);

  const depositedUsd   = round6(deposits.reduce((s, d) => s + d.amountUsd, 0));
  const withdrawnUsd   = round6(withdrawals.reduce((s, w) => s + w.amountUsd, 0));
  const claimedFeesUsd = round6(claimedFees.reduce((s, f) => s + f.amountUsd, 0));
  const pnlUsd         = round6(withdrawnUsd + claimedFeesUsd - depositedUsd);
  const pnlPct         = depositedUsd > 0 ? round6((pnlUsd / depositedUsd) * 100) : null;

  const tokenXSymbol = toSymbol(tokenXMint);
  const tokenYSymbol = toSymbol(tokenYMint);
  const pairName     = String(poolMeta.name || `${tokenXSymbol}-${tokenYSymbol}`);

  let priceXUsd = 0, priceYUsd = 0;
  if (tokenXMint || tokenYMint) {
    const prices = await fetchJupiterPriceMap([tokenXMint, tokenYMint].filter(Boolean));
    priceXUsd = safeNum(prices[tokenXMint]?.price || 0);
    priceYUsd = safeNum(prices[tokenYMint]?.price || 0);
  }

  return {
    positionAddress,
    lbPairAddress,
    pairName,
    tokenXSymbol,
    tokenYSymbol,
    tokenXMint,
    tokenYMint,
    binStep,
    baseFeePct,
    openedAt,
    closedAt,
    depositedUsd,
    withdrawnUsd,
    pnlUsd,
    pnlPct,
    priceXUsd,
    priceYUsd,
    hasFlowHistory: deposits.length > 0 || withdrawals.length > 0,
    deposits,
    withdrawals,
    claimedFees,
    claimedFeesUsd,
  };
}

module.exports = { fetchPnl };

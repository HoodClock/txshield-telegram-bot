require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const { ethers } = require("ethers");

const bot = new Telegraf(process.env.BOT_TOKEN);
const evmRegex = /^0x[a-fA-F0-9]{40}$/;

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function riskEmoji(score) {
  if (score <= 20) return "🟢";
  if (score <= 50) return "🟡";
  if (score <= 70) return "🟠";
  if (score <= 90) return "🔴";
  return "💀";
}

function riskLabel(score) {
  if (score <= 20) return "Safe";
  if (score <= 50) return "Low Risk";
  if (score <= 70) return "Medium Risk";
  if (score <= 90) return "High Risk";
  return "Critical Risk";
}

function threatEmoji(level) {
  if (level === "HIGH") return "🔴";
  if (level === "MEDIUM") return "🟠";
  return "🟡";
}

// Overall verdict — combines all three APIs into one top-line verdict
function overallVerdict(d) {
  const critical =
    d.trustStatus === "Critical Risk" ||
    d.isTimeHoneypot ||
    d.isHoneypotSim ||
    d.riskScore >= 90 ||
    d.timeTravelResults.some((t) => t.riskScore >= 90 || t.isBlackListDetected);

  const high =
    d.riskScore >= 70 ||
    d.buyTax > 30 ||
    d.sellTax > 30 ||
    d.riskFlags.some((f) => f.threatLevel === "HIGH") ||
    d.timeTravelResults.some((t) => t.isTradingControl);

  const phishDirty =
    d.phishingVerdict &&
    !d.phishingVerdict.toLowerCase().includes("safe") &&
    !d.phishingVerdict.toLowerCase().includes("clean") &&
    d.phishingVerdict.toLowerCase() !== "unknown";

  if (critical || phishDirty)
    return { label: "DANGEROUS — DO NOT INTERACT", bar: "🟥🟥🟥🟥🟥" };
  if (high) return { label: "HIGH RISK — Extreme caution", bar: "🟥🟥🟥🟧⬜" };
  if (d.riskScore >= 51)
    return { label: "MEDIUM RISK — Inspect before trading", bar: "🟧🟧🟧⬜⬜" };
  if (d.riskScore >= 21)
    return { label: "LOW RISK — Minor flags present", bar: "🟨🟨⬜⬜⬜" };
  return { label: "CLEAN — No major threats", bar: "🟩🟩🟩🟩🟩" };
}

function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTax(val) {
  // estimatedTax arrives as a string e.g. "0" or "5" from the API
  const n = parseFloat(val);
  return isNaN(n) ? "N/A" : `${n}%`;
}

function formatGas(val) {
  // gasUsed arrives as a string e.g. "185464"
  const n = parseInt(val, 10);
  return isNaN(n) ? "N/A" : n.toLocaleString();
}

// ─────────────────────────────────────────
// CORE SCANNER ENGINE
// ─────────────────────────────────────────
async function performTxShieldScan(contractAddress, chainId) {
  const DEAD_WALLET = "0x000000000000000000000000000000000000dEaD";
  const AMOUNT_WEI = "1";
  const DUMMY_CCY = "ETH";

  // All three APIs fire in parallel
  const [simRes, honeyRes, phishRes] = await Promise.all([
    axios.post(
      "https://api.txshield.xyz/api/simulate/execute-simulation",
      {
        userAddress: DEAD_WALLET,
        amount: AMOUNT_WEI,
        chainId: Number(chainId),
        normalizedRecipient: contractAddress,
        normalizedCurrency: DUMMY_CCY,
        recipientAddress: contractAddress,
        targetContractAddress: contractAddress,
      },
      { timeout: 15000 },
    ),
    axios.post(
      "https://api.txshield.xyz/api/honeypot/honeypot-checks",
      {
        targetContractAddress: contractAddress,
        chainId: Number(chainId),
      },
      { timeout: 15000 },
    ),
    axios.post(
      "https://api.txshield.xyz/api/phishing/phishing-checks",
      {
        userAddress: DEAD_WALLET,
        recepientAddress: contractAddress, // API typo — kept intentionally
        recipientAddress: contractAddress,
        targetContractAddress: contractAddress,
        currencySymbol: DUMMY_CCY,
        chainId: Number(chainId),
      },
      { timeout: 15000 },
    ),
  ]);

  // ── Simulation response ───────────────────────────────────────
  // Shape: { success, checks: { simulateResult, byteCodeResult, transactionHistoryResult } }
  const simResult = simRes.data?.checks?.simulateResult || {};
  const byteCode = simRes.data?.checks?.byteCodeResult || {};
  const txHistory = simRes.data?.checks?.transactionHistoryResult || {};

  // ── Honeypot response ─────────────────────────────────────────
  // Shape: { success, honeypotResponse: { riskScore, buyTax, sellTax, isTimeHoneypot, errorReason, timeTravelResults[] } }
  const honeyData = honeyRes.data?.honeypotResponse || {};
  const timeTravelResults = honeyData.timeTravelResults || [];

  // ── Phishing response ─────────────────────────────────────────
  // Shape: { success, verdict: "Safe" | "Phishing" | "Unknown" }
  const phishingVerdict = phishRes.data?.verdict || "Unknown";

  return {
    // Simulation
    simSuccess: simResult.success ?? false,
    simErrorReason: simResult.errorReason || "",
    gasUsed: simResult.gasUsed || "N/A", // string e.g. "185464"
    estimatedTax: simResult.estimatedTax ?? "N/A", // string e.g. "0"
    isReentrancy: simResult.isReentrancy ?? false,
    isHoneypotSim: simResult.isHoneypot ?? false,
    ethDelta: simResult.ethDelta || "0",
    tokenDelta: simResult.tokenDelta || "0",
    isProfit: simResult.isProfit ?? false,

    // Bytecode
    isContract: byteCode.isContract ?? false,
    trustStatus: byteCode.trustStatus || "Unknown",
    humanWarning: byteCode.humanWarning || "",
    riskFlags: byteCode.riskFlags || [],

    // Activity
    activityPulse: txHistory.activityPulse || "Unknown",
    activityMessage: txHistory.message || "",

    // Honeypot
    riskScore: honeyData.riskScore ?? 0,
    buyTax: honeyData.buyTax ?? 0,
    sellTax: honeyData.sellTax ?? 0,
    isTimeHoneypot: honeyData.isTimeHoneypot ?? false,
    honeyErrorReason: honeyData.errorReason || "",
    timeTravelResults,

    // Phishing
    phishingVerdict,
  };
}

// ─────────────────────────────────────────
// MESSAGE: Full Deep Scan (/check command)
// ─────────────────────────────────────────
function buildScanMessage(contractAddress, chainId, d) {
  const verdict = overallVerdict(d);

  // Bytecode flags block
  let flagsBlock = "";
  if (d.riskFlags.length > 0) {
    flagsBlock =
      "\n" +
      d.riskFlags
        .map(
          (f) =>
            `${threatEmoji(f.threatLevel)} *${f.title}*\n` +
            `      _${f.description}_`,
        )
        .join("\n") +
      "\n";
  }

  // Time-travel table — one row per window
  let ttBlock = "";
  for (const t of d.timeTravelResults) {
    const flags = [];
    if (t.isBlackListDetected) flags.push("⛔ Blacklist");
    if (t.isTradingControl) flags.push("🔒 Trade lock");
    if (t.isMintable && t.mintScore > 0) flags.push("🖨 Mintable");
    const flagStr = flags.length ? `  ${flags.join(" · ")}` : "";
    ttBlock +=
      `  \`${t.label.padEnd(9)}\`` +
      `  Buy:${t.buyTax}%  Sell:${t.sellTax}%` +
      `  ${riskEmoji(t.riskScore)} ${t.riskScore}/100` +
      `${flagStr}\n`;
  }

  // Phishing styling
  const isPhishClean =
    d.phishingVerdict.toLowerCase().includes("safe") ||
    d.phishingVerdict.toLowerCase().includes("clean");
  const isPhishUnknown = d.phishingVerdict.toLowerCase() === "unknown";
  const phishIcon = isPhishClean ? "✅" : isPhishUnknown ? "❓" : "🎣";

  return `🛡 *TxShield Deep Scan*
\`${contractAddress}\`
Network ID: *${chainId}*

${verdict.bar}
⚡ *${verdict.label}*

━━━━━━━━━━━━━━━━━━━━━━━
⚙️ *SIMULATION*

Status      ${d.simSuccess ? "✅ Executed" : "🚨 Reverted"}${!d.simSuccess && d.simErrorReason ? `\nReason      _${d.simErrorReason}_` : ""}
Gas used    \`${formatGas(d.gasUsed)}\`
Est. tax    ${formatTax(d.estimatedTax)}
Reentrancy  ${d.isReentrancy ? "🚨 Detected" : "✅ None"}

━━━━━━━━━━━━━━━━━━━━━━━
🔬 *BYTECODE*

Trust   *${d.trustStatus}*
${d.humanWarning ? `⚠️ _${d.humanWarning}_\n` : ""}${flagsBlock}
━━━━━━━━━━━━━━━━━━━━━━━
🍯 *HONEYPOT*

Risk score  ${riskEmoji(d.riskScore)} *${d.riskScore}/100* — ${riskLabel(d.riskScore)}
Buy tax     *${d.buyTax}%*
Sell tax    *${d.sellTax}%*
Time trap   ${d.isTimeHoneypot ? "🚨 *YES — taxes spike over time*" : "✅ No"}
${d.honeyErrorReason ? `Note  _${d.honeyErrorReason}_\n` : ""}
⏳ *Time-Travel Windows*
${ttBlock}
━━━━━━━━━━━━━━━━━━━━━━━
🎣 *PHISHING*

Verdict  ${phishIcon} *${d.phishingVerdict}*

━━━━━━━━━━━━━━━━━━━━━━━
📊 *ACTIVITY*

Pulse  *${d.activityPulse}*
${d.activityMessage ? `_${d.activityMessage}_` : ""}

_txshield.xyz_`.trim();
}

// ─────────────────────────────────────────
// MESSAGE: Radar Auto-Alert
// ─────────────────────────────────────────
function buildRadarAlertMessage(networkName, contractAddress, d) {
  const flagLines = d.riskFlags
    .map(
      (f) =>
        `  ${threatEmoji(f.threatLevel)} *${f.title}*\n` +
        `      _${f.description}_`,
    )
    .join("\n");

  return `🚨 *HONEYPOT INTERCEPTED* 🚨
_Caught before anyone got rugged_

🌐 *Network*   ${networkName}
📍 *Token*     \`${contractAddress}\`

${riskEmoji(d.riskScore)} *Risk score*    ${d.riskScore}/100 — ${riskLabel(d.riskScore)}
🍯 *Honeypot*      DETECTED
⏰ *Time-delayed*  ${d.isTimeHoneypot ? "YES — taxes spike later" : "No"}
💸 *Taxes*         Buy ${d.buyTax}%  /  Sell ${d.sellTax}%
⚙️ *Simulation*    ${d.simSuccess ? "Executed" : `Reverted — ${d.simErrorReason || "unknown"}`}
🔬 *Bytecode*      ${d.trustStatus}
${d.humanWarning ? `⚠️ _${d.humanWarning}_\n` : ""}${flagLines ? `\n📋 *Risk Flags*\n${flagLines}\n` : ""}
📊 *Activity*  ${d.activityPulse}

_Powered by TxShield Phantom Contracts_
_txshield.xyz_`.trim();
}

// ─────────────────────────────────────────
// MANUAL BOT — /check
// ─────────────────────────────────────────
bot.command("check", async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2)
    return ctx.reply("❌ Usage: `/check <contract_address>`", {
      parse_mode: "Markdown",
    });

  const targetAddress = args[1].trim();
  if (!evmRegex.test(targetAddress))
    return ctx.reply(
      "⚠️ Invalid EVM address — must start with `0x` and be 42 characters.",
      { parse_mode: "Markdown" },
    );

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔷 Ethereum", `scan_1_${targetAddress}`),
      Markup.button.callback("🟡 BSC", `scan_56_${targetAddress}`),
    ],
    [
      Markup.button.callback("🔵 Base", `scan_8453_${targetAddress}`),
      Markup.button.callback("🟠 Arbitrum", `scan_42161_${targetAddress}`),
    ],
  ]);

  await ctx.reply(
    `🎯 *Target locked*\n\`${targetAddress}\`\n\nSelect a network to scan:`,
    { parse_mode: "Markdown", ...keyboard },
  );
});

bot.action(/^scan_(\d+)_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainId = ctx.match[1];
  const contractAddress = ctx.match[2];

  const chainNames = {
    1: "Ethereum",
    56: "BSC",
    8453: "Base",
    42161: "Arbitrum",
  };
  const chainName = chainNames[chainId] || `Chain ${chainId}`;

  await ctx.editMessageText(
    `🔍 *Scanning...*\n\nNetwork: *${chainName}*\nToken: \`${shortAddr(contractAddress)}\`\n\n_Running simulation · honeypot · phishing in parallel..._`,
    { parse_mode: "Markdown" },
  );

  try {
    const data = await performTxShieldScan(contractAddress, chainId);
    const message = buildScanMessage(contractAddress, chainId, data);
    await ctx.editMessageText(message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Manual scan error:", error.message);
    await ctx.editMessageText(
      `⚠️ *Scan failed*\n\n\`${error.message}\`\n\nTry again or check the contract address.`,
      { parse_mode: "Markdown" },
    );
  }
});

// ─────────────────────────────────────────
// AUTO-BROADCAST RADAR
// ─────────────────────────────────────────
const FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
];

const W_TOKENS = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  8453: "0x4200000000000000000000000000000000000006", // Base WETH
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // Arb WETH
};

const NETWORKS = [
  {
    name: "Ethereum",
    id: 1,
    rpc: process.env.ETH_WSS_URL,
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2
  },
  {
    name: "Base",
    id: 8453,
    rpc: process.env.BASE_WSS_URL,
    factory: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB", // BaseSwap V2
  },
  {
    name: "Arbitrum",
    id: 42161,
    rpc: process.env.ARB_WSS_URL,
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", // SushiSwap V2
  },
];

function shouldAlert(d) {
  if (d.isTimeHoneypot) return true;
  if (d.isHoneypotSim) return true;
  if (d.riskScore >= 70) return true;
  if (d.buyTax > 50 || d.sellTax > 50) return true;
  if (d.trustStatus === "Critical Risk") return true;

  const hasKillSwitch = d.riskFlags.some((f) =>
    f.title.toLowerCase().includes("kill switch"),
  );
  if (hasKillSwitch && d.riskScore >= 50) return true;

  const futureDanger = d.timeTravelResults.some(
    (t) => t.riskScore >= 90 || t.isBlackListDetected,
  );
  if (futureDanger) return true;

  const phishDirty =
    d.phishingVerdict &&
    !d.phishingVerdict.toLowerCase().includes("safe") &&
    !d.phishingVerdict.toLowerCase().includes("clean") &&
    d.phishingVerdict.toLowerCase() !== "unknown";
  if (phishDirty) return true;

  return false;
}

async function startMultiChainRadar() {
  console.log("[TxShield] Multi-Chain Radar: ONLINE");

  NETWORKS.forEach((net) => {
    if (!net.rpc) {
      console.log(`[RADAR] Skipping ${net.name} — no WSS URL in .env`);
      return;
    }

    const provider = new ethers.WebSocketProvider(net.rpc);
    const factory = new ethers.Contract(net.factory, FACTORY_ABI, provider);

    factory.on("PairCreated", async (token0, token1) => {
      const wToken = W_TOKENS[net.id];
      const targetToken = token0.toLowerCase() === wToken ? token1 : token0;

      console.log(`[${net.name}] New pair: ${targetToken} — scanning...`);

      try {
        const data = await performTxShieldScan(targetToken, net.id);

        if (shouldAlert(data)) {
          const alert = buildRadarAlertMessage(net.name, targetToken, data);
          await bot.telegram.sendMessage(process.env.COMMUNITY_CHAT_ID, alert, {
            parse_mode: "Markdown",
          });
          console.log(`[${net.name}] ⚠️ Alert sent for ${targetToken}`);
        } else {
          console.log(`[${net.name}] ✅ Clean — no alert for ${targetToken}`);
        }
      } catch (err) {
        console.error(
          `[${net.name} RADAR ERROR] ${targetToken}: ${err.message}`,
        );
      }
    });

    console.log(`[RADAR] Listening on ${net.name} — ${net.factory}`);
  });
}

// ─────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────
startMultiChainRadar();
bot.launch();
console.log("[TxShield] Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

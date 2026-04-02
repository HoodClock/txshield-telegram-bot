require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const { ethers } = require("ethers");

const bot = new Telegraf(process.env.BOT_TOKEN);
const evmRegex = /^0x[a-fA-F0-9]{40}$/;

// ==========================================
// HELPERS
// ==========================================
function getRiskEmoji(score) {
  if (score <= 20) return "🟢";
  if (score <= 50) return "🟡";
  if (score <= 70) return "🟠";
  if (score <= 90) return "🔴";
  return "💀";
}

function getRiskLabel(score) {
  if (score <= 20) return "Safe";
  if (score <= 50) return "Low Risk";
  if (score <= 70) return "Medium Risk";
  if (score <= 90) return "High Risk";
  return "Critical Risk";
}

function getThreatEmoji(level) {
  if (level === "HIGH") return "🔴";
  if (level === "MEDIUM") return "🟠";
  return "🟡";
}

function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ==========================================
// CORE SCANNER ENGINE
// ==========================================
async function performTxShieldScan(contractAddress, chainId) {
  const HARDCODED_USER_EOA = "0x000000000000000000000000000000000000dEaD";
  const HARDCODED_AMOUNT_WEI = "1";
  const DUMMY_CURRENCY = "ETH";

  const [simRes, honeyRes, phishRes] = await Promise.all([
    axios.post(
      "https://api.txshield.xyz/api/simulate/execute-simulation",
      {
        userAddress: HARDCODED_USER_EOA,
        amount: HARDCODED_AMOUNT_WEI,
        chainId: Number(chainId),
        normalizedRecipient: contractAddress,
        normalizedCurrency: DUMMY_CURRENCY,
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
        userAddress: HARDCODED_USER_EOA,
        recepientAddress: contractAddress,
        recipientAddress: contractAddress,
        targetContractAddress: contractAddress,
        currencySymbol: DUMMY_CURRENCY,
        chainId: Number(chainId),
      },
      { timeout: 15000 },
    ),
  ]);

  // ── Simulation ──────────────────────────────────────────────
  const simResult = simRes.data.checks?.simulateResult || {};
  const byteCode = simRes.data.checks?.byteCodeResult || {};
  const txHistory = simRes.data.checks?.transactionHistoryResult || {};

  // ── Honeypot ─────────────────────────────────────────────────
  const honeyData = honeyRes.data.honeypotResponse || {};
  const timeTravelResults = honeyData.timeTravelResults || [];

  // ── Phishing ──────────────────────────────────────────────────
  const phishingVerdict = phishRes.data.verdict || "Unknown";

  return {
    // Simulation
    simSuccess: simResult.success ?? false,
    simErrorReason: simResult.errorReason || "",
    gasUsed: simResult.gasUsed || "N/A",
    estimatedTax: simResult.estimatedTax ?? "N/A",
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

    // Transaction History
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

// ==========================================
// MESSAGE BUILDER — Full Deep Scan
// ==========================================
function buildScanMessage(contractAddress, chainId, d) {
  const riskEmoji = getRiskEmoji(d.riskScore);
  const riskLabel = getRiskLabel(d.riskScore);

  // Simulation block
  const simLine = d.simSuccess
    ? `✅ Executed successfully`
    : `🚨 Reverted — _${d.simErrorReason || "Unknown reason"}_`;

  // Risk flags from bytecode
  let flagsBlock = "";
  if (d.riskFlags.length > 0) {
    flagsBlock =
      "\n📋 *Bytecode Risk Flags:*\n" +
      d.riskFlags
        .map(
          (f) =>
            `${getThreatEmoji(f.threatLevel)} *${f.title}*\n   └ ${f.description}`,
        )
        .join("\n");
  }

  // Time-travel honeypot table
  let timeTravelBlock = "";
  if (d.timeTravelResults.length > 0) {
    timeTravelBlock = "\n⏳ *Time-Travel Analysis:*\n";
    for (const t of d.timeTravelResults) {
      const ttRisk = getRiskEmoji(t.riskScore);
      const extras = [];
      if (t.isBlackListDetected) extras.push("⛔ Blacklist");
      if (t.isTradingControl) extras.push("🔒 Trading lock");
      if (t.isMintable) extras.push(`🖨️ Mintable (score: ${t.mintScore})`);
      const extrasStr = extras.length ? ` | ${extras.join(", ")}` : "";
      timeTravelBlock += `  *${t.label}* — Buy ${t.buyTax}% / Sell ${t.sellTax}% ${ttRisk} ${t.riskScore}/100${extrasStr}\n`;
    }
  }

  // Phishing verdict styling
  const phishEmoji =
    d.phishingVerdict.toLowerCase().includes("safe") ||
    d.phishingVerdict.toLowerCase().includes("clean")
      ? "✅"
      : d.phishingVerdict.toLowerCase() === "unknown"
        ? "❓"
        : "🎣";

  return `
🛡️ *TxShield Deep Scan Report* 🛡️
Token: \`${shortAddr(contractAddress)}\`
Chain ID: *${chainId}*

━━━━━━ ⚙️ SIMULATION ━━━━━━
Status: ${simLine}
Gas used: \`${d.gasUsed}\`
Est. tax: ${d.estimatedTax}%
Reentrancy: ${d.isReentrancy ? "🚨 Detected" : "✅ None"}

━━━━━━ 🔬 BYTECODE ━━━━━━
Trust status: *${d.trustStatus}*
${d.humanWarning ? `⚠️ _${d.humanWarning}_` : ""}${flagsBlock}

━━━━━━ 🍯 HONEYPOT ━━━━━━
Risk score: ${riskEmoji} *${d.riskScore}/100* (${riskLabel})
Buy tax: *${d.buyTax}%* | Sell tax: *${d.sellTax}%*
Time honeypot: ${d.isTimeHoneypot ? "🚨 *YES — taxes change over time*" : "✅ No"}
${d.honeyErrorReason ? `└ _${d.honeyErrorReason}_` : ""}${timeTravelBlock}
━━━━━━ 🎣 PHISHING ━━━━━━
Verdict: ${phishEmoji} *${d.phishingVerdict}*

━━━━━━ 📊 ACTIVITY ━━━━━━
Pulse: *${d.activityPulse}*
${d.activityMessage ? `└ _${d.activityMessage}_` : ""}

_Powered by TxShield · txshield.xyz_
`.trim();
}

// ==========================================
// MESSAGE BUILDER — Radar Auto-Alert
// ==========================================
function buildRadarAlertMessage(networkName, contractAddress, d) {
  const riskEmoji = getRiskEmoji(d.riskScore);
  const flagNames = d.riskFlags
    .map((f) => `${getThreatEmoji(f.threatLevel)} ${f.title}`)
    .join("\n");

  return `
🚨 *HONEYPOT INTERCEPTED* 🚨

Network: *${networkName}*
Token: \`${contractAddress}\`

🍯 Honeypot: *DETECTED*
${riskEmoji} Risk score: *${d.riskScore}/100* (${getRiskLabel(d.riskScore)})
Time-delayed: ${d.isTimeHoneypot ? "✅ YES" : "No"}
💸 Taxes: Buy *${d.buyTax}%* / Sell *${d.sellTax}%*
⚙️ Simulation: ${d.simSuccess ? "Executed" : `Reverted — ${d.simErrorReason}`}
🏷️ Trust: *${d.trustStatus}*
${flagNames ? `\n📋 Flags:\n${flagNames}` : ""}
📊 Activity: *${d.activityPulse}*

_Caught by TxShield off-chain Phantom Contracts_
`.trim();
}

// ==========================================
// MANUAL BOT — /check command
// ==========================================
bot.command("check", async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2)
    return ctx.reply("❌ Usage: `/check <address>`", {
      parse_mode: "Markdown",
    });

  const targetAddress = args[1];
  if (!evmRegex.test(targetAddress))
    return ctx.reply("⚠️ Invalid EVM address. Must be a 0x... address.");

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
    `🎯 *Target locked:* \`${targetAddress}\`\n\nSelect a network to run TxShield scan:`,
    { parse_mode: "Markdown", ...keyboard },
  );
});

bot.action(/^scan_(\d+)_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainId = ctx.match[1];
  const contractAddress = ctx.match[2];

  await ctx.editMessageText(`🔍 Running TxShield scan on chain ${chainId}...`);

  try {
    const data = await performTxShieldScan(contractAddress, chainId);
    const message = buildScanMessage(contractAddress, chainId, data);
    await ctx.editMessageText(message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Manual scan error:", error.message);
    await ctx.editMessageText(
      `⚠️ *TxShield scan failed:*\n\n\`${error.message}\``,
      { parse_mode: "Markdown" },
    );
  }
});

// ==========================================
// AUTO-BROADCAST RADAR
// ==========================================
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
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  },
  {
    name: "Base",
    id: 8453,
    rpc: process.env.BASE_WSS_URL,
    factory: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB",
  },
  {
    name: "Arbitrum",
    id: 42161,
    rpc: process.env.ARB_WSS_URL,
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
  },
];

// Determines whether a newly listed token is dangerous enough to broadcast
function shouldAlert(d) {
  // Hard honeypot signals
  if (d.isTimeHoneypot) return true;
  if (d.isHoneypotSim) return true;
  if (d.riskScore >= 70) return true;
  if (d.buyTax > 50 || d.sellTax > 50) return true;

  // Bytecode kill-switch or proxy with no legitimate activity
  const hasKillSwitch = d.riskFlags.some((f) =>
    f.title.toLowerCase().includes("kill switch"),
  );
  if (hasKillSwitch && d.riskScore >= 50) return true;

  // Any time-travel window that goes critical
  const timeTravelCritical = d.timeTravelResults.some(
    (t) => t.riskScore >= 90 || t.isBlackListDetected,
  );
  if (timeTravelCritical) return true;

  return false;
}

async function startMultiChainRadar() {
  console.log("TxShield Multi-Chain Radar: ONLINE");

  NETWORKS.forEach((net) => {
    if (!net.rpc) {
      console.log(`[RADAR] Skipping ${net.name} — no WSS URL in .env`);
      return;
    }

    const provider = new ethers.WebSocketProvider(net.rpc);
    const factory = new ethers.Contract(net.factory, FACTORY_ABI, provider);

    factory.on("PairCreated", async (token0, token1, pairAddress) => {
      const wToken = W_TOKENS[net.id];
      const targetToken = token0.toLowerCase() === wToken ? token1 : token0;

      console.log(`[${net.name} RADAR] New pair: ${targetToken} — scanning...`);

      try {
        const data = await performTxShieldScan(targetToken, net.id);

        if (shouldAlert(data)) {
          const alertMsg = buildRadarAlertMessage(net.name, targetToken, data);
          await bot.telegram.sendMessage(
            process.env.COMMUNITY_CHAT_ID,
            alertMsg,
            { parse_mode: "Markdown" },
          );
          console.log(`[ALERT] Broadcasted ${net.name} honeypot to community`);
        } else {
          console.log(`[${net.name} RADAR] ${targetToken} — clean, no alert`);
        }
      } catch (err) {
        console.error(
          `[${net.name} RADAR ERROR] ${targetToken}: ${err.message}`,
        );
      }
    });
  });
}

// ==========================================
// BOOT
// ==========================================
startMultiChainRadar();
bot.launch();
console.log("TxShield Telegram bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

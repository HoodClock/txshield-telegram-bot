require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");

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
  const n = parseFloat(val);
  return isNaN(n) ? "N/A" : `${n}%`;
}

function formatGas(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? "N/A" : n.toLocaleString();
}

// ─────────────────────────────────────────
// CORE SCANNER
// All three endpoints only accept:
//   { contractAddress, chainId }
// ─────────────────────────────────────────
async function performTxShieldScan(contractAddress, chainId) {
  const payload = {
    contractAddress: contractAddress,
    chainId: Number(chainId),
  };

  const [simRes, honeyRes, phishRes] = await Promise.all([
    axios.post(
      "https://api.txshield.xyz/api/simulate/execute-simulation",
      payload,
      { timeout: 15000 },
    ),
    axios.post(
      "https://api.txshield.xyz/api/honeypot/honeypot-checks",
      payload,
      { timeout: 15000 },
    ),
    axios.post(
      "https://api.txshield.xyz/api/phishing/phishing-checks",
      payload,
      { timeout: 15000 },
    ),
  ]);

  // Simulation
  // Shape: { success, checks: { simulateResult, byteCodeResult, transactionHistoryResult } }
  const simResult = simRes.data?.checks?.simulateResult || {};
  const byteCode = simRes.data?.checks?.byteCodeResult || {};
  const txHistory = simRes.data?.checks?.transactionHistoryResult || {};

  // Honeypot
  // Shape: { success, honeypotResponse: { riskScore, buyTax, sellTax, isTimeHoneypot, errorReason, timeTravelResults[] } }
  const honeyData = honeyRes.data?.honeypotResponse || {};
  const timeTravelResults = honeyData.timeTravelResults || [];

  // Phishing
  // Shape: { success, verdict: "Safe" | "Phishing" | "Unknown" }
  const phishingVerdict = phishRes.data?.verdict || "Unknown";

  return {
    // Simulation
    simSuccess: simResult.success ?? false,
    simErrorReason: simResult.errorReason || "",
    gasUsed: simResult.gasUsed || "N/A",
    estimatedTax: simResult.estimatedTax ?? "N/A",
    isReentrancy: simResult.isReentrancy ?? false,
    isHoneypotSim: simResult.isHoneypot ?? false,

    // Bytecode
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
// MESSAGE BUILDER
// ─────────────────────────────────────────
function buildScanMessage(contractAddress, chainId, d) {
  const verdict = overallVerdict(d);

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
${ttBlock || "  _No data_\n"}
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
// BOT COMMANDS
// ─────────────────────────────────────────
bot.command("start", async (ctx) => {
  await ctx.reply(
    `👋 *Welcome to TxShield Bot!*\n\n` +
      `Scan any EVM token contract before you trade.\n\n` +
      `*How to use:*\n` +
      `\`/check <contract_address>\`\n\n` +
      `_Example:_\n` +
      `\`/check 0x514910771af9ca656af840dff83e8264ecf986ca\`\n\n` +
      `We run simulation, honeypot detection, and phishing checks all at once.\n\n` +
      `_Powered by txshield.xyz_`,
    { parse_mode: "Markdown" },
  );
});

bot.command("check", async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2)
    return ctx.reply(
      "❌ Please provide a contract address.\n\n*Usage:* `/check <contract_address>`",
      { parse_mode: "Markdown" },
    );

  const targetAddress = args[1].trim();
  if (!evmRegex.test(targetAddress))
    return ctx.reply(
      "⚠️ Invalid EVM address.\n\nMust start with `0x` and be 42 characters long.",
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
    `🎯 *Target locked*\n\`${targetAddress}\`\n\nSelect the network:`,
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
    `🔍 *Scanning...*\n\nNetwork: *${chainName}*\nToken: \`${shortAddr(contractAddress)}\`\n\n_Running simulation · honeypot · phishing checks..._`,
    { parse_mode: "Markdown" },
  );

  try {
    const data = await performTxShieldScan(contractAddress, chainId);
    const message = buildScanMessage(contractAddress, chainId, data);
    await ctx.editMessageText(message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Scan error:", error.message);
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Body:", JSON.stringify(error.response.data));
    }
    await ctx.editMessageText(
      `⚠️ *Scan failed*\n\n\`${error.message}\`\n\nPlease try again.`,
      { parse_mode: "Markdown" },
    );
  }
});

// ─────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────
bot.launch();
console.log("[TxShield] Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

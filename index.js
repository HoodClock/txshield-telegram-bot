require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const { ethers } = require("ethers");

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const evmRegex = /^0x[a-fA-F0-9]{40}$/;

// ==========================================
// 1. THE CORE SCANNER ENGINE (Shared)
// ==========================================
// We abstracted your API calls here so both the manual bot and the radar can use it without duplicating code.
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
        contractAddress: contractAddress,
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

  const simData = simRes.data.simulateResult || simRes.data;
  const simStatus = simData.success
    ? "✅ Executed"
    : `🚨 Reverted\n   └ *${simData.humanReason || "Unknown Revert"}*`;
  const isHoneypot =
    simData.isHoneypot || honeyRes.data.isTimeHoneypot || false;
  const buyTax = honeyRes.data.buyTax || 0;
  const sellTax = honeyRes.data.sellTax || 0;
  const phishingVerdict = phishRes.data.verdict || "Unknown";

  return {
    simStatus,
    isHoneypot,
    buyTax,
    sellTax,
    phishingVerdict,
    rawSimData: simData,
  };
}

// ==========================================
// 2. MANUAL BOT COMMANDS (/check)
// ==========================================
bot.command("check", async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2)
    return ctx.reply("❌ Usage: `/check <address>`", {
      parse_mode: "Markdown",
    });

  const targetAddress = args[1];
  if (!evmRegex.test(targetAddress))
    return ctx.reply("⚠️ Invalid EVM Address.");

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
    `🎯 **Target Locked:** \`${targetAddress}\`\n\nSelect the network to run TxShield protocols:`,
    { parse_mode: "Markdown", ...keyboard },
  );
});

bot.action(/^scan_(\d+)_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chainId = ctx.match[1];
  const contractAddress = ctx.match[2];

  await ctx.editMessageText(`🔍 Initiating deep scan on Chain ${chainId}...`);

  try {
    const data = await performTxShieldScan(contractAddress, chainId);

    const resultText = `
🛡️ **TxShield Deep Scan Complete** 🛡️
Token: \`${contractAddress}\`
Network ID: **${chainId}**

⚙️ **Simulation**: ${data.simStatus}
🍯 **Honeypot Risk**: ${data.isHoneypot ? "🚨 DETECTED" : "✅ CLEAN"}
💸 **Taxes**: Buy ${data.buyTax}% | Sell ${data.sellTax}%
🎣 **Phishing**: ${data.phishingVerdict}
    `;
    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Manual Scan Error:", error.message);
    await ctx.editMessageText(
      `⚠️ **TxShield Fatal Server Error:**\n\n\`${error.message}\``,
      { parse_mode: "Markdown" },
    );
  }
});

// ==========================================
// 3. THE AUTO-BROADCAST RADAR
// ==========================================
const FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
];

// Wrapped native tokens to filter out (we want to scan the shitcoin, not WETH/WBNB)
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
  }, // Uniswap V2
  {
    name: "Base",
    id: 8453,
    rpc: process.env.BASE_WSS_URL,
    factory: "0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB",
  }, // BaseSwap V2
  {
    name: "Arbitrum",
    id: 42161,
    rpc: process.env.ARB_WSS_URL,
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
  }, // SushiSwap V2
];

async function startMultiChainRadar() {
  console.log("TxShield Multi-Chain Radar: ONLINE.");

  NETWORKS.forEach((net) => {
    if (!net.rpc)
      return console.log(
        `[RADAR] Skipping ${net.name} - No WSS URL provided in .env`,
      );

    const provider = new ethers.WebSocketProvider(net.rpc);
    const factory = new ethers.Contract(net.factory, FACTORY_ABI, provider);

    factory.on("PairCreated", async (token0, token1, pairAddress) => {
      // Isolate the new token (ignore the wrapped native token)
      const wToken = W_TOKENS[net.id];
      const targetToken = token0.toLowerCase() === wToken ? token1 : token0;

      console.log(
        `[${net.name} RADAR] New Pair Detected: ${targetToken} - Analyzing...`,
      );

      try {
        // Run it through your TxShield backend
        const data = await performTxShieldScan(targetToken, net.id);

        // THE FILTER: Only broadcast if it is actually a honeypot or massive tax
        if (data.isHoneypot || data.buyTax > 50 || data.sellTax > 50) {
          const alertMsg = `
🚨 **HONEYPOT INTERCEPTED BEFORE RUG** 🚨

**Network:** ${net.name}
**Token:** \`${targetToken}\`

🍯 **Honeypot Risk:** DETECTED
💸 **Taxes:** Buy ${data.buyTax}% | Sell ${data.sellTax}%
⚙️ **Simulation:** ${data.simStatus}

_Automatically caught by TxShield off-chain Phantom Contracts._
          `;

          await bot.telegram.sendMessage(
            process.env.COMMUNITY_CHAT_ID,
            alertMsg,
            { parse_mode: "Markdown" },
          );
          console.log(
            `[ALERT] Broadcasted honeypot on ${net.name} to community!`,
          );
        }
      } catch (err) {
        console.error(
          `[${net.name} RADAR ERROR]: API failure on ${targetToken}`,
        );
      }
    });
  });
}

// ==========================================
// 4. BOOT SEQUENCE
// ==========================================
startMultiChainRadar(); // Start listening to the blockchain
bot.launch(); // Start listening to Telegram users
console.log("TxShield Telegram interface is running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

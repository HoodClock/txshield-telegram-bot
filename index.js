require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");

// Initialize bot with your BotFather token
const bot = new Telegraf(process.env.BOT_TOKEN);

// Regex to validate EVM addresses (basic security check before hitting your API)
const evmRegex = /^0x[a-fA-F0-9]{40}$/;

// 1. The Command Listener (Asks the user to pick a chain)
bot.command("check", async (ctx) => {
  const args = ctx.message.text.split(" ");

  if (args.length < 2) {
    return ctx.reply("❌ Usage: `/check <address>`", {
      parse_mode: "Markdown",
    });
  }

  const targetAddress = args[1];

  if (!evmRegex.test(targetAddress)) {
    return ctx.reply("⚠️ Invalid EVM Address.");
  }

  // Generate the interactive button menu
  // We pass the targetAddress in the callback_data so the bot remembers it when the button is clicked
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
    {
      parse_mode: "Markdown",
      ...keyboard,
    },
  );
});

bot.action(/^scan_(\d+)_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  // Acknowledge the button click so the Telegram UI doesn't show a loading spinner on the button
  await ctx.answerCbQuery();

  // Extract the data from the button's hidden payload
  const chainId = ctx.match[1];
  const contractAddress = ctx.match[2];

  const HARDCODED_USER_EOA = "0x000000000000000000000000000000000000dEaD";
  const HARDCODED_AMOUNT_WEI = "1000000000000000000"; // 1 Token

  // Edit the menu message into a loading state
  await ctx.editMessageText(`🔍 Initiating deep scan on Chain ${chainId}...`);

  try {
    // Fire your TxShield APIs concurrently to the EXACT chain requested
    const [simRes, honeyRes, phishRes] = await Promise.all([
      axios.post("https://api.txshield.xyz/api/simulate/execute-simulation", {
        userAddress: HARDCODED_USER_EOA,
        tokenAddress: contractAddress,
        amount: HARDCODED_AMOUNT_WEI,
        chainId: Number(chainId),
      }),
      axios.post("https://api.txshield.xyz/api/honeypot/honeypot-checks", {
        tokenAddress: contractAddress,
        chainId: Number(chainId),
      }),
      axios.post("https://api.txshield.xyz/api/phishing/phishing-checks", {
        tokenAddress: contractAddress,
        chainId: Number(chainId),
      }),
    ]);

    // Map your data (Verify these keys match your actual backend response)
    const simStatus = simRes.data.success ? "✅ Executed" : "🚨 Reverted";
    const isHoneypot = honeyRes.data.isHoneypot;
    const isPhishing = phishRes.data.isPhishing;

    const resultText = `
🛡️ **TxShield Deep Scan Complete** 🛡️
Token: \`${contractAddress}\`
Network ID: **${chainId}**

⚙️ **Simulation**: ${simStatus}
🍯 **Honeypot**: ${isHoneypot ? "🚨 DETECTED" : "✅ CLEAN"}
🎣 **Phishing**: ${isPhishing ? "🚨 RISK" : "✅ CLEAN"}
        `;

    await ctx.editMessageText(resultText, { parse_mode: "Markdown" });
  } catch (error) {
    console.error(error);
    await ctx.editMessageText(
      "⚠️ TxShield Engine Error: Scan Failed. Ensure the token exists on this network.",
    );
  }
});

// Start the bot
bot.launch();
console.log("TxShield Bot is running...");

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

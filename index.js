require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");

// Initialize bot with your BotFather token
const bot = new Telegraf(process.env.BOT_TOKEN);

// Regex to validate EVM addresses (basic security check before hitting your API)
const evmRegex = /^0x[a-fA-F0-9]{40}$/;

bot.command("check", async (ctx) => {
  // Extract the text after the /check command
  const messageText = ctx.message.text;
  const args = messageText.split(" ");

  if (args.length < 2) {
    return ctx.reply(
      "❌ Error: You must provide an address. Usage: /check 0x...",
    );
  }

  const contractAddress = args[1];

  if (!evmRegex.test(contractAddress)) {
    return ctx.reply(
      "⚠️ Invalid EVM Address. Please provide a valid 0x... address.",
    );
  }

  // Send a loading message so the user knows it's working
  const loadingMsg = await ctx.reply(`🔍 Scanning ${contractAddress}...`);

  try {
    // REPLACE THIS with your actual TxShield API endpoint
    // const response = await axios.get(`https://api.txshield.com/scan/${contractAddress}`);

    // Simulating the API response for now
    const scanResult = {
      isHoneypot: false,
      riskScore: "Low",
      verified: true,
    };

    // Format the output
    const resultText = `
🛡️ **TxShield Analysis Complete** 🛡️
Address: \`${contractAddress}\`
Status: ${scanResult.isHoneypot ? "🚨 HONEYPOT DETECTED" : "✅ CLEAN"}
Risk Score: ${scanResult.riskScore}
Verified: ${scanResult.verified ? "Yes" : "No"}
        `;

    // Update the loading message with the final result
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      resultText,
      { parse_mode: "Markdown" },
    );
  } catch (error) {
    console.error(error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      "⚠️ Error connecting to TxShield API. Please try again later.",
    );
  }
});

// Start the bot
bot.launch();
console.log("TxShield Bot is running...");

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

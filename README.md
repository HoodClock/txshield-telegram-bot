# TxShield: Real-Time EVM Threat Detection (MVP)

> **Note: The core TxShield transaction simulation engine is maintained in a private repository to protect proprietary threat-detection logic. Full read-access will be granted to the Reactive DevFund review team upon request.**

TxShield is a Web3 security infrastructure project designed to catch honeypots, phishing scams, and malicious transaction logic before execution. This repository houses the frontend client interface (Telegram Bot MVP) that interacts with our proprietary off-chain simulation backend.

## ⚙️ System Architecture (Off-Chain MVP)
Currently, this bot acts as the primary user touchpoint for the TxShield ecosystem. It operates on a MERN stack architecture integrated with high-throughput RPC nodes.

1. **Event Polling:** The system continuously polls targeted EVM chains for new contract deployments and liquidity events.
2. **Simulation:** Target contract bytecodes are routed to the TxShield MERN backend.
3. **Threat Assessment:** The engine runs heuristic checks for honeypot signatures, locked liquidity anomalies, and malicious tax structures.
4. **Execution:** The bot delivers real-time risk assessments directly to the user interface.

*Future Architecture Note: We are currently architecting a migration to the Reactive Network (ReactVM) to transition this off-chain polling logic into native, autonomous Reactive Smart Contracts (RSCs).*

## 🚀 Installation & Setup

Ensure you have Node.js and npm installed.

```bash
# Clone the repository
git clone [https://github.com/your-username/txshield-telegram.git](https://github.com/your-username/txshield-telegram.git)

# Navigate to the directory
cd txshield-telegram

# Install dependencies
npm install

# Setup environmental variables
cp .env.example .env
# Add your Telegram Bot Token and RPC Endpoints to the .env file

# Run the development server
npm run dev
```

🛠 Tech Stack
Environment: Node.js, Express.js

Database: MongoDB

Web3 Integration: Ethers.js / Web3.js

Interface: Telegram Bot API

Infrastructure: Alchemy Node Services

👥 Core Development Team
Moiz (Orion) - Founder & Lead Full-Stack (MERN/Solidity) Developer

Talha - VP of Operations

Huzaifa - Web Team Lead (Backend & Frontend Architecture)

Shayan, Zubair, Taayyab - Web Team Engineers

🛡 Security & Liability
This MVP is provided as an open-source interface for the TxShield backend. Users are advised that interacting with unverified smart contracts inherently carries risk. TxShield provides heuristic analysis but does not guarantee absolute safety against zero-day exploits.

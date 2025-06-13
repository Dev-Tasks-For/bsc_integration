# BSC Transactions API

A NestJS REST service for collecting and storing Binance Smart Chain transaction data, and fetching BNB and USDT balances.

## Features

- **NestJS** + **TypeORM**  
- **PostgreSQL** with migration support via TypeORM CLI  
- **@nestjs/throttler** for rate limiting  
- **Ethers.js** to connect to BSC RPC endpoint  
- Stores transactions in a `transaction` table  
- Retrieves BNB and USDT balances for any wallet address  

---

## 🛠️ Prerequisites

- Node.js ≥ 18  
- npm ≥ 8 or Yarn ≥ 1.22  
- PostgreSQL ≥ 13 

---

## 🚀 Installation

1. **Clone the repository**  
2. **Install dependencies**

3. **Create a `.env` file at the project root:**  
   ```bash
   DB_HOST=localhost
   DB_PORT=5432
   DB_USER=YOUR_USERNAME
   DB_PASS=YOUR_PASSWORD
   DB_NAME=YOUR_BD

   ETH_RPC_URL=https://ethereum-rpc.publicnode.com
   ETHERSCAN_API_KEY=<YOUR_API_KEY>
   BSC_RPC_URL=https://bsc-dataseed.binance.org/
   BSCSCAN_API_KEY=<YOUR_API_KEY>

## Database Migrations
- Generate a new migration 
  ```bash
   npm run migration:generate
- Run pending migrations
  ```bash
   npm run migration:run
- Revert last migration 
  ```bash
   npm run migration:revert
## Running the Application
- Development mode (watch + hot reload): 
  ```bash
   npm run start:dev
- Production build and start:
  ```bash
   npm run build
   npm run start:prod
## API Endpoints
| Method   | Path   | Description   |
| ---------- | -------- | -------- |
| GET | `/web3/balance/bnb/:address` | Fetch BNB balance of a wallet |
| GET | `/web3/balance/usdt/:address` | Fetch USDT balance of a wallet |
| POST | `/web3/tx/:txHash` | Fetch transaction details by hash and save |

## Examples
  ```bash
   # Fetch BNB balance
curl http://localhost:3000/web3/balance/bnb/YourWalletAddress

# Fetch USDT balance
curl http://localhost:3000/web3/balance/usdt/YourWalletAddress

# Save a transaction by hash
curl -X POST http://localhost:3000/web3/tx/TransactionHash

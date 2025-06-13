import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract, utils } from 'ethers';
import axios from 'axios';

import { Transaction } from 'src/transactions/transaction.entity';

type Network = 'eth' | 'bsc';

interface NetConfig {
  rpcUrl: string;
  nativeSymbol: string;
  usdtAddress: string;
  scanBase: string;
  scanKey: string;
}

const NETWORKS: Record<Network, NetConfig> = {
  eth: {
    rpcUrl:       process.env.ETH_RPC_URL  ?? 'https://ethereum.publicnode.com',
    nativeSymbol: 'ETH',
    usdtAddress:  '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    scanBase:     'https://api.etherscan.io',
    scanKey:      process.env.ETHERSCAN_API_KEY ?? '',
  },
  bsc: {
    rpcUrl:       process.env.BSC_RPC_URL  ?? 'https://bsc-dataseed.binance.org/',
    nativeSymbol: 'BNB',
    usdtAddress:  '0x55d398326f99059fF775485246999027B3197955',
    scanBase:     'https://api.bscscan.com',
    scanKey:      process.env.BSCSCAN_API_KEY  ?? '',
  },
};

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSITED_TOPIC      = utils.id('Deposited(address,uint256)');
const USER_OP_EVENT_TOPIC  = utils.id('UserOperationEvent(bytes32,address,address,address,uint256,uint256)');
const DEPOSIT_FOR_SIG      = utils.id('depositFor(address)').slice(0, 10);
const DEPOSIT_SIG          = utils.id('deposit(address,address,uint256)').slice(0, 10);

const ENTRYPOINT_FALLBACK = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'; 

interface ParsedTransfer { from: string; to: string; value: string; tokenAddress: string; }
@Injectable()
export class Web3Service implements OnModuleInit {
  private readonly provider: JsonRpcProvider;
  private readonly nativeSymbol: string;
  private readonly USDT_ADDRESS: string;
  private readonly scanBase: string;
  private readonly scanKey: string;

  private entryPointAddress = ENTRYPOINT_FALLBACK.toLowerCase();

  constructor(
    @InjectRepository(Transaction)
    private readonly txRepo: Repository<Transaction>,
  ) {
    const net: Network = (process.env.NETWORK as Network) ?? 'bsc';
    const cfg          = NETWORKS[net];

    this.provider      = new JsonRpcProvider(cfg.rpcUrl);
    this.nativeSymbol  = cfg.nativeSymbol;
    this.USDT_ADDRESS  = cfg.usdtAddress;
    this.scanBase      = cfg.scanBase;
    this.scanKey       = cfg.scanKey;
  }

  async onModuleInit(): Promise<void> {
    try {
      const list: string[] = await this.provider.send('eth_supportedEntryPoints', []);
      if (list.length) this.entryPointAddress = list[0].toLowerCase();
    } catch {}
  }

  async fetchTransaction(txHash: string): Promise<Transaction> {
    const tx      = await this.provider.getTransaction(txHash);
    if (!tx) throw new NotFoundException('Transaction not found');
    const receipt = await this.provider.getTransactionReceipt(txHash);

    if (tx.value.gt(0)) return this.handleNativeTransfer(tx);

    if (tx.to?.toLowerCase() === this.entryPointAddress) {
      const aa = await this.handleEntryPointTransaction(tx, receipt);
      if (aa) return aa;
    }

    const detectedPM = this.extractPaymasterFromReceipt(receipt);
    const paymaster  = (process.env.PAYMASTER_ADDRESS ?? '').toLowerCase() || detectedPM;
    if (paymaster && tx.to?.toLowerCase() === paymaster) {
      const pm = await this.handlePaymasterTransaction(tx, receipt);
      if (pm) return pm;
    }

    const erc = await this.handleErc20Transfer(tx, receipt);
    if (erc) return erc;

    const scan = await this.handleScanTransaction(txHash);
    if (scan) return scan;

    throw new NotFoundException('No supported transfer found in this transaction');
  }
  private async handleNativeTransfer(tx: any): Promise<Transaction> {
    return this.createEntity({
      txHash: tx.hash, from: tx.from, to: tx.to,
      amount: utils.formatEther(tx.value),
      currency: this.nativeSymbol,
      date: new Date(),
    });
  }

  private async handleEntryPointTransaction(tx: any, receipt: any): Promise<Transaction | null> {
    const transfers = this.extractTransfers(receipt.logs);
    if (transfers.length) return this.saveTransfer(tx.hash, transfers[0]);

    const dep = receipt.logs.find((l: any) => l.topics[0] === DEPOSITED_TOPIC);
    if (dep) {
      return this.createEntity({
        txHash: tx.hash, from: tx.from, to: '0x' + dep.topics[1].slice(26),
        amount: utils.formatEther(dep.data),
        currency: this.nativeSymbol,
        date: new Date(),
      });
    }
    return null;
  }

  private async handlePaymasterTransaction(tx: any, receipt: any): Promise<Transaction | null> {
    const transfers = this.extractTransfers(receipt.logs);
    if (transfers.length) return this.saveTransfer(tx.hash, transfers[0]);

    const sig = tx.data.slice(0, 10);
    if ([DEPOSIT_FOR_SIG, DEPOSIT_SIG].includes(sig)) {
      const iface = new utils.Interface([
        'function depositFor(address account) payable',
        'function deposit(address token,address account,uint256 amount)',
      ]);
      try {
        const dec = iface.parseTransaction({ data: tx.data, value: tx.value });
        if (dec.name === 'depositFor') {
          return this.createEntity({
            txHash: tx.hash, from: tx.from, to: dec.args.account,
            amount: utils.formatEther(tx.value),
            currency: this.nativeSymbol,
            date: new Date(),
          });
        }
        if (dec.name === 'deposit') {
          const token = await this.getTokenInfo(dec.args.token);
          return this.createEntity({
            txHash: tx.hash, from: tx.from, to: dec.args.account,
            amount: utils.formatUnits(dec.args.amount, token.decimals),
            currency: token.symbol,
            tokenAddress: dec.args.token,
            date: new Date(),
          });
        }
      } catch {}
    }
    return null;
  }

  private async handleErc20Transfer(tx: any, receipt: any): Promise<Transaction | null> {
    const transfers = this.extractTransfers(receipt.logs);
    if (!transfers.length) return null;
    return this.saveTransfer(tx.hash, transfers[0]);
  }

  private async handleScanTransaction(txHash: string): Promise<Transaction | null> {
    try {
      const urlInternal = `${this.scanBase}/api?module=account&action=txlistinternal` +
                          `&txhash=${txHash}&apikey=${this.scanKey}`;
      const { data: i } = await axios.get(urlInternal);
      if (i.status === '1' && i.result.length) {
        const itx = i.result[0];
        return this.createEntity({
          txHash,
          from: itx.from,
          to:   itx.to,
          amount: utils.formatEther(itx.value),
          currency: this.nativeSymbol,
          date: new Date(+itx.timeStamp * 1000),
        });
      }

      const urlToken = `${this.scanBase}/api?module=account&action=tokentx` +
                       `&txhash=${txHash}&apikey=${this.scanKey}`;
      const { data: t } = await axios.get(urlToken);
      if (t.status === '1' && t.result.length) {
        const d = t.result[0];
        return this.createEntity({
          txHash,
          from: d.from,
          to:   d.to,
          amount: utils.formatUnits(d.value, parseInt(d.tokenDecimal) || 18),
          currency: d.tokenSymbol,
          tokenAddress: d.contractAddress,
          date: new Date(+d.timeStamp * 1000),
        });
      }
    } catch (e) {
      console.error('Scan API error', e);
    }
    return null;
  }

  private extractTransfers(logs: any[]): ParsedTransfer[] {
    return logs
      .filter(l => l.topics[0] === ERC20_TRANSFER_TOPIC && l.topics.length === 3)
      .map(l => ({
        from:        '0x' + l.topics[1].slice(26),
        to:          '0x' + l.topics[2].slice(26),
        value:       l.data,
        tokenAddress: l.address,
      }));
  }

  private extractPaymasterFromReceipt(receipt: any): string | null {
    const log = receipt.logs.find((l: any) => l.topics[0] === USER_OP_EVENT_TOPIC);
    return log ? ('0x' + log.topics[3].slice(26)).toLowerCase() : null;
  }

  private async saveTransfer(txHash: string, t: ParsedTransfer): Promise<Transaction> {
    const token = await this.getTokenInfo(t.tokenAddress);
    return this.createEntity({
      txHash,
      from: t.from,
      to:   t.to,
      amount: utils.formatUnits(t.value, token.decimals),
      currency: token.symbol,
      tokenAddress: t.tokenAddress,
      date: new Date(),
    });
  }

  private async createEntity(data: {
    txHash: string; from: string; to: string; amount: string;
    currency: string; date: Date; tokenAddress?: string;
  }): Promise<Transaction> {
    const ent = this.txRepo.create({
      txHash:           data.txHash,
      fromWalletAddress: data.from,
      toWalletAddress:   data.to,
      amount:   data.amount,
      currency: data.currency,
      date:     data.date,
    });
    return this.txRepo.save(ent);
  }

  private async getTokenInfo(addr: string): Promise<{ symbol: string; decimals: number }> {
    try {
      const erc = new Contract(addr, [
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
      ], this.provider);
      const [symbol, dec] = await Promise.all([
        erc.symbol().catch(() => 'UNKNOWN'),
        erc.decimals().catch(() => 18),
      ]);
      return { symbol, decimals: dec };
    } catch {
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }

  async getNativeBalance(wallet: string): Promise<string> {
    return utils.formatEther(await this.provider.getBalance(wallet));
  }
  async getUSDTBalance(wallet: string): Promise<string> {
    const erc = new Contract(this.USDT_ADDRESS, [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ], this.provider);
    const [raw, dec] = await Promise.all([erc.balanceOf(wallet), erc.decimals()]);
    return utils.formatUnits(raw, dec);
  }
}

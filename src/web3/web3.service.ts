import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {StaticJsonRpcProvider, JsonRpcProvider} from '@ethersproject/providers';
import { Contract, utils } from 'ethers';
import axios from 'axios';

import { Transaction } from 'src/common/entities/transaction.entity';

type NetName = 'eth' | 'bsc';

interface NetConfig {
  name: NetName;
  provider: StaticJsonRpcProvider;
  native: string;          
  usdt: string;           
  scanBase: string;        
  scanKey: string;
  chainId: number;
}

const NETWORKS: NetConfig[] = [
  {
    name: 'eth',
    provider: new StaticJsonRpcProvider(
      process.env.ETH_RPC_URL ?? 'https://cloudflare-eth.com',
      { name: 'homestead', chainId: 1 },
    ),
    native: 'ETH',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    scanBase: 'https://api.etherscan.io',
    scanKey: process.env.ETHERSCAN_API_KEY ?? '',
    chainId: 1,
  },
  {
    name: 'bsc',
    provider: new StaticJsonRpcProvider(
      process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org/',
      { name: 'bsc', chainId: 56 },
    ),
    native: 'BNB',
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    scanBase: 'https://api.bscscan.com',
    scanKey: process.env.BSCSCAN_API_KEY ?? '',
    chainId: 56,
  },
];

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSITED_TOPIC = utils.id('Deposited(address,uint256)');
const USER_OP_EVENT_TOPIC = utils.id(
  'UserOperationEvent(bytes32,address,address,address,uint256,uint256)',
);
const DEPOSIT_FOR_SIG = utils.id('depositFor(address)').slice(0, 10);
const DEPOSIT_SIG = utils.id('deposit(address,address,uint256)').slice(0, 10);

const ENTRYPOINT_FALLBACK =
  '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'; 

interface ParsedTransfer {
  from: string;
  to: string;
  value: string;
  tokenAddress: string;
}

@Injectable()
export class Web3Service {
  constructor(
    @InjectRepository(Transaction)
    private readonly txRepo: Repository<Transaction>,
  ) {}

  private async detectNetwork(txHash: string): Promise<NetConfig> {
    const attempts = NETWORKS.map(async (net) => {
      try {
        const tx = await net.provider.getTransaction(txHash);
        return tx ? net : null;
      } catch {
        return null;
      }
    });
    const found = (await Promise.all(attempts)).find(Boolean);
    if (!found)
      throw new NotFoundException('Transaction not found in supported networks');
    return found;
  }

  async fetchTransaction(txHash: string): Promise<Transaction> {
    const net = await this.detectNetwork(txHash);

    const provider = net.provider;
    const tx = await provider.getTransaction(txHash);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (tx.value.gt(0))
      return this.handleNativeTransfer(net, tx);


    const entryPointAddr = ENTRYPOINT_FALLBACK.toLowerCase();
    if (tx.to?.toLowerCase() === entryPointAddr) {
      const aa = await this.handleEntryPointTransaction(net, tx, receipt);
      if (aa) return aa;
    }


    const detectedPM = this.extractPaymasterFromReceipt(receipt);
    const paymaster =
      (process.env.PAYMASTER_ADDRESS ?? '').toLowerCase() || detectedPM;
    if (paymaster && tx.to?.toLowerCase() === paymaster) {
      const pm = await this.handlePaymasterTransaction(net, tx, receipt);
      if (pm) return pm;
    }


    const erc = await this.handleErc20Transfer(net, tx, receipt);
    if (erc) return erc;


    const scan = await this.handleScanTransaction(net, txHash);
    if (scan) return scan;

    throw new NotFoundException(
      'No supported transfer found in this transaction',
    );
  }

  private async handleNativeTransfer(
    net: NetConfig,
    tx: any,
  ): Promise<Transaction> {
    return this.createEntity({
      txHash: tx.hash,
      from: tx.from,
      to: tx.to,
      amount: utils.formatEther(tx.value),
      currency: net.native,
      date: new Date(),
    });
  }

  private async handleEntryPointTransaction(
    net: NetConfig,
    tx: any,
    receipt: any,
  ): Promise<Transaction | null> {
    const transfers = this.extractTransfers(receipt.logs);
    if (transfers.length) return this.saveTransfer(net, tx.hash, transfers[0]);

    const dep = receipt.logs.find((l: any) => l.topics[0] === DEPOSITED_TOPIC);
    if (dep) {
      return this.createEntity({
        txHash: tx.hash,
        from: tx.from,
        to: '0x' + dep.topics[1].slice(26),
        amount: utils.formatEther(dep.data),
        currency: net.native,
        date: new Date(),
      });
    }
    return null;
  }

  private async handlePaymasterTransaction(
    net: NetConfig,
    tx: any,
    receipt: any,
  ): Promise<Transaction | null> {
    const transfers = this.extractTransfers(receipt.logs);
    if (transfers.length) return this.saveTransfer(net, tx.hash, transfers[0]);

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
            txHash: tx.hash,
            from: tx.from,
            to: dec.args.account,
            amount: utils.formatEther(tx.value),
            currency: net.native,
            date: new Date(),
          });
        }
        if (dec.name === 'deposit') {
          const token = await this.getTokenInfo(net.provider, dec.args.token);
          return this.createEntity({
            txHash: tx.hash,
            from: tx.from,
            to: dec.args.account,
            amount: utils.formatUnits(dec.args.amount, token.decimals),
            currency: token.symbol,
            tokenAddress: dec.args.token,
            date: new Date(),
          });
        }
      } catch {
      }
    }
    return null;
  }

  private async handleErc20Transfer(
    net: NetConfig,
    tx: any,
    receipt: any,
  ): Promise<Transaction | null> {
    const transfers = this.extractTransfers(receipt.logs);
    if (!transfers.length) return null;
    return this.saveTransfer(net, tx.hash, transfers[0]);
  }

  private async handleScanTransaction(
    net: NetConfig,
    txHash: string,
  ): Promise<Transaction | null> {
    try {
      const urlInternal =
        `${net.scanBase}/api?module=account&action=txlistinternal` +
        `&txhash=${txHash}&apikey=${net.scanKey}`;
      const { data: i } = await axios.get(urlInternal);
      if (i.status === '1' && i.result.length) {
        const itx = i.result[0];
        return this.createEntity({
          txHash,
          from: itx.from,
          to: itx.to,
          amount: utils.formatEther(itx.value),
          currency: net.native,
          date: new Date(+itx.timeStamp * 1000),
        });
      }

      const urlToken =
        `${net.scanBase}/api?module=account&action=tokentx` +
        `&txhash=${txHash}&apikey=${net.scanKey}`;
      const { data: t } = await axios.get(urlToken);
      if (t.status === '1' && t.result.length) {
        const d = t.result[0];
        return this.createEntity({
          txHash,
          from: d.from,
          to: d.to,
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
      .filter(
        (l) => l.topics[0] === ERC20_TRANSFER_TOPIC && l.topics.length === 3,
      )
      .map((l) => ({
        from: '0x' + l.topics[1].slice(26),
        to: '0x' + l.topics[2].slice(26),
        value: l.data,
        tokenAddress: l.address,
      }));
  }

  private extractPaymasterFromReceipt(receipt: any): string | null {
    const log = receipt.logs.find((l: any) => l.topics[0] === USER_OP_EVENT_TOPIC);
    return log ? ('0x' + log.topics[3].slice(26)).toLowerCase() : null;
  }

  private async saveTransfer(
    net: NetConfig,
    txHash: string,
    t: ParsedTransfer,
  ): Promise<Transaction> {
    const token = await this.getTokenInfo(net.provider, t.tokenAddress);
    return this.createEntity({
      txHash,
      from: t.from,
      to: t.to,
      amount: utils.formatUnits(t.value, token.decimals),
      currency: token.symbol,
      tokenAddress: t.tokenAddress,
      date: new Date(),
    });
  }

  private async getTokenInfo(
    provider: JsonRpcProvider,
    addr: string,
  ): Promise<{ symbol: string; decimals: number }> {
    try {
      const erc = new Contract(
        addr,
        [
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ],
        provider,
      );
      const [symbol, dec] = await Promise.all([
        erc.symbol().catch(() => 'UNKNOWN'),
        erc.decimals().catch(() => 18),
      ]);
      return { symbol, decimals: dec };
    } catch {
      return { symbol: 'UNKNOWN', decimals: 18 };
    }
  }

  private async createEntity(data: {
    txHash: string;
    from: string;
    to: string;
    amount: string;
    currency: string;
    date: Date;
    tokenAddress?: string;
  }): Promise<Transaction> {
    const ent = this.txRepo.create({
      txHash: data.txHash,
      fromWalletAddress: data.from,
      toWalletAddress: data.to,
      amount: data.amount,
      currency: data.currency,
      date: data.date,
    });
    return this.txRepo.save(ent);
  }

  async getNativeBalance(
    wallet: string,
    netName: NetName = 'eth',
  ): Promise<string> {
    const net = NETWORKS.find((n) => n.name === netName);
    if (!net)
      throw new NotFoundException(`Unsupported network: ${netName as string}`);
    const raw = await net.provider.getBalance(wallet);
    return utils.formatEther(raw);
  }

  async getUSDTBalance(
    wallet: string,
    netName: NetName = 'eth',
  ): Promise<string> {
    const net = NETWORKS.find((n) => n.name === netName);
    if (!net)
      throw new NotFoundException(`Unsupported network: ${netName as string}`);

    const erc = new Contract(
      net.usdt,
      [
        'function balanceOf(address) view returns (uint256)',
        'function decimals()   view returns (uint8)',
      ],
      net.provider,
    );
    const [raw, dec] = await Promise.all([erc.balanceOf(wallet), erc.decimals()]);
    return utils.formatUnits(raw, dec);
  }
}

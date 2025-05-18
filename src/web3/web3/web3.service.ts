import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transaction } from 'src/transactions/transaction.entity';
import { Repository } from 'typeorm';

import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract } from 'ethers';
import { formatUnits, formatEther } from 'ethers/lib/utils'

const BSC_RPC = 'https://bsc-dataseed.binance.org/';

@Injectable()
export class Web3Service {
  private provider: JsonRpcProvider;
  private USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

  constructor(
    @InjectRepository(Transaction)
    private txRepo: Repository<Transaction>,
  ) {
    this.provider = new JsonRpcProvider(process.env.BSC_RPC_URL
      ?? 'https://bsc-dataseed.binance.org/');
  }

  // 1) Fetch Transaction Details and save to DB
  async fetchTransaction(txHash: string): Promise<Transaction> {
    const tx = await this.provider.getTransaction(txHash);
    if (!tx) throw new NotFoundException('Transaction not found on BSC');

    // При бажанні витягнути дату блоку: 
    // const block = await this.provider.getBlock(tx.blockNumber!);
    // const timestamp = new Date(block.timestamp * 1000);

    const entity = this.txRepo.create({
      date: new Date(),
      txHash,
      fromWalletAddress: tx.from,
      toWalletAddress: tx.to,
      amount: formatUnits(tx.value, 18),
      currency: 'BNB',
    });
    return this.txRepo.save(entity);
  }

  // 2) Get BNB balance
  async getBNBBalance(walletAddress: string): Promise<string> {
    const balance = await this.provider.getBalance(walletAddress);
    return formatEther(balance);
  }

  // 3) Get USDT balance (BEP-20)
  async getUSDTBalance(walletAddress: string): Promise<string> {
    const abi = [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ];
    const contract = new Contract(this.USDT_ADDRESS, abi, this.provider);
    const [raw, decimals] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
    ]);
    return formatUnits(raw, decimals);
  }
}


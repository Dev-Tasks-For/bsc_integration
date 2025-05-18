import { Controller, Get, Param, Post } from '@nestjs/common';
import { Web3Service } from './web3.service';
import { Transaction } from 'src/transactions/transaction.entity';
import { Throttle } from '@nestjs/throttler';

@Controller('web3')
export class Web3Controller {
  constructor(private readonly web3Service: Web3Service) {}

  @Post('tx/:txHash')
  @Throttle({ default: { limit: 5, ttl: 60 } }) 
  async fetchTransaction(@Param('txHash') txHash: string): Promise<Transaction> {
    return this.web3Service.fetchTransaction(txHash);
  }

  @Get('balance/bnb/:address')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async getBNBBalance(@Param('address') address: string): Promise<{ balance: string }> {
    const balance = await this.web3Service.getBNBBalance(address);
    return { balance };
  }

  @Get('balance/usdt/:address')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async getUSDTBalance(@Param('address') address: string): Promise<{ balance: string }> {
    const balance = await this.web3Service.getUSDTBalance(address);
    return { balance };
  }
}


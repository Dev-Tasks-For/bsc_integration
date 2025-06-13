import { Controller, Get, Param, Post,Query } from '@nestjs/common';
import { Web3Service } from './web3.service';
import { Transaction } from 'src/common/entities/transaction.entity';
import { Throttle } from '@nestjs/throttler';

type NetName = 'eth' | 'bsc';

@Controller('web3')
export class Web3Controller {
  constructor(private readonly web3Service: Web3Service) {}

  @Post('tx/:txHash')
  @Throttle({ default: { limit: 5, ttl: 60 } }) 
  async fetchTransaction(@Param('txHash') txHash: string): Promise<Transaction> {
    return this.web3Service.fetchTransaction(txHash);
  }

  @Get('native/:address')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async nativeBalance(
    @Param('address') address: string,
    @Query('net') net: NetName = 'bsc',
  ) {
    const balance = await this.web3Service.getNativeBalance(address, net);
    return { network: net, native: balance };
  }

  @Get('usdt/:address')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async usdtBalance(
    @Param('address') address: string,
    @Query('net') net: NetName = 'bsc',
  ) {
    const balance = await this.web3Service.getUSDTBalance(address, net);
    return { network: net, usdt: balance };
  }
}


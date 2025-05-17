import { Module } from '@nestjs/common';
import { Web3Service } from './web3/web3.service';
import { Web3Controller } from './web3/web3.controller';

@Module({
  providers: [Web3Service],
  controllers: [Web3Controller]
})
export class Web3Module {}

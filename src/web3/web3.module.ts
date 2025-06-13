import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Web3Service } from './web3.service';
import { Web3Controller } from './web3.controller';
import { Transaction } from '../common/entities/transaction.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction]),
  ],
  providers: [Web3Service],
  controllers: [Web3Controller],
})
export class Web3Module {}

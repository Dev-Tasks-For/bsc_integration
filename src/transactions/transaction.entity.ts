import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class Transaction {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'timestamp' })
  date: Date;

  @Column({ unique: true })
  txHash: string;

  @Column()
  fromWalletAddress: string;

  @Column()
  toWalletAddress: string;

  @Column({ type: 'decimal', precision: 30, scale: 18 })
  amount: string;

  @Column()
  currency: string;
}

import { DataSource } from 'typeorm';
import { Transaction } from './transactions/transaction.entity';
import * as dotenv from 'dotenv';
dotenv.config();

console.log('DB_PASS is:', JSON.stringify(process.env.DB_PASS));


export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  entities: [Transaction],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'migrations',
  synchronize: false,  
  logging: false,
});

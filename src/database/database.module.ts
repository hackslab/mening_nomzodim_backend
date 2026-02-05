import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { UZBEKISTAN_TIMEZONE } from '../common/time';

export const DRIZZLE = 'DRIZZLE_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const connectionString = configService.get<string>('DB_URL');
        const pool = new Pool({
          connectionString,
          options: `-c timezone=${UZBEKISTAN_TIMEZONE}`,
        });
        pool.on('connect', async (client) => {
          await client.query(`SET TIME ZONE '${UZBEKISTAN_TIMEZONE}'`);
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}

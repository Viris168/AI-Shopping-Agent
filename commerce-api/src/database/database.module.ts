import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTITIES } from './entities.js';
import { dataSourceOptions } from './options.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: () => dataSourceOptions() }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}

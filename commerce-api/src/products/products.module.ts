import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module.js';
import {
  CategoriesController,
  ProductsController,
} from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [SearchModule],
  controllers: [ProductsController, CategoriesController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}

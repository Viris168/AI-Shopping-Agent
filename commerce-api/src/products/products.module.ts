import { Module } from '@nestjs/common';
import {
  CategoriesController,
  ProductsController,
} from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  controllers: [ProductsController, CategoriesController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}

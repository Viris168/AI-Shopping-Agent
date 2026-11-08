import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { ProductsModule } from '../products/products.module.js';
import { CartController, CheckoutController } from './cart.controller.js';
import { CartService } from './cart.service.js';

@Module({
  imports: [ProductsModule, OrdersModule],
  controllers: [CartController, CheckoutController],
  providers: [CartService],
})
export class CartModule {}

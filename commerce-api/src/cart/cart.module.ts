import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProductsModule } from '../products/products.module.js';
import { CartController, CheckoutController } from './cart.controller.js';
import { CartService } from './cart.service.js';

@Module({
  imports: [ProductsModule, OrdersModule, PaymentsModule],
  controllers: [CartController, CheckoutController],
  providers: [CartService],
})
export class CartModule {}

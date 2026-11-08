import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  JwtAuthGuard,
  type AuthUser,
} from '../auth/auth.guards.js';
import {
  AddCartItemDto,
  ApplyCouponDto,
  UpdateCartItemDto,
} from './cart.dto.js';
import { CartService } from './cart.service.js';

@ApiTags('cart')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  view(@CurrentUser() user: AuthUser) {
    return this.cart.view(user.id);
  }

  @Post('items')
  @HttpCode(200)
  add(@CurrentUser() user: AuthUser, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(user.id, dto.productId, dto.quantity);
  }

  @Patch('items/:productId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('productId') productId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cart.updateItem(user.id, productId, dto.quantity);
  }

  @Delete('items/:productId')
  remove(@CurrentUser() user: AuthUser, @Param('productId') productId: string) {
    return this.cart.removeItem(user.id, productId);
  }

  @Post('coupon')
  @HttpCode(200)
  coupon(@CurrentUser() user: AuthUser, @Body() dto: ApplyCouponDto) {
    return this.cart.applyCoupon(user.id, dto.code);
  }
}

/** Storefront only: the agent never calls this (docs/AGENT.md §3). */
@ApiTags('cart')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly cart: CartService) {}

  @Post()
  checkout(@CurrentUser() user: AuthUser) {
    return this.cart.checkout(user.id);
  }
}

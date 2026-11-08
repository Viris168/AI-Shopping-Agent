import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Most of one product a cart line can hold, across repeated adds too. */
export const MAX_QTY_PER_ITEM = 20;

export class AddCartItemDto {
  /** Product UUID, SKU or slug. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  productId: string;

  @IsInt()
  @Min(1)
  @Max(MAX_QTY_PER_ITEM)
  quantity = 1;
}

export class UpdateCartItemDto {
  /** 0 removes the item. */
  @IsInt()
  @Min(0)
  @Max(MAX_QTY_PER_ITEM)
  quantity: number;
}

export class ApplyCouponDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  code: string;
}

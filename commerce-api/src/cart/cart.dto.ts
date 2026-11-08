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

export class AddCartItemDto {
  /** Product UUID, SKU or slug. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  productId: string;

  @IsInt()
  @Min(1)
  @Max(20)
  quantity = 1;
}

export class UpdateCartItemDto {
  /** 0 removes the item. */
  @IsInt()
  @Min(0)
  @Max(20)
  quantity: number;
}

export class ApplyCouponDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  code: string;
}

import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const PRODUCT_SORTS = [
  'relevance',
  'price_asc',
  'price_desc',
  'rating',
  'newest',
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SearchProductsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Category slug, e.g. "shoes". */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  brand?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  minPriceCents?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  maxPriceCents?: number;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean({ message: 'inStock must be true or false' })
  inStock?: boolean;

  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort: ProductSort = 'relevance';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 10;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset = 0;
}

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SearchProductsDto } from './products.dto.js';
import { ProductsService } from './products.service.js';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  search(@Query() query: SearchProductsDto) {
    return this.products.search(query);
  }

  @Get(':idOrSlug')
  findOne(@Param('idOrSlug') idOrSlug: string) {
    return this.products.findOne(idOrSlug);
  }

  @Get(':idOrSlug/recommendations')
  recommendations(@Param('idOrSlug') idOrSlug: string) {
    return this.products.recommendations(idOrSlug);
  }
}

@ApiTags('products')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list() {
    return this.products.categories();
  }
}

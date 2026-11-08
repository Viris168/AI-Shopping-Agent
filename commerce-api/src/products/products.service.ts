import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import { searchTerms } from '../common/search.js';
import { Category, Product } from '../database/entities.js';
import type { SearchProductsDto } from './products.dto.js';
import { toProductDetail, toProductListItem } from './products.mapper.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoriesRepo: Repository<Category>,
  ) {}

  async search(dto: SearchProductsDto) {
    const qb = this.active();
    const terms = searchTerms(dto.q ?? '');
    // Every term must match somewhere: name, description, brand, category or tags.
    terms.forEach((term, i) => {
      qb.andWhere(
        `(p.name ILIKE :t${i} OR p.description ILIKE :t${i} OR p.brand ILIKE :t${i} OR c.name ILIKE :t${i} OR array_to_string(p.tags, ' ') ILIKE :t${i})`,
        { [`t${i}`]: `%${term}%` },
      );
    });
    if (dto.category)
      qb.andWhere('c.slug = :category', {
        category: dto.category.toLowerCase(),
      });
    if (dto.brand)
      qb.andWhere('lower(p.brand) = lower(:brand)', { brand: dto.brand });
    if (dto.minPriceCents !== undefined)
      qb.andWhere('p.priceCents >= :min', { min: dto.minPriceCents });
    if (dto.maxPriceCents !== undefined)
      qb.andWhere('p.priceCents <= :max', { max: dto.maxPriceCents });
    if (dto.inStock !== undefined)
      qb.andWhere(dto.inStock ? 'p.stock > 0' : 'p.stock = 0');

    switch (dto.sort) {
      case 'price_asc':
        qb.orderBy('p.priceCents', 'ASC');
        break;
      case 'price_desc':
        qb.orderBy('p.priceCents', 'DESC');
        break;
      case 'rating':
        qb.orderBy('p.rating', 'DESC');
        break;
      case 'newest':
        qb.orderBy('p.createdAt', 'DESC');
        break;
      default:
        // Relevance: terms found in the product name first, then rating.
        if (terms.length > 0) {
          const nameHits = terms
            .map((_, i) => `(p.name ILIKE :t${i})::int`)
            .join(' + ');
          qb.addSelect(nameHits, 'name_hits').orderBy('name_hits', 'DESC');
        }
        qb.addOrderBy('p.rating', 'DESC');
    }
    qb.addOrderBy('p.name', 'ASC');

    const [rows, total] = await qb
      .offset(dto.offset)
      .limit(dto.limit)
      .getManyAndCount();
    return { total, items: rows.map(toProductListItem) };
  }

  async findOne(idOrSlug: string) {
    return toProductDetail(await this.find(idOrSlug));
  }

  /** Same category or a shared tag, in stock, 0.5×–1.8× the price, top rated. */
  async recommendations(idOrSlug: string) {
    const base = await this.find(idOrSlug);
    const items = await this.active()
      .andWhere('p.id <> :id', { id: base.id })
      .andWhere('p.stock > 0')
      .andWhere('(p.categoryId = :categoryId OR p.tags && :tags)', {
        categoryId: base.categoryId,
        tags: base.tags,
      })
      .andWhere('p.priceCents BETWEEN :lo AND :hi', {
        lo: Math.floor(base.priceCents * 0.5),
        hi: Math.ceil(base.priceCents * 1.8),
      })
      .orderBy('p.rating', 'DESC')
      .addOrderBy('p.name', 'ASC')
      .limit(4)
      .getMany();
    return { basedOn: base.name, items: items.map(toProductListItem) };
  }

  categories() {
    return this.categoriesRepo.find({
      select: { name: true, slug: true },
      order: { name: 'ASC' },
    });
  }

  /** Product by UUID, slug or SKU, with its category; 404 otherwise. Active only unless asked. */
  async find(
    idOrSlug: string,
    { includeInactive = false } = {},
  ): Promise<Product> {
    const key = idOrSlug.trim();
    const qb = includeInactive
      ? this.products
          .createQueryBuilder('p')
          .innerJoinAndSelect('p.category', 'c')
      : this.active();
    if (UUID.test(key)) qb.andWhere('p.id = :key', { key });
    else
      qb.andWhere('(p.slug = lower(:key) OR upper(p.sku) = upper(:key))', {
        key,
      });
    const product = await qb.getOne();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private active(): SelectQueryBuilder<Product> {
    return this.products
      .createQueryBuilder('p')
      .innerJoinAndSelect('p.category', 'c')
      .where('p.isActive = true');
  }
}

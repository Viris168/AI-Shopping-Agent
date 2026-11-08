import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import { searchTerms } from '../common/search.js';
import { Category, Product } from '../database/entities.js';
import { toVectorLiteral } from '../search/embedding.js';
import { rrf } from '../search/rrf.js';
import { EmbeddingService } from '../search/search.module.js';
import type { ProductSort, SearchProductsDto } from './products.dto.js';
import { toProductDetail, toProductListItem } from './products.mapper.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEYWORD_CANDIDATES = 500;
const VECTOR_CANDIDATES = 50;
/**
 * Calibrated on the seed catalog (test/search.e2e-spec.ts). Casual wording scores 0.59+ on the
 * right product ("something to keep my coffee hot" → water bottle, 0.591); things the store
 * doesn't sell score below (pizza 0.51, dog food 0.55, sunglasses 0.575).
 */
export const PRODUCT_MIN_SIMILARITY = 0.58;
/** Vector matches must also be this close to the best one; products cluster at 0.6-0.7. */
export const PRODUCT_SIMILARITY_BAND = 0.08;

/** Every term must match somewhere: name, description, brand, category or tags. */
function matchTerms(qb: SelectQueryBuilder<Product>, terms: string[]) {
  terms.forEach((term, i) => {
    qb.andWhere(
      `(p.name ILIKE :t${i} OR p.description ILIKE :t${i} OR p.brand ILIKE :t${i} OR c.name ILIKE :t${i} OR array_to_string(p.tags, ' ') ILIKE :t${i})`,
      { [`t${i}`]: `%${term}%` },
    );
  });
}

function sortBy(
  qb: SelectQueryBuilder<Product>,
  sort: ProductSort,
  terms: string[],
) {
  switch (sort) {
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
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoriesRepo: Repository<Category>,
    private readonly embeddings: EmbeddingService,
  ) {}

  /**
   * Hybrid when there is a query and the model is available: keyword matches and vector matches
   * (src/search/), fused by rank. Otherwise keyword search alone. Filters always apply to both.
   */
  async search(dto: SearchProductsDto) {
    const terms = searchTerms(dto.q ?? '');
    const embedding = dto.q ? await this.embeddings.embedQuery(dto.q) : null;
    return embedding
      ? this.hybridSearch(dto, terms, embedding)
      : this.keywordSearch(dto, terms);
  }

  private async keywordSearch(dto: SearchProductsDto, terms: string[]) {
    const qb = this.filtered(dto);
    matchTerms(qb, terms);
    sortBy(qb, dto.sort, terms);
    const [rows, total] = await qb
      .offset(dto.offset)
      .limit(dto.limit)
      .getManyAndCount();
    return { total, items: rows.map(toProductListItem) };
  }

  private async hybridSearch(
    dto: SearchProductsDto,
    terms: string[],
    embedding: number[],
  ) {
    const [vector, keyword] = await Promise.all([
      this.vectorIds(dto, embedding),
      this.keywordIds(dto, terms),
    ]);
    // Vector first: a tie goes to the semantic match (see FaqService.search).
    const ids = rrf([vector, keyword]).map((f) => f.id);
    if (ids.length === 0) return { total: 0, items: [] };

    if (dto.sort !== 'relevance') {
      // An explicit sort orders the matches; fusion only decides which products match.
      const qb = this.active().andWhere('p.id IN (:...ids)', { ids });
      sortBy(qb, dto.sort, []);
      const rows = await qb.offset(dto.offset).limit(dto.limit).getMany();
      return { total: ids.length, items: rows.map(toProductListItem) };
    }

    const page = ids.slice(dto.offset, dto.offset + dto.limit);
    if (page.length === 0) return { total: ids.length, items: [] };
    const rows = await this.active()
      .andWhere('p.id IN (:...page)', { page })
      .getMany();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      total: ids.length,
      items: page.flatMap((id) => {
        const row = byId.get(id);
        return row ? [toProductListItem(row)] : [];
      }),
    };
  }

  /** Keyword matches (up to 500), best first. No terms (only stopwords) → none, not "all". */
  private async keywordIds(
    dto: SearchProductsDto,
    terms: string[],
  ): Promise<string[]> {
    if (terms.length === 0) return [];
    const qb = this.filtered(dto).select('p.id', 'id');
    matchTerms(qb, terms);
    sortBy(qb, 'relevance', terms);
    return (
      await qb.limit(KEYWORD_CANDIDATES).getRawMany<{ id: string }>()
    ).map((r) => r.id);
  }

  /**
   * Products at least PRODUCT_MIN_SIMILARITY to the query and within PRODUCT_SIMILARITY_BAND of
   * the best one, so "waterproof jacket" brings the jacket, not every product that is a bit alike.
   */
  private async vectorIds(
    dto: SearchProductsDto,
    embedding: number[],
  ): Promise<string[]> {
    const rows = await this.filtered(dto)
      .select('p.id', 'id')
      .addSelect(
        '1 - (p.embedding <=> CAST(:embedding AS vector))',
        'similarity',
      )
      .andWhere('p.embedding IS NOT NULL')
      .andWhere('1 - (p.embedding <=> CAST(:embedding AS vector)) >= :min', {
        embedding: toVectorLiteral(embedding),
        min: PRODUCT_MIN_SIMILARITY,
      })
      .orderBy('similarity', 'DESC')
      .limit(VECTOR_CANDIDATES)
      .getRawMany<{ id: string; similarity: number }>();
    if (rows.length === 0) return [];
    const best = Number(rows[0].similarity);
    return rows
      .filter((r) => Number(r.similarity) >= best - PRODUCT_SIMILARITY_BAND)
      .map((r) => r.id);
  }

  /** Active products with the DTO's hard filters: category, brand, price, stock. */
  private filtered(dto: SearchProductsDto): SelectQueryBuilder<Product> {
    const qb = this.active();
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
    return qb;
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

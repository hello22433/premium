import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProductEntity } from '../../../entity/product.entity';
import { IProductType } from '../../../product/interface/product.type';
import { MappedResult, MappedRow, ParsedRow } from './auto.order.types';

/**
 * 3단계 - 상품매핑 + 주문 분기.
 * 입력 행을 서로소 4버킷으로 나눈다: excluded → unmapped → (general | ssg)
 * 배정 순서가 곧 우선순위. 각 행은 정확히 한 버킷에만 들어가 중복 계상이 원천 차단된다
 * (excluded/ssg/general은 filter 분리, unmapped/mapped는 for-loop 단일 배정).
 */
@Injectable()
export class AutoOrderProductMapper {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
  ) {}

  async map(rows: ParsedRow[]): Promise<MappedResult> {
    // ── 1순위: _유효(M)=False 행 제외. N(_상태)=format_error(폰형식)/duplicate(중복)/unselected(상품미선택)
    const excludedRows = rows.filter((r) => !r.isValid);
    const aliveRows = rows.filter((r) => r.isValid);

    // ── 상품코드 일괄 조회 (행마다 조회하면 N+1 → 한 번에 IN 조회)
    const codes = [...new Set(aliveRows.map((r) => r.productCode).filter((c): c is string => !!c))];
    const products = codes.length
      ? await this.productRepository.find({ where: { code: In(codes) } })
      : [];
    const productByCode = new Map(products.map((p) => [p.code, p]));

    // ── 2순위: 상품코드 미매핑 행 분리
    const unmappedRows: ParsedRow[] = [];
    const mappedRows: MappedRow[] = [];
    for (const row of aliveRows) {
      const product = row.productCode ? productByCode.get(row.productCode) : undefined;
      if (!product) {
        unmappedRows.push(row);
      } else {
        mappedRows.push({ ...row, product });
      }
    }

    // ── 3순위: product.type 기준 주문 분기 (SSG vs 나머지)
    const ssgRows = mappedRows.filter((r) => r.product.type === IProductType.SSG);
    const generalRows = mappedRows.filter((r) => r.product.type !== IProductType.SSG);

    return { excludedRows, unmappedRows, generalRows, ssgRows };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProductEntity } from '../../../entity/product.entity';
import { IProductType } from '../../../product/interface/product.type';
import { IProductUseStatus } from '../../../product/interface/product.status';
import { ProductService } from '../../../product/application/product.service';
import {
  AutoOrderRunMode,
  MappedResult,
  MappedRow,
  ParsedRow,
  UnmappedReasonCode,
  UnmappedRow,
} from './auto.order.types';

/**
 * 3단계 - 상품매핑 + 주문 분기.
 * 입력 행을 서로소 5버킷으로 나눈다: excluded → (unmapped | pendingSsg | general | ssg)
 * 배정 순서가 곧 우선순위. 각 행은 정확히 한 버킷에만 들어가 중복 계상이 원천 차단된다
 * (excluded는 filter 분리, 나머지는 for-loop 단일 배정).
 *
 * ★ SSG는 상품코드로 매핑하지 않는다(2026-07-28 FE 요청서 Part C).
 *   SSG 상품은 마스터에 미리 등록되는 게 아니라 "액면가별로 동적 생성"되고, code(EP…)는 생성 시점의
 *   전역 채번 순서로 붙는 부수적 값이다. 즉 같은 액면가라도 서버(개발/운영)마다 code가 다르고, 그 가격의
 *   SSG 상품이 아직 없는 서버엔 row 자체가 없다. 양식 2A의 EP코드는 "양식 빌드 시점 특정 서버의 스냅샷"일 뿐.
 *   → SSG 행은 정상가(I) = 액면가를 SoT로 삼아 findOrCreateSsgProductByPrice와 동일한 경로로 확보한다
 *     (외부 API의 sendAmount 기반 확보와 의미 일치). code로 맞춘 상품이 다른 액면가일 수도 있으므로
 *     가격을 코드보다 우선한다 — 아니면 액면가가 다른 상품권이 조용히 발송된다.
 *
 * ★ DRY_RUN은 DB 무변경 계약이라 상품을 생성하지 않는다(조회만).
 *   미존재 액면가는 pendingSsgRows로 분리해 "승인 시 생성 예정"으로 보고한다(미매핑 아님).
 */
@Injectable()
export class AutoOrderProductMapper {
  /** 발송명단 F열(브랜드) 기준 SSG 판별 키워드. 브랜드명이 바뀌면 상품명(G)까지 함께 본다. */
  private static readonly SSG_KEYWORD = '신세계';
  private readonly logger = new Logger(AutoOrderProductMapper.name);

  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
    private readonly productService: ProductService,
  ) {}

  async map(rows: ParsedRow[], mode: AutoOrderRunMode): Promise<MappedResult> {
    // ── 1순위: _유효(M)=False 행 제외. (N(_상태)=format_error/duplicate/unselected/ok는 리포트용으로만
    //   보존하고 분기엔 쓰지 않는다 — 제외 판단은 오직 M(_유효) 기준)
    const excludedRows = rows.filter((r) => !r.isValid);
    const aliveRows = rows.filter((r) => r.isValid);

    // ── 상품코드 일괄 조회 (행마다 조회하면 N+1 → 한 번에 IN 조회)
    const codes = [...new Set(aliveRows.map((r) => r.productCode).filter((c): c is string => !!c))];
    const products = codes.length
      ? await this.productRepository.find({ where: { code: In(codes) } })
      : [];
    const productByCode = new Map(products.map((p) => [p.code, p]));

    // 액면가별 SSG 조회/생성 결과 캐시(같은 액면가 수천 행 → 쿼리 1회, COMMIT 중복 생성 시도 방지)
    const ssgByPrice = new Map<number, ProductEntity | null>();

    const unmappedRows: UnmappedRow[] = [];
    const pendingSsgRows: ParsedRow[] = [];
    const mappedRows: MappedRow[] = [];

    for (const row of aliveRows) {
      const byCode = row.productCode ? productByCode.get(row.productCode) : undefined;

      // ── 2순위: SSG는 액면가(I)가 SoT.
      //   코드로 찾힌 상품이 SSG인데 액면가가 다르면(서버별 채번 차이로 EP코드가 다른 상품을 가리킴)
      //   코드를 버리고 가격으로 다시 확보한다 — 아니면 액면가가 틀린 상품권이 조용히 발송된다.
      //   코드가 비-SSG 상품을 정확히 가리키면 그 코드가 권위다(브랜드 문자열보다 신뢰).
      const needsSsgPricePath = byCode
        ? byCode.type === IProductType.SSG && row.listPrice > 0 && byCode.price !== row.listPrice
        : this.isSsgRow(row);

      if (needsSsgPricePath) {
        const resolved = await this.resolveSsgProduct(row, mode, ssgByPrice);
        if (resolved.kind === 'MAPPED') mappedRows.push({ ...row, product: resolved.product });
        else if (resolved.kind === 'PENDING') pendingSsgRows.push(row);
        else unmappedRows.push(this.toUnmapped(row, resolved.reasonCode, resolved.reason));
        continue;
      }

      // ── 3순위: 상품코드(H) 매핑
      if (!byCode) {
        unmappedRows.push(this.toUnmapped(row, 'PRODUCT_CODE_NOT_FOUND', '미등록 상품코드'));
        continue;
      }
      if (!this.isSellable(byCode)) {
        // 발송확정(OrderValidation)이 useStatus !== USE 상품을 throw로 막으므로, 여기서 안 거르면
        // "주문은 생성됐는데 발송확정 단계에서 전량 실패"가 된다 → 매핑 단계에서 사유 있는 미매핑으로.
        unmappedRows.push(
          this.toUnmapped(row, 'PRODUCT_NOT_SELLABLE', `${row.rowNo}행: 판매중지된 상품입니다(${byCode.code}).`),
        );
        continue;
      }
      mappedRows.push({ ...row, product: byCode });
    }

    // ── 4순위: product.type 기준 주문 분기 (SSG vs 나머지)
    const ssgRows = mappedRows.filter((r) => r.product.type === IProductType.SSG);
    const generalRows = mappedRows.filter((r) => r.product.type !== IProductType.SSG);

    return { excludedRows, unmappedRows, pendingSsgRows, generalRows, ssgRows };
  }

  /**
   * SSG 행의 상품 확보.
   * DRY_RUN: 조회만(findSsgProductByPriceOrNull) — 없으면 PENDING(승인 시 생성).
   * COMMIT : 없으면 생성(findOrCreateSsgProductByPrice) — 템플릿 부재 등 실패는 사유 있는 미매핑.
   */
  private async resolveSsgProduct(
    row: ParsedRow,
    mode: AutoOrderRunMode,
    cache: Map<number, ProductEntity | null>,
  ): Promise<
    | { kind: 'MAPPED'; product: ProductEntity }
    | { kind: 'PENDING' }
    | { kind: 'UNMAPPED'; reasonCode: UnmappedReasonCode; reason: string }
  > {
    if (row.listPrice <= 0) {
      // I열 수식 결과 미캐시/빈값 → 액면가를 모른 채 "적당한 상품"을 고르면 다른 금액의 상품권이 나간다. 반드시 차단.
      return {
        kind: 'UNMAPPED',
        reasonCode: 'SSG_PRICE_MISSING',
        reason: `${row.rowNo}행: 신세계 상품의 정상가(I)를 읽을 수 없습니다. 엑셀에서 다시 저장 후 업로드해 주세요.`,
      };
    }

    const price = row.listPrice;
    if (!cache.has(price)) {
      cache.set(price, await this.loadSsgProduct(price, mode));
    }
    const product = cache.get(price) ?? null;

    if (!product) {
      if (mode === AutoOrderRunMode.DRY_RUN) return { kind: 'PENDING' };
      return {
        kind: 'UNMAPPED',
        reasonCode: 'SSG_TEMPLATE_MISSING',
        reason: `${row.rowNo}행: 신세계 상품(${price.toLocaleString()}원)을 자동 생성하지 못했습니다(운영 확인 필요).`,
      };
    }
    if (!this.isSellable(product)) {
      return {
        kind: 'UNMAPPED',
        reasonCode: 'PRODUCT_NOT_SELLABLE',
        reason: `${row.rowNo}행: 판매중지된 상품입니다(${product.code}).`,
      };
    }
    return { kind: 'MAPPED', product };
  }

  /** 액면가로 SSG 상품 확보. DRY_RUN은 조회만(DB 무변경), COMMIT은 없으면 생성. 확보 실패는 null. */
  private async loadSsgProduct(price: number, mode: AutoOrderRunMode): Promise<ProductEntity | null> {
    if (mode === AutoOrderRunMode.DRY_RUN) {
      return this.productService.findSsgProductByPriceOrNull(price);
    }
    try {
      return await this.productService.findOrCreateSsgProductByPrice(price);
    } catch (e) {
      // 템플릿 상품 부재/채번 충돌 등. COMMIT 전체를 롤백시키지 않고 해당 행만 사유 있는 미매핑으로 떨군다
      // (다른 상품의 정상 주문은 살린다). 운영 확인이 필요하므로 error로 표면화.
      this.logger.error(`SSG 상품 확보 실패(price=${price}): ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * SSG 행 판별: 브랜드(F)가 1차 신호, 상품명(G)이 2차(브랜드 열이 비거나 양식이 바뀐 경우 대비).
   * 실제 상품 확보는 findOrCreateSsgProductByPrice(=SSG 정식 경로)에 위임하므로, 여기서 오탐하면
   * 그 가격의 SSG 상품이 생기는 게 아니라 "SSG 상품이 없어 미매핑/대기"로 안전하게 귀결된다.
   */
  private isSsgRow(row: ParsedRow): boolean {
    const signal = `${row.brand ?? ''} ${row.productName ?? ''}`;
    return signal.includes(AutoOrderProductMapper.SSG_KEYWORD);
  }

  /** 발송확정(OrderValidation)과 동일 기준: useStatus === USE 만 주문 가능. */
  private isSellable(product: ProductEntity): boolean {
    return product.useStatus === IProductUseStatus.USE;
  }

  private toUnmapped(row: ParsedRow, reasonCode: UnmappedReasonCode, reason: string): UnmappedRow {
    return { ...row, reasonCode, reason };
  }
}

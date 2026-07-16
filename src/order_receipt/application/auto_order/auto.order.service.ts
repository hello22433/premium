import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../../auth/interface/login.user';
import { UserEntity } from '../../../entity/user.entity';
import { OrderReceiptEntity } from '../../../entity/order.receipt.entity';
import { SsgReservationRangeEntity } from '../../../entity/ssg.reservation.range.entity';
import { IOrderType } from '../../../order/interface/order.type';
import { FileService } from '../../../file/application/file.service';
import { SsgReservationRangeBoundary } from '../../../order/domain/order.validation';
import { AutoOrderExcelParser } from './auto.order.excel.parser';
import { AutoOrderStructureValidator } from './auto.order.structure.validator';
import { AutoOrderProductMapper } from './auto.order.product.mapper';
import { AutoOrderPreValidator } from './auto.order.pre.validator';
import { AutoOrderPayloadBuilder } from './auto.order.payload.builder';
import { buildReconciliation } from './auto.order.reconciliation';
import {
  AutoOrderFileResult,
  AutoOrderReportOrder,
  AutoOrderResult,
  AutoOrderRunMode,
  BuildPayloadResult,
  MappedResult,
  ParsedHeader,
  PreValidateResult,
} from './auto.order.types';

/**
 * 6단계 - 오케스트레이터.
 * 파싱 → 구조검증 → 상품매핑/분기 → 사전검증 → payload조립 → (mode별 실행) → 검산 을 지휘한다.
 * 미리보기(DRY_RUN)와 승인(COMMIT)이 "같은 파이프라인"을 타고 mode만 갈리므로 preview=commit이 보장된다.
 *
 * ※ 현재 Phase: DRY_RUN(미리보기)만 구현. COMMIT(실제 생성/멱등/저장)은 Phase 7에서 추가.
 */
@Injectable()
export class AutoOrderService {
  private readonly logger = new Logger(AutoOrderService.name);

  constructor(
    private readonly parser: AutoOrderExcelParser,
    private readonly structureValidator: AutoOrderStructureValidator,
    private readonly productMapper: AutoOrderProductMapper,
    private readonly preValidator: AutoOrderPreValidator,
    private readonly payloadBuilder: AutoOrderPayloadBuilder,
    private readonly fileService: FileService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(SsgReservationRangeEntity)
    private readonly reservationRangeRepository: Repository<SsgReservationRangeEntity>,
  ) {}

  /** SSG 예약 가능 범위(단일 row 운용, 최신 1건). SsgEventService.getReservationRange와 동일 로직. */
  private async getReservationRange(): Promise<SsgReservationRangeEntity | null> {
    return this.reservationRangeRepository.findOne({ where: {}, order: { id: 'DESC' } });
  }

  async run(receipt: OrderReceiptEntity, _user: ILoginUserInfo, mode: AutoOrderRunMode): Promise<AutoOrderResult> {
    // 사전검증 입력(주문 주체=접수한 기업 사용자의 발신수단 제한, SSG 예약창)을 1회 조회해 재사용
    const receiptUser = await this.userRepository.findOne({ where: { id: receipt.userId } });
    const allowedSendMethods = receiptUser?.allowedSendMethods ?? null;
    const range = this.toRangeBoundary(await this.getReservationRange());

    const urls = (receipt.filePath ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    const files: AutoOrderFileResult[] = [];
    for (let fileIndex = 0; fileIndex < urls.length; fileIndex++) {
      files.push(await this.processFile(urls[fileIndex], fileIndex, allowedSendMethods, range, mode));
    }

    return { files, alreadyCommitted: false };
  }

  private async processFile(
    url: string,
    fileIndex: number,
    allowedSendMethods: string | null,
    range: SsgReservationRangeBoundary | null,
    mode: AutoOrderRunMode,
  ): Promise<AutoOrderFileResult> {
    const fileName = this.safeFileName(url);

    // ── 1단계 파싱 (읽기/파싱 실패는 해당 파일만 오류 처리)
    let parsed;
    try {
      const buffer = await this.fileService.getBuffer(url);
      parsed = await this.parser.parse(buffer);
    } catch (e) {
      this.logger.warn(`자동주문 파일 파싱 실패 [${fileIndex}] ${fileName}: ${(e as Error).message}`);
      return this.invalidFile(fileIndex, fileName, '파일을 읽거나 열 수 없습니다.');
    }

    // ── 2단계 구조검증
    const structure = this.structureValidator.validate(parsed);
    if (structure.status === 'INVALID_FORMAT') {
      return this.invalidFile(fileIndex, fileName, structure.message);
    }
    const header = parsed.header as ParsedHeader;

    // ── 3단계 상품매핑/분기
    const mapped = await this.productMapper.map(parsed.rows);

    // ── 4단계 사전검증
    const pre = this.preValidator.validate({
      header,
      generalRows: mapped.generalRows,
      ssgRows: mapped.ssgRows,
      userAllowedSendMethods: allowedSendMethods,
      ssgReservationRange: range,
    });

    // ── 5~6단계 payload 조립 + (mode별) 실행
    const orders = this.buildOrders(header, mapped, pre, mode);

    // ── 검산
    const builtDeliveryCount = orders.reduce((sum, o) => sum + o.deliveryCount, 0);
    const reconciliation = buildReconciliation({
      inputRowCount: parsed.rows.length,
      unmappedCount: mapped.unmappedRows.length,
      excludedCount: mapped.excludedRows.length,
      builtDeliveryCount,
    });

    return {
      fileIndex,
      fileName,
      status: 'VALID',
      message: null,
      orders,
      reconciliation,
      fileBlocked: pre.fileBlocked,
      blocked: pre.blocked.filter((b) => b.level !== 'ROW'), // FILE/ORDER
      blockedRows: pre.blocked.filter((b) => b.level === 'ROW'), // ROW
    };
  }

  /** 일반/SSG 주문을 조립. FILE 차단이면 0건, SSG는 예약창 밖이면 스킵. */
  private buildOrders(
    header: ParsedHeader,
    mapped: MappedResult,
    pre: PreValidateResult,
    mode: AutoOrderRunMode,
  ): AutoOrderReportOrder[] {
    if (pre.fileBlocked) return [];

    const plans = [
      { type: IOrderType.GENERAL, rows: mapped.generalRows, skip: false },
      { type: IOrderType.SSG, rows: mapped.ssgRows, skip: pre.ssgOrderBlocked },
    ];

    const orders: AutoOrderReportOrder[] = [];
    for (const plan of plans) {
      if (plan.skip || plan.rows.length === 0) continue;

      const result = this.payloadBuilder.build({
        header,
        rows: plan.rows,
        orderType: plan.type,
        blockedRowNos: pre.blockedRowNos,
      });
      if (!result) continue; // 살아남은 수신자 0명

      orders.push(this.toReportOrder(plan.type, header.eventName, result, mode));
    }
    return orders;
  }

  private toReportOrder(
    type: IOrderType,
    eventName: string,
    result: BuildPayloadResult,
    mode: AutoOrderRunMode,
  ): AutoOrderReportOrder {
    // DRY_RUN: 실제 생성하지 않으므로 orderId=null. COMMIT의 실제 생성/멱등은 Phase 7.
    void mode;
    return {
      orderId: null,
      type,
      eventName,
      productCount: result.payload.orderProductList.length,
      deliveryCount: result.sourceRowNos.length,
      sourceRowNos: result.sourceRowNos,
    };
  }

  private toRangeBoundary(
    range: { startDate: Date; endDate: Date } | null,
  ): SsgReservationRangeBoundary | null {
    return range ? { startDate: range.startDate, endDate: range.endDate } : null;
  }

  private safeFileName(url: string): string {
    try {
      return this.fileService.extractOriginalFileName(url);
    } catch {
      return url;
    }
  }

  private invalidFile(fileIndex: number, fileName: string, message: string | null): AutoOrderFileResult {
    return {
      fileIndex,
      fileName,
      status: 'INVALID_FORMAT',
      message,
      orders: [],
      reconciliation: buildReconciliation({
        inputRowCount: 0,
        unmappedCount: 0,
        excludedCount: 0,
        builtDeliveryCount: 0,
      }),
      fileBlocked: false,
      blocked: [],
      blockedRows: [],
    };
  }
}

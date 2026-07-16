import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../../auth/interface/login.user';
import { UserEntity } from '../../../entity/user.entity';
import { OrderReceiptEntity } from '../../../entity/order.receipt.entity';
import { SsgReservationRangeEntity } from '../../../entity/ssg.reservation.range.entity';
import { OrderReceiptGeneratedOrderEntity } from '../../../entity/order.receipt.generated.order.entity';
import { OrderReceiptAutoResultEntity } from '../../../entity/order.receipt.auto.result.entity';
import { IOrderType } from '../../../order/interface/order.type';
import { OrderService } from '../../../order/application/order.service';
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
 * 6~7단계 - 오케스트레이터.
 * 파싱 → 구조검증 → 상품매핑/분기 → 사전검증 → payload조립 → (mode별 실행) → 검산 을 지휘한다.
 * 미리보기(DRY_RUN)와 승인(COMMIT)이 "같은 파이프라인"을 타고 mode만 갈리므로 preview=commit이 보장된다.
 *
 * COMMIT은 반드시 호출자(approve)의 @Transactional 안에서 실행되어야 원자성이 보장된다
 * (로봇 실패 시 승인 상태변경까지 함께 롤백).
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
    private readonly orderService: OrderService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(SsgReservationRangeEntity)
    private readonly reservationRangeRepository: Repository<SsgReservationRangeEntity>,
    @InjectRepository(OrderReceiptGeneratedOrderEntity)
    private readonly generatedOrderRepository: Repository<OrderReceiptGeneratedOrderEntity>,
    @InjectRepository(OrderReceiptAutoResultEntity)
    private readonly autoResultRepository: Repository<OrderReceiptAutoResultEntity>,
  ) {}

  /** SSG 예약 가능 범위(단일 row 운용, 최신 1건). SsgEventService.getReservationRange와 동일 로직. */
  private async getReservationRange(): Promise<SsgReservationRangeEntity | null> {
    return this.reservationRangeRepository.findOne({ where: {}, order: { id: 'DESC' } });
  }

  async run(receipt: OrderReceiptEntity, user: ILoginUserInfo, mode: AutoOrderRunMode): Promise<AutoOrderResult> {
    // ── COMMIT 멱등 게이트: 이미 처리했으면 저장 스냅샷 그대로 반환(재계산 안 함)
    if (mode === AutoOrderRunMode.COMMIT) {
      const saved = await this.autoResultRepository.findOne({ where: { orderReceiptId: receipt.id } });
      if (saved) {
        const prev = JSON.parse(saved.resultJson) as AutoOrderResult;
        return { ...prev, alreadyCommitted: true };
      }
    }

    // 사전검증 입력(주문 주체=접수한 기업 사용자의 발신수단 제한, SSG 예약창)을 1회 조회해 재사용
    const receiptUser = await this.userRepository.findOne({ where: { id: receipt.userId } });
    const ownerMissing = receiptUser === null; // 소유자 없음 → 전체허용 폴백 금지(사전검증에서 FILE 차단)
    const allowedSendMethods = receiptUser?.allowedSendMethods ?? null;
    const range = this.toRangeBoundary(await this.getReservationRange());

    const urls = (receipt.filePath ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    const files: AutoOrderFileResult[] = [];
    for (let fileIndex = 0; fileIndex < urls.length; fileIndex++) {
      files.push(
        await this.processFile(receipt, user, urls[fileIndex], fileIndex, allowedSendMethods, ownerMissing, range, mode),
      );
    }

    const result: AutoOrderResult = { files, alreadyCommitted: false };

    // ── COMMIT: 리포트 스냅샷 저장(재조회/재승인 시 그대로 반환)
    if (mode === AutoOrderRunMode.COMMIT) {
      await this.autoResultRepository.insert({
        orderReceiptId: receipt.id,
        resultJson: JSON.stringify(result),
        generatedAt: new Date(),
      });
    }

    return result;
  }

  private async processFile(
    receipt: OrderReceiptEntity,
    user: ILoginUserInfo,
    url: string,
    fileIndex: number,
    allowedSendMethods: string | null,
    ownerMissing: boolean,
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
      ownerMissing,
      ssgReservationRange: range,
    });

    // ── 5~6단계 payload 조립 + (mode별) 실행
    const orders = await this.buildOrders(receipt, user, fileIndex, header, mapped, pre, mode);

    // ── 검산
    const builtDeliveryCount = orders.reduce((sum, o) => sum + o.deliveryCount, 0);
    const reconciliation = buildReconciliation({
      inputRowCount: parsed.rows.length,
      unmappedCount: mapped.unmappedRows.length,
      excludedCount: mapped.excludedRows.length,
      builtDeliveryCount,
    });

    // 검산 불일치(built 과다=중복계상 코드버그 신호) → 에러 로깅으로 표면화
    if (!reconciliation.matched) {
      this.logger.error(
        `자동주문 검산 불일치 [${mode}] receipt=${receipt.id} file=${fileIndex} ` +
          `expected=${reconciliation.expectedDeliveryCount} built=${reconciliation.builtDeliveryCount} ` +
          `blocked=${reconciliation.blockedDeliveryCount}`,
      );
    }

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

  /** 일반/SSG 주문을 조립. FILE 차단이면 0건, SSG는 예약창 밖이면 스킵. COMMIT이면 실제 생성 + 멱등 기록. */
  private async buildOrders(
    receipt: OrderReceiptEntity,
    user: ILoginUserInfo,
    fileIndex: number,
    header: ParsedHeader,
    mapped: MappedResult,
    pre: PreValidateResult,
    mode: AutoOrderRunMode,
  ): Promise<AutoOrderReportOrder[]> {
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

      const orderId = mode === AutoOrderRunMode.COMMIT ? await this.commitOrder(receipt, fileIndex, user, result, plan.type) : null;
      orders.push(this.toReportOrder(orderId, plan.type, header.eventName, result));
    }
    return orders;
  }

  /**
   * 실제 TEMP 주문 생성 + 멱등 기록.
   * 소유권: 접수한 기업 사용자(receipt.userId)를 clientUserId로 → "관리자가 그 기업을 위해 대행 생성".
   *         발신수단 검증 대상이 사전검증(receipt.userId 기준)과 일치한다.
   */
  private async commitOrder(
    receipt: OrderReceiptEntity,
    fileIndex: number,
    user: ILoginUserInfo,
    result: BuildPayloadResult,
    type: IOrderType,
  ): Promise<number> {
    result.payload.clientUserId = receipt.userId;
    const created = await this.orderService.createTemp(user, result.payload);

    // UNIQUE(orderReceiptId, fileIndex, type)가 동시/중복 생성을 DB에서 차단
    await this.generatedOrderRepository.insert({
      orderReceiptId: receipt.id,
      fileIndex,
      orderId: created.id,
      type,
    });

    return created.id;
  }

  private toReportOrder(
    orderId: number | null,
    type: IOrderType,
    eventName: string,
    result: BuildPayloadResult,
  ): AutoOrderReportOrder {
    return {
      orderId,
      type,
      eventName,
      productCount: result.payload.orderProductList.length,
      deliveryCount: result.sourceRowNos.length,
      sourceRowNos: result.sourceRowNos,
    };
  }

  private toRangeBoundary(range: { startDate: Date; endDate: Date } | null): SsgReservationRangeBoundary | null {
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

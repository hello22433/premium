import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../../auth/interface/login.user';
import { UserEntity } from '../../../entity/user.entity';
import { OrderReceiptEntity } from '../../../entity/order.receipt.entity';
import { OrderReceiptGeneratedOrderEntity } from '../../../entity/order.receipt.generated.order.entity';
import { OrderReceiptAutoResultEntity } from '../../../entity/order.receipt.auto.result.entity';
import { IOrderType } from '../../../order/interface/order.type';
import { OrderService } from '../../../order/application/order.service';
import { SsgEventService } from '../../../ssg_event/application/ssg.event.service';
import { FileService } from '../../../file/application/file.service';
import { parseFilePathList } from '../../../util/file.util';
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
    private readonly ssgEventService: SsgEventService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(OrderReceiptGeneratedOrderEntity)
    private readonly generatedOrderRepository: Repository<OrderReceiptGeneratedOrderEntity>,
    @InjectRepository(OrderReceiptAutoResultEntity)
    private readonly autoResultRepository: Repository<OrderReceiptAutoResultEntity>,
  ) {}

  async run(receipt: OrderReceiptEntity, user: ILoginUserInfo, mode: AutoOrderRunMode): Promise<AutoOrderResult> {
    // ── COMMIT 멱등 게이트: 이미 처리했으면 저장 스냅샷 그대로 반환(재계산 안 함)
    if (mode === AutoOrderRunMode.COMMIT) {
      const saved = await this.autoResultRepository.findOne({ where: { orderReceiptId: receipt.id } });
      if (saved) {
        let prev: AutoOrderResult;
        try {
          prev = JSON.parse(saved.resultJson) as AutoOrderResult;
        } catch (e) {
          // 저장 스냅샷이 손상/스키마드리프트로 파싱 불가 → raw SyntaxError 500 대신 맥락 있는 오류로.
          // 원 주문은 최초 커밋에서 이미 생성됐으므로 이 경로는 복구 불가, 명확히 실패시킨다.
          this.logger.error(
            `자동주문 저장 스냅샷 파싱 실패 receipt=${receipt.id}: ${(e as Error).message}`,
          );
          throw new Error(`이미 처리된 자동주문 결과를 읽을 수 없습니다(receipt=${receipt.id}).`);
        }
        return { ...prev, alreadyCommitted: true };
      }
    }

    // 사전검증 입력(주문 주체=접수한 기업 사용자의 발신수단 제한, SSG 예약창)을 1회 조회해 재사용
    const receiptUser = await this.userRepository.findOne({ where: { id: receipt.userId } });
    const ownerMissing = receiptUser === null; // 소유자 없음 → 전체허용 폴백 금지(사전검증에서 FILE 차단)
    const allowedSendMethods = receiptUser?.allowedSendMethods ?? null;
    const range = this.toRangeBoundary(await this.ssgEventService.getReservationRange());

    // 저장 filePath 파싱은 접수 시스템 전체가 쓰는 공용 파서로 통일한다.
    // (파일명에 콤마가 포함될 수 있어 naive split(',')은 URL을 조각내 승인 실패 + fileIndex 멱등키 오염을 유발)
    const urls = parseFilePathList(receipt.filePath);

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

    // ── 1단계 파싱
    //   인프라/IO 오류(S3 읽기 실패, 0바이트)와 형식 오류(파싱 실패)를 구분한다.
    //   · 인프라 오류: COMMIT이면 전파 → approve 트랜잭션 롤백(유효 주문 소실 방지). DRY_RUN이면 파일 오류 표시.
    //   · 형식 오류:   INVALID_FORMAT으로 진행(고객사 자체 양식 허용 — 승인은 정상).
    let buffer: Buffer;
    try {
      buffer = await this.fileService.getBuffer(url);
    } catch (e) {
      this.logger.error(`자동주문 파일 읽기 실패 [${fileIndex}] ${fileName}: ${(e as Error).message}`);
      if (mode === AutoOrderRunMode.COMMIT) {
        throw new Error(`자동주문 파일을 읽을 수 없습니다(${fileName}): ${(e as Error).message}`);
      }
      return this.invalidFile(fileIndex, fileName, '파일을 읽을 수 없습니다(일시 오류). 다시 시도해 주세요.');
    }
    if (buffer.length === 0) {
      this.logger.error(`자동주문 파일 0바이트 [${fileIndex}] ${fileName} (업로드 실패 추정)`);
      if (mode === AutoOrderRunMode.COMMIT) throw new Error(`자동주문 파일이 비어 있습니다(${fileName}).`);
      return this.invalidFile(fileIndex, fileName, '파일이 비어 있습니다.');
    }

    let parsed;
    try {
      parsed = await this.parser.parse(buffer);
    } catch (e) {
      // 파싱 throw는 비-v4.1(고객사 자체양식) 정상 케이스와, 정상 v4.1인데 OOM/손상zip/라이브러리
      // 버그로 실패한 케이스가 구분되지 않는다. 요구사항상 승인은 차단하지 않되(비-v4.1 허용),
      // 후자(정상 파일 유실)를 놓치지 않도록 error 레벨로 승격해 표면화한다. mode도 함께 남긴다.
      this.logger.error(
        `자동주문 파일 파싱 실패 [${mode}] receipt=${receipt.id} file=${fileIndex} ${fileName}: ` +
          `${(e as Error).message} (정상 v4.1 파일이 일시 오류로 유실됐을 수 있으니 확인 요망)`,
      );
      return this.invalidFile(fileIndex, fileName, '엑셀 형식을 해석할 수 없습니다.');
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

    // 검산 불일치(built 과다=중복계상 코드버그 신호) → 에러 로깅으로 표면화.
    // COMMIT이면 이미 createTemp로 실제 주문이 생성된 뒤이므로, 로그에 그치지 않고 throw해
    // approve 트랜잭션을 롤백한다(중복주문이 그대로 커밋되는 것을 방지). DRY_RUN은 로깅만.
    if (!reconciliation.matched) {
      this.logger.error(
        `자동주문 검산 불일치 [${mode}] receipt=${receipt.id} file=${fileIndex} ` +
          `expected=${reconciliation.expectedDeliveryCount} built=${reconciliation.builtDeliveryCount} ` +
          `blocked=${reconciliation.blockedDeliveryCount}`,
      );
      if (mode === AutoOrderRunMode.COMMIT) {
        throw new Error(
          `자동주문 검산 불일치로 승인을 중단합니다(receipt=${receipt.id}, file=${fileIndex}). 중복주문 방지를 위해 롤백합니다.`,
        );
      }
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

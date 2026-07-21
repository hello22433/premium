import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { OrderCreateTempReqDto } from '../../../order/api/order.req.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ILoginUserInfo } from '../../../auth/interface/login.user';
import { UserEntity } from '../../../entity/user.entity';
import { OrderFromDefinitionEntity } from '../../../entity/order.from.definition.entity';
import { OrderFromDefinitionType, OrderFromRequestStatus } from '../../../order_from/interface/order.from.definition.type';
import { IOrderSendMethod } from '../../../order/interface/order.send.method';
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
  FormatErrorCode,
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
  static readonly MAX_FILE_BYTES = 20 * 1024 * 1024; // 첨부 크기 상한 20MB(신뢰경계 밖 입력 DoS/압축폭탄 방어)
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
    @InjectRepository(OrderFromDefinitionEntity)
    private readonly orderFromRepository: Repository<OrderFromDefinitionEntity>,
    private readonly configService: ConfigService,
  ) {}

  async run(
    receipt: OrderReceiptEntity,
    user: ILoginUserInfo,
    mode: AutoOrderRunMode,
    fileIndexes?: number[],
  ): Promise<AutoOrderResult> {
    // ── COMMIT 멱등 게이트: 이미 처리했으면 저장 스냅샷 그대로 반환(재계산 안 함)
    if (mode === AutoOrderRunMode.COMMIT) {
      const saved = await this.autoResultRepository.findOne({ where: { orderReceiptId: receipt.id } });
      if (saved) {
        // 승인 후 첨부가 바뀐 채 재승인되면(APPROVED→RECEIVED→filePath 교체→재승인) 구 스냅샷을 조용히
        // 돌려주면 "미리보기는 신규 N건, 실제는 0건/구 파일"이 된다. 첨부 해시 불일치면 명시적 400으로 막는다.
        const currentHash = this.computeFilePathHash(receipt.filePath);
        if (saved.filePathHash && saved.filePathHash !== currentHash) {
          throw new BadRequestException(
            '승인 후 첨부파일이 변경되어 기존 자동주문 결과와 일치하지 않습니다. 재승인을 진행할 수 없습니다(기존 자동주문 결과 정리 후 다시 시도).',
          );
        }
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
    // SSG 예약창을 여기서 1회 읽어(time-of-check) 사전검증에 넘긴다. 실제 생성(createTemp, time-of-use)까지의
    // 사이에 관리자가 예약창을 바꾸면 이 스냅샷이 낡을 수 있으나(리뷰 #14 TOCTOU), 봉쇄하지 않는다:
    //   · createTemp가 내부에서 validateSsgReservationWindow를 재검증하므로 "창 밖 SSG가 실제 생성"되는 경로는 없다(권위 가드).
    //   · 어긋나도 결과는 둘 다 안전 — commit 시 창 이동이면 createTemp throw→approve 전체 롤백(잘못된 주문 0건),
    //     반대로 스킵됐다 창 안이면 SSG만 미생성→재승인으로 복구. 완전 봉쇄(이벤트 행 락/직전 재조회)는 ROI가 낮아 수용.
    const range = this.toRangeBoundary(await this.ssgEventService.getReservationRange());
    const resolvedFromEmail = await this.resolveEmailSender(); // EMAIL 발신주소(등록 우선, 없으면 하이웍스 기본)

    // 저장 filePath 파싱은 접수 시스템 전체가 쓰는 공용 파서로 통일한다.
    // (파일명에 콤마가 포함될 수 있어 naive split(',')은 URL을 조각내 승인 실패 + fileIndex 멱등키 오염을 유발)
    const urls = parseFilePathList(receipt.filePath);

    // 관리자가 고른 파일만 처리(fileIndexes). 미지정이면 전체. fileIndex는 전체 목록 기준 인덱스를 유지해
    // 멱등키(orderReceiptId, fileIndex, type)와 리포트 식별자가 선택 여부와 무관하게 안정적이다.
    let selected: number[];
    if (fileIndexes && fileIndexes.length > 0) {
      // 범위 밖/비정수 인덱스를 조용히 필터하면 빈(또는 부분) 미리보기가 사유 없이 나온다 → 명시적으로 거부.
      const invalid = fileIndexes.filter((i) => !Number.isInteger(i) || i < 0 || i >= urls.length);
      if (invalid.length > 0) {
        throw new BadRequestException(
          `유효하지 않은 파일 인덱스: ${invalid.join(', ')} (첨부 ${urls.length}개, 허용 0~${urls.length - 1}).`,
        );
      }
      selected = [...new Set(fileIndexes)].sort((a, b) => a - b);
    } else {
      selected = urls.map((_, i) => i);
    }

    const files: AutoOrderFileResult[] = [];
    for (const fileIndex of selected) {
      files.push(
        await this.processFile(
          receipt,
          user,
          urls[fileIndex],
          fileIndex,
          { allowedSendMethods, ownerMissing, range, resolvedFromEmail },
          mode,
        ),
      );
    }

    const result: AutoOrderResult = { files, alreadyCommitted: false };

    // ── COMMIT: 리포트 스냅샷 저장(재조회/재승인 시 그대로 반환)
    if (mode === AutoOrderRunMode.COMMIT) {
      await this.autoResultRepository.insert({
        orderReceiptId: receipt.id,
        resultJson: JSON.stringify(result),
        filePathHash: this.computeFilePathHash(receipt.filePath),
        generatedAt: new Date(),
      });
    }

    return result;
  }

  /**
   * 저장된 COMMIT 스냅샷을 읽어 반환(없으면 null) — GET /result용, 부작용 없음.
   * 재계산하지 않고 승인 시점 결과를 그대로 돌려준다(SSG 예약창 등 시간의존 결과의 일관성 보장).
   */
  async getStoredResult(receiptId: number): Promise<{ result: AutoOrderResult; generatedAt: Date } | null> {
    const saved = await this.autoResultRepository.findOne({ where: { orderReceiptId: receiptId } });
    if (!saved) return null;
    try {
      return { result: JSON.parse(saved.resultJson) as AutoOrderResult, generatedAt: saved.generatedAt };
    } catch (e) {
      this.logger.error(`자동주문 저장 스냅샷 파싱 실패 receipt=${receiptId}: ${(e as Error).message}`);
      throw new Error(`이미 처리된 자동주문 결과를 읽을 수 없습니다(receipt=${receiptId}).`);
    }
  }

  /**
   * EMAIL 발신주소 해석: 등록된 APPROVED 전역 발신이메일(isDefault 우선) → 없으면 하이웍스 기본계정.
   * 발신번호(1644-3614 고정)와 동일 패턴 — 양식엔 수신 이메일만, 발신은 시스템이 주입.
   * 둘 다 없으면 null → 사전검증이 EMAIL 파일을 FILE 차단(발송확정 throw를 미리 표면화).
   */
  /** 첨부(filePath) 정규화 해시(sha256). 공용 파서로 파싱한 URL 목록을 정렬 없이 그대로 join(순서 의미 있음=fileIndex). */
  private computeFilePathHash(filePath: string | null): string {
    const canonical = parseFilePathList(filePath ?? '').join('\n');
    return createHash('sha256').update(canonical).digest('hex');
  }

  private async resolveEmailSender(): Promise<string | null> {
    const registered = await this.orderFromRepository.findOne({
      where: { type: OrderFromDefinitionType.EMAIL, requestStatus: OrderFromRequestStatus.APPROVED },
      order: { isDefault: 'DESC', id: 'ASC' },
    });
    if (registered?.from) return registered.from;

    const hiworksId = this.configService.get<string>('MAIL_HIGH_WORKS_ID');
    return hiworksId ? `${hiworksId}@enmad.com` : null;
  }

  private async processFile(
    receipt: OrderReceiptEntity,
    user: ILoginUserInfo,
    url: string,
    fileIndex: number,
    ctx: {
      allowedSendMethods: string | null;
      ownerMissing: boolean;
      range: SsgReservationRangeBoundary | null;
      resolvedFromEmail: string | null;
    },
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
      return this.invalidFile(fileIndex, fileName, url, '파일을 읽을 수 없습니다(일시 오류). 다시 시도해 주세요.', 'NOT_XLSX');
    }
    if (buffer.length === 0) {
      this.logger.error(`자동주문 파일 0바이트 [${fileIndex}] ${fileName} (업로드 실패 추정)`);
      if (mode === AutoOrderRunMode.COMMIT) throw new Error(`자동주문 파일이 비어 있습니다(${fileName}).`);
      return this.invalidFile(fileIndex, fileName, url, '파일이 비어 있습니다.', 'NOT_XLSX');
    }
    // 크기 상한: xlsx.load 전에 차단(압축폭탄/거대파일이 파싱 단계에서 메모리·CPU 폭주하는 것 방지).
    if (buffer.length > AutoOrderService.MAX_FILE_BYTES) {
      this.logger.error(
        `자동주문 파일 크기 초과 [${fileIndex}] ${fileName}: ${buffer.length}바이트 (상한 ${AutoOrderService.MAX_FILE_BYTES})`,
      );
      const limitMb = Math.floor(AutoOrderService.MAX_FILE_BYTES / (1024 * 1024));
      if (mode === AutoOrderRunMode.COMMIT) {
        throw new Error(`자동주문 파일이 처리 한도(${limitMb}MB)를 초과했습니다(${fileName}).`);
      }
      return this.invalidFile(fileIndex, fileName, url, `파일이 처리 한도(${limitMb}MB)를 초과했습니다.`, 'NOT_XLSX');
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
      // 정상 xlsx는 비-v4.1이어도 파싱은 되고 구조검증에서 리젝된다. 파싱 자체가 throw면 손상/비표준 파일이므로
      // 일반 "고객사 자체양식" 스킵과 시각적으로 구분되는 메시지로 표면화(승인은 막지 않되 담당자 확인 유도).
      return this.invalidFile(
        fileIndex,
        fileName,
        url,
        '엑셀 파일을 해석하지 못했습니다(손상/비표준 파일 가능). 담당자 확인이 필요합니다.',
        'NOT_XLSX',
      );
    }

    // ── 2단계 구조검증
    const structure = this.structureValidator.validate(parsed);
    if (structure.status === 'INVALID_FORMAT') {
      return this.invalidFile(fileIndex, fileName, url, structure.message, structure.code ?? 'HEADER_MISMATCH');
    }
    const header = parsed.header as ParsedHeader;

    // ── 3단계 상품매핑/분기
    const mapped = await this.productMapper.map(parsed.rows);

    // ── 4단계 사전검증
    const pre = this.preValidator.validate({
      header,
      generalRows: mapped.generalRows,
      ssgRows: mapped.ssgRows,
      userAllowedSendMethods: ctx.allowedSendMethods,
      ownerMissing: ctx.ownerMissing,
      ssgReservationRange: ctx.range,
      resolvedFromEmail: ctx.resolvedFromEmail,
    });

    // ── 5~6단계 payload 조립 + (mode별) 실행
    const orders = await this.buildOrders(receipt, user, fileIndex, header, mapped, pre, ctx.resolvedFromEmail, mode);

    // ── 검산
    const builtDeliveryCount = orders.reduce((sum, o) => sum + o.deliveryCount, 0);
    const reconciliation = buildReconciliation({
      inputRowCount: parsed.rows.length,
      unmappedCount: mapped.unmappedRows.length,
      excludedCount: mapped.excludedRows.length,
      mappedCount: mapped.generalRows.length + mapped.ssgRows.length,
      builtDeliveryCount,
      // 차단 이유로 "생성돼야 할" 건수를 독립 산출 → built와 대조(사유 없는 드롭/중복계상 실검출)
      expectedBuiltCount: this.computeExpectedBuilt(mapped, pre),
    });

    // 검산 불일치(built≠기대: 사유 없는 드롭=under 또는 중복계상=over → 코드버그 신호) → 에러 로깅으로 표면화.
    // COMMIT이면 이미 createTemp로 실제 주문이 생성된 뒤이므로, 로그에 그치지 않고 throw해
    // approve 트랜잭션을 롤백한다(잘못 계상된 주문이 그대로 커밋되는 것을 방지). DRY_RUN은 로깅만.
    if (!reconciliation.matched) {
      this.logger.error(
        `자동주문 검산 불일치 [${mode}] receipt=${receipt.id} file=${fileIndex} ` +
          `expectedBuilt=${this.computeExpectedBuilt(mapped, pre)} built=${reconciliation.builtDeliveryCount} ` +
          `blocked=${reconciliation.blockedDeliveryCount}`,
      );
      if (mode === AutoOrderRunMode.COMMIT) {
        throw new Error(
          `자동주문 검산 불일치로 승인을 중단합니다(receipt=${receipt.id}, file=${fileIndex}). 중복주문 방지를 위해 롤백합니다.`,
        );
      }
    }

    const rowBlocks = pre.blocked.filter((b) => b.level === 'ROW');
    return {
      fileIndex,
      fileName,
      targetFilePath: url,
      status: 'VALID',
      message: null,
      formatErrorCode: null,
      orders,
      reconciliation,
      fileBlocked: pre.fileBlocked,
      blocked: pre.blocked.filter((b) => b.level !== 'ROW'), // FILE/ORDER
      blockedRows: rowBlocks, // ROW
      unmappedRows: mapped.unmappedRows.map((r) => ({
        rowNo: r.rowNo,
        code: r.productCode ?? '',
        reason: '미등록 상품코드',
      })),
      // 백엔드 ROW 차단(금칙어/수신처없음)을 프론트 warningRows로 표시(행별 사유 노출)
      warningRows: rowBlocks.map((b) => ({ rowNo: b.rowNo ?? 0, code: b.code, reason: b.reason })),
      excludedRows: mapped.excludedRows.map((r) => ({
        rowNo: r.rowNo,
        reason: r.statusReason ?? '_유효=False',
      })),
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
    resolvedFromEmail: string | null,
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
        fromEmail: resolvedFromEmail,
      });
      if (!result) continue; // 살아남은 수신자 0명

      // ★ createTemp를 서비스 직접 호출이라 ValidationPipe가 안 돈다 → 조립 payload를 실제 DTO로 검증(양쪽 모드).
      //   구조검증이 못 잡는 필드제약(길이 등)을 여기서 잡아 raw DB 오류/트랜잭션 파손 대신 맥락 오류로.
      //   DRY_RUN에서도 돌려 preview=commit 유지(승인 때만 뒤늦게 터지는 것 방지).
      await this.assertPayloadValid(result.payload, plan.type);

      const orderId = mode === AutoOrderRunMode.COMMIT ? await this.commitOrder(receipt, fileIndex, user, result, plan.type) : null;
      orders.push(this.toReportOrder(orderId, plan.type, header.eventName, result));
    }
    return orders;
  }

  /** 조립 payload를 createTemp DTO로 검증(class-validator). 실패 시 첫 제약 위반 메시지로 BadRequest. */
  private async assertPayloadValid(payload: BuildPayloadResult['payload'], type: IOrderType): Promise<void> {
    const errors = await validate(plainToInstance(OrderCreateTempReqDto, payload));
    if (errors.length === 0) return;
    const message = this.firstConstraintMessage(errors) ?? '알 수 없는 검증 오류';
    this.logger.error(`자동주문 payload 검증 실패(${type}): ${message}`);
    throw new BadRequestException(`자동주문 데이터 검증 실패(${type}): ${message}`);
  }

  /** 중첩 ValidationError 트리에서 첫 제약 위반 메시지를 추출 */
  private firstConstraintMessage(errors: ValidationError[]): string | null {
    for (const err of errors) {
      if (err.constraints) return Object.values(err.constraints)[0];
      if (err.children?.length) {
        const nested = this.firstConstraintMessage(err.children);
        if (nested) return nested;
      }
    }
    return null;
  }

  /**
   * 차단 이유들로 "생성돼야 할" 발송건수를 독립 산출(buildOrders/payloadBuilder 로직의 거울).
   * 검산은 이 값을 실제 built와 대조 → payload 조립이 사유 없이 행을 흘리면(build != expected) 불일치로 잡힌다.
   * (blockedRowNos는 사전검증이 general/ssg(=매핑행)만 스캔하므로 전부 매핑행에 속한다.)
   *
   * ⚠️ lockstep: payloadBuilder의 usableRows 필터(현재 !blockedRowNos + 수신처 존재)에 새 제외 조건이 추가되면
   *   여기에도 동일 조건을 반영해야 한다. 안 그러면 expectedBuilt가 과다 산출돼 정상 승인이 검산 불일치로
   *   롤백된다. (현재는 수신처-null 행이 전부 blockedRowNos에 들어가 두 필터가 등가라 안전.)
   */
  private computeExpectedBuilt(mapped: MappedResult, pre: PreValidateResult): number {
    if (pre.fileBlocked) return 0;
    const generalBuilt = mapped.generalRows.filter((r) => !pre.blockedRowNos.has(r.rowNo)).length;
    const ssgBuilt = pre.ssgOrderBlocked ? 0 : mapped.ssgRows.filter((r) => !pre.blockedRowNos.has(r.rowNo)).length;
    return generalBuilt + ssgBuilt;
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
    // createTemp는 SSG 예약창을 여기서(time-of-use) 다시 검증한다 → 사전검증이 쓴 range 스냅샷(L111)이 낡았어도
    // 창 밖 SSG는 여기서 throw로 걸러진다(리뷰 #14의 권위 가드). throw는 approve 트랜잭션을 롤백시켜 부분 커밋을 막는다.
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
      products: result.products,
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

  private invalidFile(
    fileIndex: number,
    fileName: string,
    targetFilePath: string,
    message: string | null,
    code: FormatErrorCode,
  ): AutoOrderFileResult {
    return {
      fileIndex,
      fileName,
      targetFilePath,
      status: 'INVALID_FORMAT',
      message,
      formatErrorCode: code,
      orders: [],
      reconciliation: buildReconciliation({
        inputRowCount: 0,
        unmappedCount: 0,
        excludedCount: 0,
        mappedCount: 0,
        builtDeliveryCount: 0,
        expectedBuiltCount: 0,
      }),
      fileBlocked: false,
      blocked: [],
      blockedRows: [],
      unmappedRows: [],
      warningRows: [],
      excludedRows: [],
    };
  }
}

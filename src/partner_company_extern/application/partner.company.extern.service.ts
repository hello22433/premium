import { ConflictException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { PinIssueDedupEntity } from '../../entity/pin.issue.dedup.entity';
import { SsgIssueLogEntity } from '../../entity/ssg.issue.log.entity';
import { QueryFailedError, Repository } from 'typeorm';
import { IOrderDeliveryStatus } from '../../delivery/interface/order.delivery.status';
import { ICulture } from '../interface/culture';
import { IGalaxia } from '../interface/galaxia';
import { IGsmbiz } from '../interface/gsmbiz';
import { IGiftiel } from '../interface/giftiel';
import { IGiftiShow } from '../interface/giftishow';
import { IDaou } from '../interface/daou';
import { PartnerCompanyExternHistoryEntity } from '../../entity/partner.company.extern.history.entity';
import { GiftielExchangeHistoryEntity } from '../../entity/giftiel.exchange.history.entity';
import { ISsgCheckOut, ISsgIssue } from '../interface/ssg.issue';
import { SsgCheckNotFoundError } from '../infra/ssg.issue';
import { Propagation, Transactional } from 'typeorm-transactional';
import { orderBarcodeGenerate } from '../../order/domain/order.code.generate';
import { SsgEventEntity } from '../../entity/ssg.event.entity';
import { SsgTransactionId } from '../domain/ssg.transaction.id';
import { defaultFromPhoneNumber, ssgIssueUserName } from '../../const';
import { smsSsgTemplate } from '../../delivery/domain/sms.ssg.template';
import { addDays, format, subDays } from 'date-fns';
import { OrderDeliveryCouponStatus } from '../../delivery/interface/order.delivery.coupon.status';
import { CancelCouponResDto } from '../api/CancelCouponResDto';
import { CryptoCipher } from '../../common/infra/crypto.cipher';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { parseDateString, isExpiredYMD, formatDateYMD } from '../../util/date.util';
import { applyReplaceCharacters } from '../../common/utils/replace-characters.util';
import { sleep } from '../../util/time.util';

@Injectable()
export class PartnerCompanyExternService {
  constructor(
    @Inject('IGalaxia')
    private galaxia: IGalaxia,
    @Inject('IGsmbiz')
    private gsmbiz: IGsmbiz,
    @Inject('IGiftiel')
    private giftiel: IGiftiel,
    @Inject('IGiftiShow')
    private giftiShow: IGiftiShow,
    @Inject('ICulture')
    private culture: ICulture,
    @Inject('ISsgIssue')
    private ssgIssue: ISsgIssue,
    @Inject('IDaou')
    private daou: IDaou,
    @InjectRepository(OrderDeliveryEntity)
    private orderDeliveryRepository: Repository<OrderDeliveryEntity>,
    @InjectRepository(PartnerCompanyExternHistoryEntity)
    private partnerCompanyExternHistoryRepository: Repository<PartnerCompanyExternHistoryEntity>,
    @InjectRepository(PartnerCompanyEntity)
    private partnerCompanyRepository: Repository<PartnerCompanyEntity>,
    @InjectRepository(PinIssueDedupEntity)
    private pinIssueDedupRepository: Repository<PinIssueDedupEntity>,
    @InjectRepository(SsgIssueLogEntity)
    private ssgIssueLogRepository: Repository<SsgIssueLogEntity>,
    @InjectRepository(GiftielExchangeHistoryEntity)
    private giftielExchangeHistoryRepository: Repository<GiftielExchangeHistoryEntity>,
    private cryptoCipher: CryptoCipher,
  ) {}

  private logger = new Logger('PARTNER_COMPANY_EXTERN');

  // SSG API 동시 호출 방지를 위한 Mutex (한 번에 1개씩만 실행)
  private ssgApiMutex: Promise<void> = Promise.resolve();

  /**
   * SSG API 호출을 순차적으로 실행하기 위한 래퍼
   * 여러 곳에서 동시에 SSG API를 호출해도 한 번에 1개씩만 실행됨
   */
  private async withSsgMutex<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const waitForPrevious = this.ssgApiMutex;
    this.ssgApiMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    await waitForPrevious;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  /**
   * SSG check() API를 재시도 포함하여 호출 (최대 3회: 1차 + 2차 재시도)
   * SsgCheckNotFoundError는 정상 응답이므로 재시도 없이 즉시 throw
   */
  private async checkSsgWithRetry(params: { eventNo: string; eventSeq: number; vno: string }): Promise<ISsgCheckOut> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.ssgIssue.check(params);
      } catch (e) {
        if (e instanceof SsgCheckNotFoundError) {
          throw e;
        }
        lastError = e;
        if (attempt < maxAttempts) {
          this.logger.warn(
            `[SSG] check() 실패, ${attempt}차 재시도 예정 (${attempt}/${maxAttempts}): ${e instanceof Error ? e.message : e}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    throw lastError;
  }

  @Transactional({ propagation: Propagation.REQUIRED })
  async issue(orderDelivery: OrderDeliveryEntity, ssgEvent: SsgEventEntity | null) {
    const type = orderDelivery.orderProductMapping!.product.partnerCompany!.type;

    // deliveryTarget 복호화
    const decryptedDeliveryTarget = this.cryptoCipher.safeDecryptDeliveryTarget(orderDelivery.deliveryTarget) ?? orderDelivery.deliveryTarget;

    let context = '';
    let isSuccess = true;
    if (!orderDelivery.transactionId) {
      throw new Error('transaction id not exist');
    }

    // PIN 발급 중복 방지: 같은 transactionId로 동시에 issue()가 두 번 호출되는 것을 차단
    // (배치 vs 수동 동시 호출 등). 모든 협력사가 동일 로직으로 관리된다.
    //
    // CULTURELAND의 0099 복구 프로토콜도 dedup과 호환된다:
    // 1차 실패(0099 throw) → @Transactional 롤백 → dedup row 자동 삭제
    // 2차 재시도(동일 trId) → INSERT 정상 → 협력사가 기존 PIN 반환(0000) → 성공
    //
    // conflict 발생 시 즉시 throw하지 않고, 먼저 끝난 트랜잭션의 bar_code를 읽어와
    // 그대로 이어받는다(인라인 recovery). InnoDB row lock 특성상 B가 ER_DUP_ENTRY를 보는 시점에는
    // A가 이미 commit 완료 상태이므로 A의 bar_code는 반드시 존재함이 보장된다.
    if (type) {
      try {
        await this.pinIssueDedupRepository.insert({
          transactionId: orderDelivery.transactionId,
          orderDeliveryId: orderDelivery.id,
          partnerType: type,
          recoveredFrom: 'FRESH_ISSUE',
          issuedAt: new Date(),
        });
      } catch (e) {
        if (e instanceof QueryFailedError && (e as QueryFailedError & { code?: string }).code === 'ER_DUP_ENTRY') {
          const existing = await this.pinIssueDedupRepository.findOne({
            where: { transactionId: orderDelivery.transactionId },
          });

          if (existing?.barCode) {
            // 상대 트랜잭션이 이미 성공 완료한 상태 → 그 bar_code를 그대로 이어받고 협력사 호출 생략
            this.logger.warn(
              `[PIN_DEDUP] 중복 감지 - 기존 발급 이어받음. transactionId: ${orderDelivery.transactionId}, orderDeliveryId: ${orderDelivery.id}, type: ${type}, barCode: ${existing.barCode}`,
            );
            orderDelivery.barCode = existing.barCode;
            await this.pinIssueDedupRepository.update(
              { transactionId: orderDelivery.transactionId },
              { recoveredFrom: 'DEDUP' },
            );
            return;
          }

          // 이론상 도달 불가 경로(conflict 시점에는 상대가 성공 커밋되어 bar_code가 있어야 함).
          // 안전 가드로 ConflictException 유지 — 운영 중 발생하면 로그로 조사 가능.
          this.logger.error(
            `[PIN_DEDUP] 중복 감지되었으나 기존 bar_code 복구 실패 - transactionId: ${orderDelivery.transactionId}, orderDeliveryId: ${orderDelivery.id}, type: ${type}`,
          );
          throw new ConflictException(
            `이미 동일 거래번호로 PIN 발급 요청이 진행 중입니다. (transactionId: ${orderDelivery.transactionId})`,
          );
        }
        throw e;
      }
    }

    try {
      if (!type || orderDelivery.orderProductMapping.product.type === 'SELF') {
        orderDelivery.barCode = orderBarcodeGenerate();
        return;
      }

      // 1.1.1 갤럭시아 쿠폰 발급
      // 표준연동발행규격서 v.1.6.8_갤럭시아머니트리.pdf
      if (type === 'GALAXIA') {
        // 이미 발급된 쿠폰이 있으면 중복 호출 방지
        if (orderDelivery.barCode && orderDelivery.couponNum) {
          this.logger.warn(
            `[GALAXIA] 이미 발급된 쿠폰 존재 - barCode: ${orderDelivery.barCode}, couponNum: ${orderDelivery.couponNum}, 발급 skip`,
          );
          return;
        }

        const giftKind = orderDelivery.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
        // 개인정보 보호: 백화점(dept)만 실제 전화번호 전달, 그 외는 더미 번호 사용
        const phoneNumberForGalaxia = giftKind === 'dept' ? decryptedDeliveryTarget : '01000000000';
        const galaxiaOut = await this.galaxia.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          fromPhoneNumber: phoneNumberForGalaxia,
          giftKind,
          // 백화점(dept) 상품권의 경우 액면가 필수
          faceValue: giftKind === 'dept' ? String(orderDelivery.orderProductMapping.product.price) : undefined,
          // cpn의 경우 duration 전달: OPM override ?? Product 기본값 (미설정 시 undefined → HTTP 레이어에서 0으로 변환)
          duration: giftKind === 'cpn' ? (orderDelivery.orderProductMapping.galaxiaDuration ?? orderDelivery.orderProductMapping.product.galaxiaDuration ?? undefined) : undefined,
        });
        context = JSON.stringify(galaxiaOut);

        // 409 복구 응답의 경우 barcode가 비어있을 수 있음 - couponNum(trId)은 저장
        orderDelivery.couponNum = galaxiaOut.transactionId;
        if (galaxiaOut.giftCertificate.barcode) {
          orderDelivery.barCode = galaxiaOut.giftCertificate.barcode;
        } else {
          // barcode 없이 couponNum만 복구된 경우 (409 중복 복구)
          this.logger.warn(
            `[GALAXIA] 중복 복구: barcode 없음, couponNum(trId): ${galaxiaOut.transactionId}. ` +
            `transactionId: ${orderDelivery.transactionId}`,
          );
        }
      }

      // 1.1.2 GSMBIZ 쿠폰 발급
      // GSM쿠폰_전문사양서_고객사_표준V3.4_20200529.pdf
      if (type === 'GS_M_BIZ') {
        const gsMBizOut = await this.gsmbiz.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        });
        context = JSON.stringify(gsMBizOut);
        orderDelivery.barCode = gsMBizOut.couponInfo.barCode;
      }

      // 1.1.3 Giftiel 쿠폰 발급
      // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
      if (type === 'GIFTIEL') {
        const giftielOut = await this.giftiel.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        });

        context = JSON.stringify(giftielOut);

        // GIFTIEL 응답 가드: 실패 응답(예: 0227 중복)일 때 CouponList가 비어있어
        // 기존 코드(CouponList[0].CouponNum)가 TypeError를 내면서 실제 원인이 묻혔다.
        // 협력사 응답 코드/메시지가 history에 그대로 남도록 명시적으로 throw한다.
        if (giftielOut.ResultCode !== '0000' || !giftielOut.CouponList?.length) {
          throw new Error(
            `GIFTIEL 발급 실패: ${giftielOut.ResultCode} - ${giftielOut.ResultMsg}`,
          );
        }
        orderDelivery.barCode = giftielOut.CouponList[0].CouponNum;
      }

      // 1.1.4 giftshow 쿠폰 발급
      // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
      if (type === 'GIFT_SHOW') {
        const giftShowOut = await this.giftiShow.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
        });
        context = JSON.stringify(giftShowOut);

        const responseCode = giftShowOut.response.result[0].code[0];
        const responseReason = giftShowOut.response.result[0].reason[0];

        if (responseCode === '1000') {
          // 성공
          const pinNo = giftShowOut.response.value[0].pin_no[0];
          if (!pinNo || pinNo === 'null') {
            throw new Error('GIFT_SHOW 발급 성공이나 pin_no가 유효하지 않습니다');
          }
          orderDelivery.barCode = pinNo;
        } else if (responseCode === '3001') {
          // 중복 요청 - 기존 발급된 PIN 조회
          this.logger.warn(`GIFT_SHOW 중복 요청 감지 - transactionId: ${orderDelivery.transactionId}, 기존 PIN 조회 시도`);
          const checkResult = await this.giftiShow.check({
            transactionId: orderDelivery.transactionId,
          });

          if (checkResult.resCode === '0000' && checkResult.couponInfo?.pinNo) {
            // 기존 PIN 조회 성공 - 같은 transactionId로 발급된 PIN이므로 동일 주문
            this.logger.log(`GIFT_SHOW 기존 PIN 조회 성공 - pinNo: ${checkResult.couponInfo.pinNo}`);
            orderDelivery.barCode = checkResult.couponInfo.pinNo;
          } else {
            // 기존 PIN 조회 실패 - 이상한 상황
            throw new Error(`GIFT_SHOW 중복 요청이나 기존 PIN 조회 실패: ${checkResult.resCode} - ${checkResult.resMsg}`);
          }
        } else {
          // 기타 에러
          throw new Error(`GIFT_SHOW 발급 실패: ${responseCode} - ${responseReason}`);
        }
      }

      // 1.1.5 컬쳐랜드 쿠폰 발급
      // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
      if (type === 'CULTURELAND') {
        const cultureLandOut = await this.culture.issue({
          transactionId: orderDelivery.transactionId,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          expireDay: orderDelivery.orderProductMapping.product.expireDay,
          price: orderDelivery.orderProductMapping.product.price,
        });
        context = JSON.stringify(cultureLandOut);

        // 성공 응답인 경우에만 barCode 설정
        if (cultureLandOut.ResultCode === '0000') {
          orderDelivery.barCode = cultureLandOut.ScrachNo;
          orderDelivery.couponNum = cultureLandOut.CertNo;
        } else {
          throw new Error(`컬쳐랜드 PIN 발급 실패: ${cultureLandOut.ResultCode}`);
        }
      }

      // 1.1.6 신세계 상품권 발행
      // PIN 생성~중복확인~INSERT 전체를 Mutex로 직렬화하여 동시 요청 간 PIN 충돌 방지
      // (PM2 단일 인스턴스 전제)
      if (type === 'SSG') {
        if (!ssgEvent) {
          throw new InternalServerErrorException('ssg event 가 존재하지 않습니다.');
        }

        // 1) 기존 PIN이 있으면 SSG DB 등록 여부 확인 (mutex 불필요: 새 PIN 생성과 경쟁하지 않음)
        let needsInsert = true;
        if (orderDelivery.barCode && orderDelivery.personalCode) {
          try {
            await this.checkSsgWithRetry({
              eventNo: ssgEvent.no,
              eventSeq: ssgEvent.order,
              vno: orderDelivery.personalCode,
            });
            // 조회 성공 → INSERT는 됐고 발송만 실패한 경우
            needsInsert = false;
            this.logger.log(
              `[SSG] 기존 PIN이 SSG DB에 등록됨 - barCode: ${orderDelivery.barCode}, INSERT 건너뜀`,
            );
          } catch (e) {
            if (e instanceof SsgCheckNotFoundError) {
              // API 정상 응답 + code ≠ 1001 → PIN 미등록 확정 → 새 PIN 생성
              this.logger.log(
                `[SSG] 기존 PIN이 SSG DB에 미등록 - barCode: ${orderDelivery.barCode}, 새 PIN 생성`,
              );
              orderDelivery.barCode = null;
              orderDelivery.personalCode = null;
            } else {
              // 네트워크 에러, 타임아웃 등 → 등록 여부 불명 → 안전을 위해 중단
              this.logger.error(
                `[SSG] SSG DB 조회 중 네트워크 오류 발생 - barCode: ${orderDelivery.barCode}, 안전을 위해 중단`,
              );
              throw e;
            }
          }
        }

        // 2~4단계를 Mutex로 직렬화: PIN 생성~중복확인~INSERT 간 경쟁 조건 방지
        context = await this.withSsgMutex(async () => {
          // 2) 새 PIN 생성 (최초 발송 또는 INSERT 실패 시) + 2중 중복 확인
          if (!orderDelivery.barCode || !orderDelivery.personalCode) {
            const maxRetries = 5;
            let generated = false;
            for (let i = 0; i < maxRetries; i++) {
              const { barCode, personalCode } = this.ssgIssue.generateSsgIssue();

              // 1차 중복 확인: 로컬 ssg_issue_log (빠름)
              const localDuplicate = await this.ssgIssueLogRepository.findOne({
                where: [
                  { barCode },
                  { personalCode },
                ],
              });
              if (localDuplicate) {
                this.logger.warn(
                  `[SSG] 로컬 블랙리스트 중복 감지 - barCode: ${barCode}, personalCode: ${personalCode}, 재생성 시도 (${i + 1}/${maxRetries})`,
                );
                continue;
              }

              // 2차 중복 확인: SSG DB (느림)
              try {
                await this.checkSsgWithRetry({
                  eventNo: ssgEvent.no,
                  eventSeq: ssgEvent.order,
                  vno: personalCode,
                });
                // 조회 성공 = 중복
                this.logger.warn(
                  `[SSG] SSG DB 중복 감지 - personalCode: ${personalCode}, 재생성 시도 (${i + 1}/${maxRetries})`,
                );
                continue;
              } catch (e) {
                if (e instanceof SsgCheckNotFoundError) {
                  // API 정상 응답 + 미등록 = 사용 가능
                  orderDelivery.barCode = barCode;
                  orderDelivery.personalCode = personalCode;
                  generated = true;
                  this.logger.log(`[SSG] PIN 생성 완료 - barCode: ${barCode}, personalCode: ${personalCode}`);
                  break;
                }
                // 네트워크 에러 → 중복 여부 불명 → 안전을 위해 중단
                this.logger.error(`[SSG] PIN 중복 확인 중 네트워크 오류 발생 - personalCode: ${personalCode}, 안전을 위해 중단`);
                throw e;
              }
            }
            if (!generated) {
              throw new Error(`SSG PIN 생성 ${maxRetries}회 시도 후에도 중복 발생`);
            }
          }

          // 3) 유효기간 및 트랜잭션 ID 설정
          // needsInsert=false(PIN이 이미 SSG DB에 등록된 경우)일 때는 기존 유효기간 보존
          // → SSG DB의 실제 유효기간과 안내 유효기간 불일치 방지
          if (needsInsert) {
            orderDelivery.ssgTransactionId = SsgTransactionId.makeSsgTrade();
            orderDelivery.expireAt = addDays(
              new Date(),
              orderDelivery.orderProductMapping.product.expireDay - 1,
            );
            const encourageDay = orderDelivery.orderProductMapping.encourageDay;
            if (encourageDay) {
              orderDelivery.encourageAt = subDays(orderDelivery.expireAt, encourageDay);
            }
          }

          // 4) SSG DB INSERT (필요한 경우에만)
          if (needsInsert) {
            let text = orderDelivery.orderProductMapping.sendContent ?? '';

            if (orderDelivery.orderProductMapping.sendTailText) {
              text += orderDelivery.orderProductMapping.sendTailText;
            }
            text = applyReplaceCharacters(text, orderDelivery);

            const textForSsg = text + smsSsgTemplate(orderDelivery);

            const callBackNumber = orderDelivery.orderProductMapping.fromPhoneNumber || defaultFromPhoneNumber;

            // SSG INSERT 직전: 로컬 블랙리스트에 기록 (REQUIRES_NEW → 롤백 불가)
            await this.saveSsgIssueLog(
              orderDelivery.barCode!,
              orderDelivery.personalCode!,
              orderDelivery.id,
              orderDelivery.ssgTransactionId!,
              ssgEvent.no,
            );

            const response = await this.ssgIssue.issue({
              eventNo: ssgEvent.no,
              eventSeq: ssgEvent.order,
              eventKey: ssgEvent.code,
              vno: orderDelivery.personalCode!,
              pinNo: orderDelivery.barCode!,
              userName: ssgIssueUserName,
              userAmount: String(orderDelivery.orderProductMapping.product.price),
              msgContent: textForSsg,
              trId: orderDelivery.ssgTransactionId!,
              callBack: callBackNumber,
            });
            return JSON.stringify(response);
          }

          return '';
        });

        // SSG의 SsgCoupon.do는 Oracle INSERT만 수행하며 문자 발송은 하지 않음
        // actualSendAt은 실제 SMS/알림톡 발송 성공 시 delivery.batch.service에서 설정됨
      }

      // 1.1.7 다우기술 PIN 발급
      if (type === 'DAOU') {
        const daouOut = await this.daou.issue({
          goodsId: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          transactionId: orderDelivery.transactionId,
          phoneNumber: '01000000000', // 개인정보 보호: 더미 번호 사용
          limitDate: String(orderDelivery.orderProductMapping.product.expireDay),
          tradeNo: orderDelivery.transactionId, // tradeNo로 transactionId 사용
        });
        context = JSON.stringify(daouOut);

        // 성공 응답인 경우에만 barCode 설정
        if (daouOut.resultCode === 'S000001' && daouOut.pinNo) {
          orderDelivery.barCode = daouOut.pinNo;
          orderDelivery.couponNum = daouOut.tsId || null; // TS_ID를 couponNum에 저장
        } else {
          throw new Error(daouOut.resultMessage || '다우기술 PIN 발급 실패');
        }
      }

      this.logger.log(orderDelivery.barCode);
      if (!orderDelivery.barCode) {
        throw new Error('barCode not exist');
      }

      // dedup 레코드에 발급된 PIN 기록 (감사용)
      if (type) {
        await this.pinIssueDedupRepository.update(
          { transactionId: orderDelivery.transactionId },
          { barCode: orderDelivery.barCode },
        );
      }
    } catch (e) {
      this.logger.error(e);

      // Error 객체 직렬화 개선 (Error의 message, stack은 non-enumerable이라 JSON.stringify 시 {}가 됨)
      if (e instanceof Error) {
        context = JSON.stringify({ message: e.message, stack: e.stack });
      } else {
        context = JSON.stringify(e);
      }
      isSuccess = false;
      orderDelivery.status = IOrderDeliveryStatus.FAIL;
      if (!orderDelivery.failedAt) {
        orderDelivery.failedAt = new Date();
      }

      // 실패 시 이력을 별도 트랜잭션으로 먼저 저장 (롤백 방지)
      if (type !== null) {
        await this.saveHistoryInNewTransaction(context, isSuccess, type, orderDelivery.id);
      }

      throw e;
    } finally {
      // 성공 시에만 finally에서 이력 저장 (실패 시는 catch에서 이미 저장됨)
      if (type !== null && isSuccess) {
        await this.partnerCompanyExternHistoryRepository.insert({
          context,
          isSuccess,
          type: type!,
          orderDeliveryId: orderDelivery.id,
        });
      }
    }
  }

  /**
   * SSG INSERT 시도 전 로컬 블랙리스트에 기록 (메인 트랜잭션 롤백 시에도 유지)
   * INSERT 성공/실패 여부와 무관하게 이 PIN은 재사용하지 않는다.
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async saveSsgIssueLog(
    barCode: string,
    personalCode: string,
    orderDeliveryId: number,
    ssgTransactionId: string,
    eventNo: string,
  ): Promise<void> {
    await this.ssgIssueLogRepository.insert({
      barCode,
      personalCode,
      orderDeliveryId,
      ssgTransactionId,
      eventNo,
      insertedAt: new Date(),
    });
  }

  /**
   * 별도 트랜잭션으로 이력 저장 (메인 트랜잭션 롤백 시에도 이력 유지)
   */
  @Transactional({ propagation: Propagation.REQUIRES_NEW })
  private async saveHistoryInNewTransaction(
    context: string,
    isSuccess: boolean,
    type: IPartnerCompanyType,
    orderDeliveryId: number,
  ): Promise<void> {
    await this.partnerCompanyExternHistoryRepository.insert({
      context,
      isSuccess,
      type,
      orderDeliveryId,
    });
  }

  /**
   * 외부 API 전용 취소.
   * 5xx / 네트워크 타임아웃에 한해 1·2·4·8·16초 backoff로 최대 5회 재시도.
   * 4xx 등 비-재시도 에러는 즉시 throw.
   * 멱등성: 협력사 cancel API는 동일 trId 재호출에 안전하다는 가정.
   */
  async cancelByExternalApi(orderDelivery: OrderDeliveryEntity): Promise<CancelCouponResDto> {
    const delays = [1000, 2000, 4000, 8000, 16000];
    const maxAttempts = delays.length;
    let lastError: any;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.cancel(orderDelivery);
      } catch (error: any) {
        lastError = error;
        if (!this.isRetryableCancelError(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        this.logger.warn(
          `[cancelByExternalApi] 재시도 ${attempt + 1}/${maxAttempts} - delay ${delays[attempt]}ms - ${error?.message ?? error}`,
        );
        await sleep(delays[attempt]);
      }
    }

    throw lastError;
  }

  private isRetryableCancelError(error: any): boolean {
    const code = error?.code;
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED') {
      return true;
    }
    const status = error?.response?.status ?? error?.status;
    return typeof status === 'number' && status >= 500 && status < 600;
  }

  @Transactional({ propagation: Propagation.REQUIRED })
  async cancel(orderDelivery: OrderDeliveryEntity): Promise<CancelCouponResDto> {
    // 초이스쿠폰의 경우 선택한 상품의 협력사를 우선 사용
    const choicePartnerType = orderDelivery.choiceSelectProduct?.partnerCompany?.type;
    const productPartnerType = orderDelivery.orderProductMapping?.product?.partnerCompany?.type;
    const type = choicePartnerType ?? productPartnerType;

    // 핀 미발급 건(barCode 없음): 외부 API에 등록된 PIN이 없으므로 호출 생략
    if (!orderDelivery.barCode) {
      orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
      return {
        code: '',
        message: '폐기 완료',
      } as CancelCouponResDto;
    }

    try {
      // 1.1.1 갤럭시아 쿠폰 발급
      // 표준연동발행규격서 v.1.6.8_갤럭시아머니트리.pdf
      if (type === 'GALAXIA') {
        const giftKind = orderDelivery.orderProductMapping.product.name.includes('(백화점)') ? 'dept' : 'cpn';
        await this.galaxia.cancel({
          transactionId: orderDelivery.transactionId!,
          sendRequestAt: +format(orderDelivery.sendRequestAt, 'yyyyMMdd'),
          giftKind,
          trId: orderDelivery.couponNum!,
        });
      }

      // 1.1.2 GSMBIZ 쿠폰 발급
      // GSM쿠폰_전문사양서_고객사_표준V3.4_20200529.pdf
      if (type === 'GS_M_BIZ') {
        await this.gsmbiz.cancel({
          transactionId: orderDelivery.transactionId!,
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          barCode: orderDelivery.barCode!,
        });
      }

      // 1.1.3 Giftiel 쿠폰 발급
      // giftiel(기프티엘)_공통_판매사_연동가이드_v2.1.0.0_20210409.pdf
      if (type === 'GIFTIEL') {
        await this.giftiel.cancel({
          partnerCompanyCode: orderDelivery.orderProductMapping.product.partnerCompanyCode!,
          barCode: orderDelivery.barCode!,
        });
      }

      // 1.1.4 giftshow 쿠폰 발급
      // 기프티쇼_매체_연동규격서_v1.9.1.2.pdf
      if (type === 'GIFT_SHOW') {
        await this.giftiShow.cancel({
          transactionId: orderDelivery.transactionId!,
        });
      }

      // 1.1.5 컬쳐랜드 쿠폰 발급
      // 컬쳐랜드상품권(모바일문화상품권)_구매_연동가이드_V3.0.pdf
      if (type === 'CULTURELAND') {
        await this.culture.cancel({
          barCode: orderDelivery.barCode!,
          expireDay: orderDelivery.orderProductMapping.product.expireDay,
        });
      }

      // 1.1.7 다우기술 쿠폰 취소
      if (type === 'DAOU') {
        const daouCancelOut = await this.daou.cancel({
          pinNo: orderDelivery.barCode!,
        });

        // 취소 실패 시 에러 발생
        if (daouCancelOut.resultCode !== 'S000001') {
          throw new Error(daouCancelOut.resultMessage || '다우기술 쿠폰 취소 실패');
        }
      }

      // 1.1.6 신세계 및 없는 type 은 타입만 수정
      orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;

      return {
        code: '',
        message: '폐기 완료',
      } as CancelCouponResDto;
    } catch (e) {
      this.logger.error(e);
      return {
        code: '',
        message: '잠시 후 다시 시도해 주세요.',
      } as CancelCouponResDto;
    }
  }

  async refreshCouponStatus(orderDelivery: OrderDeliveryEntity): Promise<OrderDeliveryEntity> {
    // 초이스쿠폰의 경우 선택한 상품의 협력사를 우선 확인
    const choicePartnerType = orderDelivery.choiceSelectProduct?.partnerCompany?.type;
    const productPartnerType = orderDelivery.orderProductMapping.product.partnerCompany?.type;
    let partnerType = choicePartnerType ?? productPartnerType;

    if (!partnerType) {
      // TypeORM 깊은 relation 로딩 간헐 실패 대비 — 직접 조회 fallback
      const product = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping?.product;
      if (!product?.partnerCompanyId) {
        throw new Error(`상품 정보를 찾을 수 없습니다. (orderDeliveryId: ${orderDelivery.id})`);
      }
      const partnerCompany = await this.partnerCompanyRepository.findOne({
        where: { id: product.partnerCompanyId },
      });
      if (!partnerCompany?.type) {
        throw new Error(`협력사 정보를 찾을 수 없습니다. (orderDeliveryId: ${orderDelivery.id}, partnerCompanyId: ${product.partnerCompanyId})`);
      }
      this.logger.warn(`partnerCompany relation 로딩 누락 fallback 발동 (orderDeliveryId: ${orderDelivery.id})`);
      partnerType = partnerCompany.type;
    }

    switch (partnerType) {
      // 1. GALAXIA
      case 'GALAXIA': {
        const baseProduct = orderDelivery.choiceSelectProduct ?? orderDelivery.orderProductMapping.product;

        const giftKind: 'dept' | 'cpn' = baseProduct.name.includes('(백화점)') ? 'dept' : 'cpn';

        const { giftCertificate } = await this.galaxia.check({
          giftKind,
          paramValue: orderDelivery.couponNum!,
        });

        // couponStatus 우선 확인: CANCEL, INACTIVE 상태 처리
        if (giftCertificate.couponStatus === 'CANCEL') {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
        } else if (giftCertificate.couponStatus === 'INACTIVE') {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
        } else {
          // ACTIVE 상태일 때 isUsed + validTo로 판단
          if (giftCertificate.isUsed) {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
          } else if (isExpiredYMD(giftCertificate.validTo)) {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
          } else {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
          }
        }
        orderDelivery.tradeAt = parseDateString(giftCertificate.usedDate);
        orderDelivery.galaxiaBalance = Number(giftCertificate.balance);
        break;
      }

      // 2. GS_M_BIZ
      case 'GS_M_BIZ': {
        const partnerCompanyCode =
          orderDelivery.choiceSelectProduct?.partnerCompanyCode ??
          orderDelivery.orderProductMapping.product.partnerCompanyCode!;

        const { couponInfo } = await this.gsmbiz.check({
          transactionId: orderDelivery.transactionId!,
          partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });

        orderDelivery.couponStatus =
          couponInfo.STATE === '10' ? OrderDeliveryCouponStatus.USED : OrderDeliveryCouponStatus.NOT_USED;
        orderDelivery.tradeAt = couponInfo.USE_DT ? new Date(couponInfo.USE_DT) : null;
        break;
      }

      // 3. GIFTIEL
      case 'GIFTIEL': {
        const partnerCompanyCode =
          orderDelivery.choiceSelectProduct?.partnerCompanyCode ??
          orderDelivery.orderProductMapping.product.partnerCompanyCode!;

        const giftielOut = await this.giftiel.check({
          partnerCompanyCode,
          barCode: orderDelivery.barCode!,
        });

        if (giftielOut.UseYn === 'Y') {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
          const latestPush = await this.giftielExchangeHistoryRepository.findOne({
            where: { orderDeliveryId: orderDelivery.id },
            order: { authDate: 'DESC' },
          });
          if (latestPush?.cmdType !== 'L1') {
            orderDelivery.tradeAt = giftielOut.UseDate
              ? parseDateString(giftielOut.UseDate.replace(/[-:\s]/g, ''))
              : null;
            orderDelivery.tradePlace = giftielOut.BiName || null;
          }
        } else {
          // GIFTIEL은 만료 상태를 별도로 내려주지 않으므로 DayEnd(yyyy-MM-dd)로 보정
          const dayEndYMD = giftielOut.DayEnd?.replace(/-/g, '');
          orderDelivery.couponStatus =
            dayEndYMD && isExpiredYMD(dayEndYMD)
              ? OrderDeliveryCouponStatus.EXPIRED
              : OrderDeliveryCouponStatus.NOT_USED;
          orderDelivery.tradeAt = null;
          orderDelivery.tradePlace = null;
        }
        break;
      }

      // 4. GIFT_SHOW (V2 API)
      case 'GIFT_SHOW': {
        const giftiShowOut = await this.giftiShow.check({
          transactionId: orderDelivery.transactionId!,
        });

        if (giftiShowOut.resCode !== '0000' || !giftiShowOut.couponInfo) {
          throw new Error(`GiftiShow API 오류: ${giftiShowOut.resCode} - ${giftiShowOut.resMsg}`);
        }

        const { pinStatusCd, exchDtm, tradeBranchNm, branchNm, useComNm } = giftiShowOut.couponInfo;

        // pinStatusCd: 01=발행, 02=교환, 07=취소, 08=만료, 11=잔액기간만료(일부 사용 후 잔액 만료)
        switch (pinStatusCd) {
          case '01':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
            break;
          case '02':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
            if (exchDtm) {
              orderDelivery.tradeAt = parseDateString(exchDtm);
            }
            // 교환장소: tradeBranchNm > branchNm > useComNm 순으로 사용
            orderDelivery.tradePlace = tradeBranchNm || branchNm || useComNm || null;
            break;
          case '11':
            // 잔액기간만료: 사용 이력(exchDtm)이 있으면 교환, 없으면 만료
            if (exchDtm) {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
              orderDelivery.tradeAt = parseDateString(exchDtm);
              orderDelivery.tradePlace = tradeBranchNm || branchNm || useComNm || null;
            } else {
              orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
            }
            break;
          case '07':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
            break;
          case '08':
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
            break;
          default:
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        }
        break;
      }

      // 5. CULTURELAND
      case 'CULTURELAND': {
        const expireDay =
          orderDelivery.choiceSelectProduct?.expireDay ?? orderDelivery.orderProductMapping.product.expireDay;

        const cultureLandOut = await this.culture.check({
          scrachNo: orderDelivery.barCode!,
          certNo: orderDelivery.couponNum!, // 상품권 관리번호
          requestAt: orderDelivery.sendRequestAt!,
          expireDay,
        });

        // ResultCode 9006: 유효기간 만료된 상품권
        if (cultureLandOut.ResultCode === '9006') {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
        } else if (cultureLandOut.ResultCode === '0000') {
          const isUsed = cultureLandOut.CancelPossibility === 'N';
          orderDelivery.couponStatus = isUsed
            ? OrderDeliveryCouponStatus.USED
            : OrderDeliveryCouponStatus.NOT_USED;
          // 컬쳐랜드 check API는 사용일시를 제공하지 않으므로
          // 첫 USED 전환 시점만 기록하고, 이후 재조회로 갱신하지 않는다
          if (isUsed && !orderDelivery.tradeAt) {
            orderDelivery.tradeAt = new Date();
          }
        } else {
          this.logger.warn(
            `CULTURELAND check 실패 - ResultCode: ${cultureLandOut.ResultCode}, ErrMsg: ${cultureLandOut.ErrMsg}`,
          );
        }
        break;
      }

      // SSG
      case 'SSG': {
        // SSG는 폐기 정보가 연동 DB(CUST_INFO_RESULT)에 반영되지 않음
        // 이미 폐기된 쿠폰은 상태조회 시 상태를 변경하지 않음
        if (
          orderDelivery.couponStatus === OrderDeliveryCouponStatus.CANCEL ||
          orderDelivery.couponStatus === OrderDeliveryCouponStatus.REFUND_CANCEL
        ) {
          break;
        }

        if (!orderDelivery.ssgEvent) {
          throw new Error('ssgEvent not loaded on orderDelivery');
        }
        if (!orderDelivery.personalCode) {
          throw new Error('personalCode is null');
        }

        const ssgOut = await this.ssgIssue.check({
          eventNo: orderDelivery.ssgEvent.no,
          eventSeq: orderDelivery.ssgEvent.order,
          vno: orderDelivery.personalCode,
        });

        const resultCd = ssgOut.response.value[0].resultCd[0];
        const isExchanged = resultCd === '0400';
        if (isExchanged) {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
        } else if (orderDelivery.expireAt && isExpiredYMD(formatDateYMD(orderDelivery.expireAt))) {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.EXPIRED;
        } else {
          orderDelivery.couponStatus = OrderDeliveryCouponStatus.NOT_USED;
        }

        // 교환 완료 시 교환장소(payaccntNm)와 교환일시(executeDate) 저장
        if (isExchanged) {
          const payaccntNm = ssgOut.response.value[0].payaccntNm?.[0];
          const executeDate = ssgOut.response.value[0].executeDate?.[0];

          if (payaccntNm && payaccntNm.trim()) {
            orderDelivery.tradePlace = payaccntNm.trim();
          }
          if (executeDate) {
            orderDelivery.tradeAt = new Date(executeDate);
          }
        }
        break;
      }

      // 7. DAOU
      case 'DAOU': {
        const daouCheckOut = await this.daou.check({
          barCode: orderDelivery.barCode ?? undefined,
          transactionId: orderDelivery.transactionId ?? undefined,
        });

        // 응답 코드 확인
        if (daouCheckOut.resultCode === 'S000001') {
          // CPN_STATUS: 00(미사용), 01(교환완료), 02(기취소), 03(사용중)
          if (daouCheckOut.cpnStatus === '00') {
            // DAOU는 만료 상태를 별도로 내려주지 않으므로 CPN_END로 보정
            orderDelivery.couponStatus =
              daouCheckOut.cpnEnd && isExpiredYMD(daouCheckOut.cpnEnd)
                ? OrderDeliveryCouponStatus.EXPIRED
                : OrderDeliveryCouponStatus.NOT_USED;
          } else if (daouCheckOut.cpnStatus === '01' || daouCheckOut.cpnStatus === '03') {
            // 01: 교환완료, 03: 사용중 - 둘 다 USED로 처리
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.USED;
            orderDelivery.tradeAt = parseDateString(daouCheckOut.useDate);
            // 사용처가 있으면 tradePlace에 설정
            if (daouCheckOut.useBranch) {
              orderDelivery.tradePlace = daouCheckOut.useBranch;
            }
          } else if (daouCheckOut.cpnStatus === '02') {
            orderDelivery.couponStatus = OrderDeliveryCouponStatus.CANCEL;
          }
        } else {
          throw new Error(`DAOU 쿠폰 상태 조회 실패: ${daouCheckOut.resultMessage}`);
        }
        break;
      }

      // 기타
      default:
        throw new Error(`Unsupported partnerCompany type: ${partnerType}`);
    }

    // 저장
    return this.orderDeliveryRepository.save(orderDelivery);
  }
}

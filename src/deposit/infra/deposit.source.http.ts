import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import {
  DepositSourcePage,
  DepositSourcePermanentError,
  DepositSourceStatus,
  DepositSourceTransientError,
} from '../interface/deposit.source';

const DEFAULT_TIMEOUT_MS = 30_000;
/** 상태 조회는 화면 요청 경로에서 일어나므로 사람이 기다릴 수 있는 시간으로 짧게 끊는다. */
const DEFAULT_STATUS_TIMEOUT_MS = 3_000;

/**
 * erp_macro 조회 API 클라이언트.
 *
 * ⚠️ 설정을 생성자에서 getOrThrow 하지 않는다. 이 API 는 상대 쪽 구현·회선 개통 전까지
 * 존재하지 않고, 그때까지 동기화는 꺼져 있다(DEPOSIT_SYNC_ENABLED=false).
 * 생성자에서 던지면 env 가 안 채워진 환경의 앱 부팅 자체가 깨진다. 실제 호출 시점에 검증한다.
 */
@Injectable()
export class DepositSourceHttp {
  private logger = new Logger('DEPOSIT_SYNC');

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {}

  private resolveConfig(): { baseUrl: string; apiKey: string; timeoutMs: number } {
    const baseUrl = this.configService.get<string>('ERP_MACRO_API_BASE_URL');
    const apiKey = this.configService.get<string>('ERP_MACRO_API_KEY');

    if (!baseUrl || !apiKey) {
      throw new DepositSourcePermanentError(
        'ERP_MACRO_API_BASE_URL / ERP_MACRO_API_KEY 가 설정되지 않았습니다. 동기화를 켜기 전에 채워야 합니다.',
      );
    }

    return {
      // 뒤 슬래시 유무로 경로가 //deposits 가 되는 실수를 막는다.
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      timeoutMs: this.positiveNumber(this.configService.get('ERP_MACRO_API_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS),
    };
  }

  /**
   * env 가 비었거나 숫자가 아니면 기본값으로 돌린다.
   * NaN 을 그대로 넘기면 axios 의 `if (config.timeout)` 이 거짓이 되어 **타임아웃이 아예 사라진다.**
   * 5분 배치가 무한 대기에 걸리는 경로라 조용한 설정 오류를 허용하면 안 된다.
   */
  private positiveNumber(raw: unknown, fallback: number): number {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * 거래내역 한 페이지 조회.
   *
   * @param from 거래일자 시작 (yyyy-MM-dd, 포함)
   * @param to   거래일자 종료 (yyyy-MM-dd, 포함)
   * @param page ⚠️ **0-based**. 상대가 Spring Pageable 이라 첫 페이지가 0 이다.
   *             1 부터 보내면 첫 페이지를 통째로 건너뛴다(조용한 누락).
   */
  async fetchPage(from: string, to: string, page: number, size: number): Promise<DepositSourcePage> {
    const { baseUrl, apiKey, timeoutMs } = this.resolveConfig();

    try {
      const response = await firstValueFrom(
        this.httpService.get<DepositSourcePage>(`${baseUrl}/api/deposits`, {
          params: this.buildListParams(from, to, page, size),
          headers: { 'X-API-KEY': apiKey },
          timeout: timeoutMs,
        }),
      );
      return this.validatePage(response.data);
    } catch (error) {
      throw this.translate(error, `deposits from=${from} to=${to} page=${page}`);
    }
  }

  /**
   * 목록 조회 쿼리스트링.
   *
   * ⚠️ 평범한 객체 대신 URLSearchParams 를 쓰는 이유가 이 메서드의 존재 이유다.
   * axios 기본 직렬화는 배열 값을 `sort[]=a&sort[]=b` 로 만드는데, Spring 의
   * SortHandlerMethodArgumentResolver 는 정확히 `sort` 라는 이름만 읽는다. 즉 `sort[]` 는
   * **조용히 무시되고** 상대의 기본 정렬(DESC)이 그대로 적용된다. 에러도 경고도 없다.
   * URLSearchParams 는 같은 키를 반복해 `sort=a&sort=b` 로 내보낸다.
   *
   * 왜 오름차순이어야 하나: 페이지를 넘겨가며 읽는 도중 새 거래가 들어오면, 내림차순에서는
   * 새 행이 맨 앞에 끼어들어 뒤 페이지가 밀리고 아직 안 읽은 행이 이미 지나간 페이지로
   * 이동해 영구 누락된다. 오름차순이면 새 행은 항상 끝에 붙으므로 순회가 안전하다.
   * (Spring 은 요청의 sort 가 @PageableDefault 를 덮는다)
   */
  private buildListParams(from: string, to: string, page: number, size: number): URLSearchParams {
    const params = new URLSearchParams();
    params.set('from', from);
    params.set('to', to);
    params.set('page', String(page));
    params.set('size', String(size));
    params.append('sort', 'txDate,asc');
    params.append('sort', 'id,asc');
    return params;
  }

  /**
   * 수집 상태 조회 (스크래퍼가 멈춰 있는지).
   *
   * ⚠️ 이 호출은 배치가 아니라 **화면 요청 경로에서** 일어난다. 동기화용 타임아웃(30초)을
   * 그대로 쓰면 상대 서버가 죽는 대신 *느려질* 때 화면이 그만큼 붙잡힌다. 미러를 둔 이유가
   * "상대가 꺼져 있어도 화면은 뜬다"였는데 그 전제를 스스로 깨게 되므로, 여기만 짧게 끊는다.
   * 못 받으면 호출부가 null 로 처리하고 화면은 그대로 뜬다.
   */
  async fetchStatus(): Promise<DepositSourceStatus> {
    const { baseUrl, apiKey } = this.resolveConfig();
    const timeoutMs = this.positiveNumber(
      this.configService.get('ERP_MACRO_STATUS_TIMEOUT_MS'),
      DEFAULT_STATUS_TIMEOUT_MS,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.get<DepositSourceStatus>(`${baseUrl}/api/status`, {
          headers: { 'X-API-KEY': apiKey },
          timeout: timeoutMs,
        }),
      );
      return this.validateStatus(response.data);
    } catch (error) {
      throw this.translate(error, 'status');
    }
  }

  /**
   * 프록시가 HTML 오류 페이지를 돌려주면 gateTripped 가 undefined 인 채로 응답 DTO(boolean)까지
   * 흘러간다. "차단 안 됨"으로 보이는 값이 사실은 "모름"인 상태가 가장 나쁘므로 여기서 끊는다.
   */
  private validateStatus(data: DepositSourceStatus): DepositSourceStatus {
    if (!data || typeof data.gateTripped !== 'boolean') {
      throw new DepositSourceTransientError('erp_macro 상태 응답 형태가 계약과 다릅니다 (gateTripped 누락).');
    }
    return data;
  }

  /**
   * 응답 형태를 최소한으로 검증한다.
   * 상대가 형태를 바꾸거나 프록시가 HTML 오류 페이지를 돌려줄 때, 그대로 흘려보내면
   * items.map 에서 터지거나 최악의 경우 빈 배열로 읽혀 "입금이 없다"로 보인다.
   */
  private validatePage(data: DepositSourcePage): DepositSourcePage {
    if (!data || !Array.isArray(data.content) || typeof data.totalElements !== 'number') {
      throw new DepositSourceTransientError(
        'erp_macro 응답 형태가 계약과 다릅니다 (content 배열 / totalElements 누락).',
      );
    }
    return data;
  }

  /**
   * 실패를 "다시 시도해도 소용없는 것"과 "다음 주기에 하면 될 것"으로 가른다.
   * 이 구분이 없으면 잘못된 API 키로 5분마다 영원히 재시도하거나,
   * 반대로 일시적 네트워크 오류에 동기화를 영구히 포기하게 된다.
   */
  private translate(error: unknown, context: string): Error {
    if (error instanceof DepositSourcePermanentError || error instanceof DepositSourceTransientError) {
      return error;
    }

    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;

    if (status === 401 || status === 403) {
      return new DepositSourcePermanentError(
        `erp_macro 인증 실패 (${status}) — API 키를 확인해야 합니다. [${context}]`,
      );
    }
    if (status === 400 || status === 404) {
      return new DepositSourcePermanentError(
        `erp_macro 요청이 거부됨 (${status}) — 계약 불일치일 수 있습니다. [${context}]`,
      );
    }

    const reason = status ? `HTTP ${status}` : (axiosError.code ?? axiosError.message);
    return new DepositSourceTransientError(`erp_macro 호출 실패 (${reason}) [${context}]`);
  }
}

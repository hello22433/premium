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
      timeoutMs: Number(this.configService.get('ERP_MACRO_API_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)),
    };
  }

  /**
   * 거래내역 한 페이지 조회.
   * @param from 거래일자 시작 (yyyy-MM-dd, 포함)
   * @param to   거래일자 종료 (yyyy-MM-dd, 포함)
   */
  async fetchPage(from: string, to: string, page: number, size: number): Promise<DepositSourcePage> {
    const { baseUrl, apiKey, timeoutMs } = this.resolveConfig();

    try {
      const response = await firstValueFrom(
        this.httpService.get<DepositSourcePage>(`${baseUrl}/api/deposits`, {
          params: { from, to, page, size },
          headers: { 'X-API-KEY': apiKey },
          timeout: timeoutMs,
        }),
      );
      return this.validatePage(response.data);
    } catch (error) {
      throw this.translate(error, `deposits from=${from} to=${to} page=${page}`);
    }
  }

  /** 수집 상태 조회 (스크래퍼가 멈춰 있는지) */
  async fetchStatus(): Promise<DepositSourceStatus> {
    const { baseUrl, apiKey, timeoutMs } = this.resolveConfig();

    try {
      const response = await firstValueFrom(
        this.httpService.get<DepositSourceStatus>(`${baseUrl}/api/status`, {
          headers: { 'X-API-KEY': apiKey },
          timeout: timeoutMs,
        }),
      );
      return response.data;
    } catch (error) {
      throw this.translate(error, 'status');
    }
  }

  /**
   * 응답 형태를 최소한으로 검증한다.
   * 상대가 형태를 바꾸거나 프록시가 HTML 오류 페이지를 돌려줄 때, 그대로 흘려보내면
   * items.map 에서 터지거나 최악의 경우 빈 배열로 읽혀 "입금이 없다"로 보인다.
   */
  private validatePage(data: DepositSourcePage): DepositSourcePage {
    if (!data || !Array.isArray(data.items) || typeof data.totalCount !== 'number') {
      throw new DepositSourceTransientError('erp_macro 응답 형태가 계약과 다릅니다.');
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

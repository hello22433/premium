import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

type TrackLastEventResponse = {
  data: {
    track: {
      lastEvent: {
        time: string;
        status: {
          code: string;
        };
      };
    };
  };
};

type TrackDetailResponse = {
  data: {
    track: {
      lastEvent: {
        time: string;
        status: {
          code: string;
          name: string;
        };
        description: string;
      };
      events: {
        edges: {
          node: {
            time: string;
            status: {
              code: string;
              name: string;
            };
            description: string;
          };
        }[];
      };
    };
  };
};

@Injectable()
export class DeliveryTrackHttp {
  private readonly trackerClientId: string;
  private readonly trackerClientSecret: string;
  private readonly headers: Record<string, string>;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.trackerClientId = this.configService.getOrThrow('TRACKER_CLIENT_ID');
    this.trackerClientSecret = this.configService.getOrThrow('TRACKER_CLIENT_SECRET');
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `TRACKQL-API-KEY ${this.trackerClientId}:${this.trackerClientSecret}`,
    };
  }

  /**
   * 딜리버리 마지막 상태 조회
   * @param carrierId
   * @param trackingNumber
   */
  async trackDeliveryLastInfo(carrierId: string, trackingNumber: string) {
    const query = `
      query Track($carrierId: ID!, $trackingNumber: String!) {
        track(carrierId: $carrierId, trackingNumber: $trackingNumber) {
          lastEvent {
            time
            status {
              code
            }
          }
        }
      }
    `;

    const response$ = this.httpService.post<TrackLastEventResponse>(
      'https://apis.tracker.delivery/graphql',
      { query, variables: { carrierId, trackingNumber } },
      { headers: this.headers },
    );

    const response = await firstValueFrom(response$);
    return response.data;
  }

  /**
   * 배송 내역 상세 조회 API
   * @param carrierId 택배사 id
   * @param trackingNumber 송장번호 number
   */
  async trackDeliveryDetail(carrierId: string, trackingNumber: string) {
    const query = `
    query Track($carrierId: ID!, $trackingNumber: String!) {
      track(carrierId: $carrierId, trackingNumber: $trackingNumber) {
        lastEvent {
          time
          status {
            code
            name
          }
          description
        }
        events(last: 10) {
          edges {
            node {
              time
              status {
                code
                name
              }
              description
            }
          }
        }
      }
    }
  `;

    const response$ = this.httpService.post<TrackDetailResponse>(
      'https://apis.tracker.delivery/graphql',
      { query, variables: { carrierId, trackingNumber } },
      { headers: this.headers },
    );

    const response = await firstValueFrom(response$);
    return response.data;
  }
}

import { S3Client } from '@aws-sdk/client-s3';
import { FileStorageS3 } from './file.storage.s3';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

/**
 * S3 클라이언트에 거는 상한.
 *
 * ★ 이 스펙은 '연결 수립' 상한만 본다. 이건 옵션을 주는 것으로 실제 동작한다.
 *   본문 stall 방어는 클라이언트 옵션으로 못 하므로(아래 이유) 여기서 검증하지 않는다 —
 *   downloadFileToLocalWithPath 의 행동 테스트(file.storage.s3.download.spec.ts)가 본다.
 *
 * ⚠️ 한때 socketTimeout: 30_000 을 넣고 이 파일에서 "전달됐는지" 만 단언했다. 뮤테이션도 통과했다.
 *    그런데 SDK 는 그 타이머 등록을 3초 미뤘다가 응답 헤더가 오면 clearTimeouts() 로 예약을 지운다.
 *    S3 가 정상이면 헤더가 1초 안에 오므로 타임아웃이 아예 안 걸렸다.
 *    "설정이 전달된다" 와 "그 시나리오가 실제로 끊긴다" 는 다른 명제다.
 */
describe('FileStorageS3 — S3 클라이언트 상한', () => {
  const s3ClientMock = S3Client as unknown as jest.Mock;

  const build = () => {
    s3ClientMock.mockClear();
    new FileStorageS3({ getOrThrow: jest.fn((key: string) => `v-${key}`) } as any);
    return s3ClientMock.mock.calls[0][0] as Record<string, any>;
  };

  it('연결 수립 상한이 저장소 관례(30초)로 걸려 있다', () => {
    expect(build().requestHandler).toEqual({ connectionTimeout: 30_000 });
  });

  it('★총 시간 상한(requestTimeout)은 걸지 않는다 — 대용량 전송·엑셀 파싱이 끊긴다', () => {
    expect(build().requestHandler.requestTimeout).toBeUndefined();
  });

  it('★socketTimeout 도 걸지 않는다 — 본문 stall 을 못 막으면서 막는 것처럼 보인다', () => {
    expect(build().requestHandler.socketTimeout).toBeUndefined();
  });
});

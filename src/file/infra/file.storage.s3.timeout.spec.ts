import { S3Client } from '@aws-sdk/client-s3';
import { FileStorageS3 } from './file.storage.s3';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

/**
 * S3 클라이언트의 stall(상대가 데이터도 오류도 안 주고 멈추는 것) 상한을 고정한다.
 *
 * pipeline 은 스트림이 '끝나는' 경로만 덮는다. stall 은 끝나는 경로가 아니라서 안 덮이고,
 * 클라이언트에 상한이 없으면 응답 Promise 가 영영 settle 되지 않는다(부분 임시파일·소켓 잔존).
 * 이 상한이 유일한 방어라 조용히 지워지면 안 된다.
 *
 * ⚠️ requestTimeout(총 시간)이 아니라 socketTimeout(무응답 시간)이어야 한다.
 *    총 시간을 걸면 20MB 업로드/다운로드와 엑셀 파싱(getBuffer)이 그대로 끊긴다.
 *    게다가 requestTimeout 은 throwOnRequestTimeout 없이는 경고만 하고 끊지도 않는다.
 */
describe('FileStorageS3 — S3 클라이언트 타임아웃', () => {
  const s3ClientMock = S3Client as unknown as jest.Mock;

  const build = () => {
    s3ClientMock.mockClear();
    new FileStorageS3({ getOrThrow: jest.fn((key: string) => `v-${key}`) } as any);
    return s3ClientMock.mock.calls[0][0] as Record<string, any>;
  };

  it('★무응답 상한(socketTimeout)과 연결 상한이 걸려 있다', () => {
    expect(build().requestHandler).toEqual({ connectionTimeout: 30_000, socketTimeout: 30_000 });
  });

  it('★총 시간 상한(requestTimeout)은 걸지 않는다 (대용량 전송이 끊긴다)', () => {
    expect(build().requestHandler.requestTimeout).toBeUndefined();
  });

  it('저장소 관례와 같은 30초 (HttpModule.register({ timeout: 30000 }) · 같은 파일 axios)', () => {
    expect(Object.values(build().requestHandler)).toEqual([30_000, 30_000]);
  });
});

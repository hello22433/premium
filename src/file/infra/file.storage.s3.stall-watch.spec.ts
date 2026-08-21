import { FileStorageS3 } from './file.storage.s3';

/**
 * stall 타이머의 리셋 의미를 결정적으로 고정한다 (fake timers, I/O 없음).
 *
 * ★ 왜 따로 두나 — 다운로드 경로 통합 테스트로 이걸 재려 했더니 뮤테이션을 못 잡았다.
 *   Body.destroy 뒤 pipeline 정리가 실제 fs I/O 를 거쳐, 시간을 밀어도 rejection 이 그 시점에
 *   관측되지 않는다. 타이머의 계약 자체는 여기서 보고, "실제로 끊기는가" 는 download.spec 이 본다.
 *
 * ★ 리뷰 요구("매 chunk마다 단발 timer를 clear/reset")가 지켜지는지를 이 스펙이 지킨다.
 */
describe('FileStorageS3 stall watch — 청크마다 다시 거는 단발 타이머', () => {
  const STALL_MS = 1_000;
  const make = (onStall: jest.Mock) =>
    (FileStorageS3.prototype as any).createStallWatch.call({}, STALL_MS, onStall) as {
      arm: () => void;
      stop: () => void;
    };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('만들면 바로 걸린다 — 진행이 없으면 상한에서 발화', () => {
    const onStall = jest.fn();
    make(onStall);
    jest.advanceTimersByTime(STALL_MS - 1);
    expect(onStall).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('★arm 하면 처음부터 다시 센다 — 상한 직전에 arm 을 반복하면 영원히 발화 안 함', () => {
    const onStall = jest.fn();
    const watch = make(onStall);
    for (let i = 0; i < 5; i += 1) {
      jest.advanceTimersByTime(STALL_MS - 1);
      watch.arm();
    }
    expect(onStall).not.toHaveBeenCalled(); // 총 5초 가까이 흘렀지만 진행이 있었다
    jest.advanceTimersByTime(STALL_MS);
    expect(onStall).toHaveBeenCalledTimes(1); // 마지막 arm 으로부터 상한
  });

  it('stop 하면 더 이상 발화하지 않는다', () => {
    const onStall = jest.fn();
    const watch = make(onStall);
    watch.stop();
    jest.advanceTimersByTime(STALL_MS * 10);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('발화는 1회뿐이다 (arm 없이 계속 흘려도)', () => {
    const onStall = jest.fn();
    make(onStall);
    jest.advanceTimersByTime(STALL_MS * 5);
    expect(onStall).toHaveBeenCalledTimes(1);
  });
});

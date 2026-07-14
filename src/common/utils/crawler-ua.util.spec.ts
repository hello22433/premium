import { isCrawlerUserAgent } from './crawler-ua.util';

describe('isCrawlerUserAgent', () => {
  it('빈/누락 UA 는 봇으로 플래그한다 (정상 브라우저 아님)', () => {
    expect(isCrawlerUserAgent(null)).toBe(true);
    expect(isCrawlerUserAgent(undefined)).toBe(true);
    expect(isCrawlerUserAgent('')).toBe(true);
  });

  it.each([
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; kakaotalk-scrap/1.0; +https://devtalk.kakao.com)',
    'Twitterbot/1.0',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)',
    'TelegramBot (like TwitterBot)',
  ])('알려진 크롤러 UA 는 봇으로 판정한다: %s', (ua) => {
    expect(isCrawlerUserAgent(ua)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ])('일반 모바일/데스크톱 브라우저 UA 는 실사용자로 판정한다: %s', (ua) => {
    expect(isCrawlerUserAgent(ua)).toBe(false);
  });

  // 회귀: 과광범위 패턴(/naver/, /daum/, /bot\b/) 축소 후, 정상 인앱/브랜드 UA 오탐 방지 검증.
  it.each([
    // 네이버 앱 인앱 브라우저(검색 크롤러 'Yeti' 아님)
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 1234; 12.3.4)',
    // 다음 앱(검색 크롤러 'daumoa' 아님)
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 DaumApps/5.6.7',
    // CUBOT 실제 스마트폰 브랜드('bot' 부분문자열 오탐 방지)
    'Mozilla/5.0 (Linux; Android 12; CUBOT NOTE 20 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
  ])('정상 인앱/브랜드 UA 는 봇으로 오판하지 않는다: %s', (ua) => {
    expect(isCrawlerUserAgent(ua)).toBe(false);
  });
});

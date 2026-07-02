/**
 * 알려진 링크 미리보기/크롤러 봇의 User-Agent 판별.
 *
 * coupon-view 페이지의 데이터 API(GET /order/receive/alim-talk)는 브라우저 JS에서 호출되므로
 * 대부분의 단순 크롤러는 애초에 도달하지 않는다. 다만 헤드리스 브라우저로 JS를 실행하는
 * 스크래퍼(카카오 인앱 미리보기 등)가 있을 수 있어, UA로 봇 여부를 플래그해 두면
 * CS 담당자가 '실제 고객 방문'만 걸러 볼 수 있다.
 *
 * 판별은 보수적으로(오탐 최소화) 잘 알려진 봇 토큰만 매칭한다. 매칭되지 않으면 실사용자로 간주한다.
 */
const CRAWLER_UA_PATTERNS: RegExp[] = [
  /kakaotalk-scrap/i,
  /kakaostory-og-reader/i,
  /facebookexternalhit/i,
  /facebot/i,
  /twitterbot/i,
  /slackbot/i,
  /slack-imgproxy/i,
  /telegrambot/i,
  /discordbot/i,
  /line-poker/i,
  /WhatsApp\//i,
  /skypeuripreview/i,
  /googlebot/i,
  /bingbot/i,
  /yeti/i, // Naver 검색 크롤러
  /daumoa/i, // Daum 검색 크롤러
  /applebot/i,
  /petalbot/i,
  // 독립 단어 'bot' 만 매칭(예: "SomeBot/1.0"). 양쪽 단어경계로 "Cubot"(실제 폰 브랜드) 등 오탐 방지.
  /\bbot\b/i,
  /\bcrawler\b/i,
  /\bspider\b/i,
];

export function isCrawlerUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) {
    // UA 자체가 비어있는 요청은 정상 브라우저가 아닐 가능성이 높아 봇으로 플래그한다.
    return true;
  }
  return CRAWLER_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}

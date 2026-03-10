/**
 * 대치문자 치환
 * 텍스트 내의 {대치문자1}, {대치문자2}, {대치문자3} 플레이스홀더를 실제 값으로 교체
 */
export function applyReplaceCharacters(
  text: string,
  holder: {
    replaceCharacter1?: string | null;
    replaceCharacter2?: string | null;
    replaceCharacter3?: string | null;
  },
): string {
  let result = text;
  if (holder.replaceCharacter1) {
    result = result.replaceAll('{대치문자1}', holder.replaceCharacter1);
  }
  if (holder.replaceCharacter2) {
    result = result.replaceAll('{대치문자2}', holder.replaceCharacter2);
  }
  if (holder.replaceCharacter3) {
    result = result.replaceAll('{대치문자3}', holder.replaceCharacter3);
  }
  return result;
}

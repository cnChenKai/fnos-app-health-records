/* 把未知异常压缩成一段可附在用户提示后的技术细节，便于用户反馈与开发定位 */
export function describeTechnical(cause: unknown) {
  if (cause instanceof Error) return cause.message ? `${cause.name}: ${cause.message}` : cause.name;
  return String(cause);
}

/* localStorage 在隐私模式/受限 iframe 里读写会抛 SecurityError，统一兜底：功能降级为不持久化，绝不让应用白屏 */
export function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch (cause) {
    console.warn(`[health-records] 读取本地存储失败（${key}）`, cause);
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (cause) {
    console.warn(`[health-records] 写入本地存储失败（${key}）`, cause);
  }
}

export function removeStorage(key: string) {
  try {
    localStorage.removeItem(key);
  } catch (cause) {
    console.warn(`[health-records] 清除本地存储失败（${key}）`, cause);
  }
}

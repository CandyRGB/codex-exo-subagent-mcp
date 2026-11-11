export function normalizeApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error('API 地址无效，请填写完整的 http:// 或 https:// 地址。'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('API 地址只能使用 HTTP/HTTPS，不能包含账号、密钥、查询参数或片段。'), { status: 400 });
  }
  return url.href.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/, '');
}

export function inferenceEndpoint(baseUrl, protocol) {
  return baseUrl + (protocol === 'responses' ? '/responses' : '/chat/completions');
}

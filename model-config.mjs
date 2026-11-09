// One provider definition for managed jobs and optional CLI profile exports.
export function managedConfig(connection, { baseUrl, fingerprint }) {
  const provider = 'subagent_gateway';
  return {
    model_provider: provider,
    [`model_providers.${provider}.name`]: 'Subagent model gateway',
    [`model_providers.${provider}.base_url`]: `${baseUrl}/inference/${connection.id}/v1`,
    [`model_providers.${provider}.wire_api`]: 'responses',
    [`model_providers.${provider}.env_key`]: 'SUBAGENT_GATEWAY_TOKEN',
    [`model_providers.${provider}.requires_openai_auth`]: false,
    [`model_providers.${provider}.supports_websockets`]: false,
    [`model_providers.${provider}.capabilities.remote_compaction`]: 'unsupported',
    [`model_providers.${provider}.http_headers`]: { 'X-Subagent-Route-Hash': fingerprint },
    web_search: 'disabled',
    ...(connection.context_window ? { model_context_window: connection.context_window } : {}),
  };
}

export function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return `{${Object.entries(value).map(([key, item]) => `${tomlValue(key)}=${tomlValue(item)}`).join(',')}}`;
}

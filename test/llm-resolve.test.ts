// #13: the LLM request resolver. `dreaming.llm.*` overrides `extraction.*` per field;
// routing preferences map to the wire's `provider` object (camelCase -> snake_case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { resolveExtraction, resolveDream, providerBody } from '../src/llm/resolve.ts';

function cfg(extraction: Partial<Config['extraction']>, llm: Config['dreaming']['llm']): Config {
  return {
    ...DEFAULT_CONFIG,
    extraction: { ...DEFAULT_CONFIG.extraction, ...extraction },
    dreaming: { ...DEFAULT_CONFIG.dreaming, llm },
  };
}

test('#13 resolve: an unset dreaming.llm is exactly the extraction config', () => {
  const c = cfg({ provider: 'http', endpoint: 'https://e', model: 'extract', apiKeyEnv: 'K', routing: { zdr: true } }, {});
  assert.deepEqual(resolveDream(c), resolveExtraction(c));
});

test('#13 resolve: dreaming.llm overrides fields; the rest inherit extraction', () => {
  const c = cfg(
    { provider: 'http', endpoint: 'https://e', model: 'extract', apiKeyEnv: 'K' },
    { model: 'dream' },
  );
  const d = resolveDream(c);
  assert.equal(d.model, 'dream', 'the model is overridden');
  assert.equal(d.endpoint, 'https://e', 'the endpoint is inherited');
  assert.equal(d.apiKeyEnv, 'K', 'the key is inherited');
  assert.equal(d.provider, 'http');
});

test('#13 resolve: an explicit null key override wins over the extraction key', () => {
  const c = cfg({ provider: 'http', model: 'extract', apiKeyEnv: 'K' }, { model: 'dream', apiKeyEnv: null });
  assert.equal(resolveDream(c).apiKeyEnv, null, 'null means "no key", not "inherit"');
});

test('#13 resolve: routing is shared, not overridable per pass', () => {
  const c = cfg({ provider: 'http', model: 'extract', routing: { zdr: true, dataCollection: 'deny' } }, { model: 'dream' });
  assert.deepEqual(resolveDream(c).routing, { zdr: true, dataCollection: 'deny' });
});

test('#13 providerBody: empty is undefined; camelCase becomes the wire snake_case', () => {
  assert.equal(providerBody({}), undefined, 'nothing set means no provider field is sent');
  assert.deepEqual(providerBody({ zdr: true }), { zdr: true });
  assert.deepEqual(providerBody({ dataCollection: 'deny' }), { data_collection: 'deny' });
  assert.deepEqual(providerBody({ zdr: false, dataCollection: 'allow' }), { zdr: false, data_collection: 'allow' });
});

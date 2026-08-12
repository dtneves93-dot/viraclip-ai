'use strict';

// Retries transient Render <-> Groq network failures and 429/5xx responses.
// Loaded only inside the clip worker so a brief upstream hiccup does not kill a job.
const originalFetch = globalThis.fetch.bind(globalThis);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isGroq(input){
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url;
  return typeof url === 'string' && url.startsWith('https://api.groq.com/');
}

function retryAfterMs(response, attempt){
  const h = response?.headers?.get?.('retry-after');
  if (h) {
    const seconds = Number(h);
    if (Number.isFinite(seconds)) return Math.min(30000, Math.max(1000, seconds * 1000));
  }
  return Math.min(20000, 1500 * Math.pow(2, attempt - 1));
}

globalThis.fetch = async function viraClipGroqRetry(input, init = {}) {
  if (!isGroq(input)) return originalFetch(input, init);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await originalFetch(input, init);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 4) return response;
      lastError = new Error(`Groq temporariamente indisponível (HTTP ${response.status})`);
      console.warn(`ViraClip Groq retry ${attempt}/4 after HTTP ${response.status}`);
      await sleep(retryAfterMs(response, attempt));
    } catch (e) {
      lastError = e;
      if (attempt === 4) break;
      console.warn(`ViraClip Groq retry ${attempt}/4 after network error: ${e?.message || e}`);
      await sleep(Math.min(20000, 1500 * Math.pow(2, attempt - 1)));
    }
  }
  const detail = lastError?.cause?.message || lastError?.message || String(lastError || 'falha de rede');
  throw new Error(`Falha temporária ao conectar com a Groq após 4 tentativas: ${detail}`);
};

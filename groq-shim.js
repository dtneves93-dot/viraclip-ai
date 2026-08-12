'use strict';

// Loaded before server.js via NODE_OPTIONS. It keeps the existing ViraClip backend
// compatible while routing its OpenAI-compatible calls through Groq.
const GROQ_BASE = 'https://api.groq.com/openai/v1/';
const OPENAI_BASE = 'https://api.openai.com/v1/';

if (process.env.GROQ_API_KEY) {
  // server.js reads these variables during module initialization.
  process.env.OPENAI_API_KEY = process.env.GROQ_API_KEY;
  process.env.OPENAI_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-20b';
  process.env.OPENAI_TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo';
}

const originalFetch = globalThis.fetch?.bind(globalThis);
if (!originalFetch) throw new Error('ViraClip requires Node.js with global fetch support.');

globalThis.fetch = async function viraClipGroqFetch(input, init = {}) {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url;
  if (!url || !url.startsWith(OPENAI_BASE)) return originalFetch(input, init);

  // The current ViraClip uses only OpenAI-compatible Responses and transcription
  // endpoints in its main clipping flow. Groq exposes both under this base URL.
  const target = GROQ_BASE + url.slice(OPENAI_BASE.length);
  const next = { ...init };

  // Ensure the Groq model is used for structured Responses API calls.
  if (target.endsWith('/responses') && typeof next.body === 'string') {
    try {
      const body = JSON.parse(next.body);
      body.model = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-20b';
      next.body = JSON.stringify(body);
    } catch {}
  }

  return originalFetch(target, next);
};

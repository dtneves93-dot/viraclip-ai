# ViraClip AI — v7.1

O ViraClip transforma um vídeo longo em vários clipes verticais legendados, prontos para revisar, baixar, agendar e publicar no Instagram.

## Fluxo principal

1. O usuário envia um vídeo próprio/autorizado.
2. FFmpeg extrai e divide o áudio.
3. A Groq transcreve com `whisper-large-v3-turbo` e timestamps.
4. A IA analisa a transcrição e seleciona os melhores trechos.
5. FFmpeg cria os cortes em 1080×1920 (9:16) e queima as legendas.
6. Os clipes entram na biblioteca do cliente.
7. O usuário pode baixar, publicar ou agendar no Instagram.

## IA gratuita com Groq

A v7.1 usa a Groq no fluxo principal, via endpoints compatíveis com a API da OpenAI. O arquivo `groq-shim.js` faz a ponte de compatibilidade sem expor a chave no frontend.

Variáveis principais:

```text
GROQ_API_KEY=
GROQ_TEXT_MODEL=openai/gpt-oss-20b
GROQ_TRANSCRIBE_MODEL=whisper-large-v3-turbo
NODE_OPTIONS=--require=./groq-shim.js
```

No plano gratuito da Groq existem limites de uso. Consulte os limites atuais da sua organização no console da Groq antes de uso intenso.

## O que funciona

- cadastro/login e múltiplos clientes;
- upload de vídeos longos;
- transcrição com timestamps;
- seleção automática de vários cortes;
- score, título, legenda e hashtags;
- renderização vertical 1080×1920;
- legendas embutidas;
- biblioteca de clipes;
- publicação e agendamento de Reels;
- calendário e analytics;
- SQLite, scrypt, cookie HttpOnly e token do Instagram criptografado.

## Requisitos

- Node.js 22.5+
- FFmpeg e FFprobe
- `GROQ_API_KEY`

## Deploy no Render

O projeto inclui `Dockerfile` e `render.yaml`. O Blueprint cria o serviço `viraclip-ai-v7` no plano gratuito e solicita `GROQ_API_KEY` como segredo.

O plano gratuito do Render é indicado apenas para validação. Arquivos locais e SQLite não devem ser tratados como armazenamento permanente em produção.

## YouTube por link

A interface possui campo de URL, mas a importação fica desativada por padrão (`ENABLE_YOUTUBE_IMPORT=false`). O caminho principal é upload de conteúdo próprio ou autorizado.

## Próximas evoluções

- auto-reframe para acompanhar rosto/pessoa;
- editor visual de legendas;
- ajuste manual de início/fim;
- fila de processamento;
- armazenamento S3/R2 e banco Postgres;
- TikTok e YouTube Shorts;
- planos e créditos por minuto processado.

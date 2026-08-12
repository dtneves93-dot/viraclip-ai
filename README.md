# ViraClip AI — v7

A v7 muda o foco do produto: **um vídeo longo entra; vários clipes verticais legendados saem**.

## Fluxo principal

1. O usuário envia um vídeo (MP4, MOV, WebM, MKV ou AVI).
2. O servidor salva o arquivo fonte.
3. FFmpeg extrai o áudio e divide em blocos para transcrição.
4. A OpenAI transcreve o áudio com timestamps.
5. A IA analisa a transcrição e escolhe os trechos com melhor potencial de retenção.
6. Cada trecho vira um projeto independente.
7. FFmpeg corta o original, adapta para **1080×1920 (9:16)** e queima as legendas.
8. Os MP4 ficam na biblioteca do cliente.
9. O usuário pode baixar, publicar agora ou agendar no Instagram.
10. Analytics alimentam a estratégia para os próximos cortes.

## O que funciona nesta versão

- cadastro/login e múltiplos perfis/clientes;
- upload de vídeos grandes por streaming, sem carregar o arquivo inteiro na memória;
- limite padrão de 3 GB por vídeo;
- leitura de duração e resolução com FFprobe;
- extração e segmentação de áudio com FFmpeg;
- transcrição com timestamps;
- seleção de 3, 5, 8 ou 10 cortes por IA;
- duração mínima/máxima configurável;
- score estimado de 0–100 para cada corte;
- título, motivo do corte, legenda e hashtags;
- crop automático para 9:16;
- legendas SRT queimadas no MP4;
- biblioteca de clipes por cliente;
- publicação e agendamento de Reels usando a integração que já existia na v6;
- calendário e analytics;
- SQLite, scrypt, cookie HttpOnly e tokens do Instagram criptografados com AES-256-GCM.

## YouTube por link

A interface possui o campo de URL e o backend possui o endpoint `/api/import-youtube`, mas a importação fica **desativada por padrão** (`ENABLE_YOUTUBE_IMPORT=false`).

Motivo: a API oficial do YouTube oferece metadados e gerenciamento de legendas, mas não um endpoint geral para baixar o arquivo original de qualquer vídeo. Além disso, os Termos do YouTube restringem downloads fora dos meios autorizados pelo serviço.

Para um SaaS público, use o **upload direto como caminho principal**. Se futuramente existir um fluxo autorizado/licenciado para importação por link, o endpoint já está preparado para conectar um importador do lado do servidor.

## Requisitos

- Node.js 22.5+
- FFmpeg
- FFprobe
- `OPENAI_API_KEY` para a transcrição e seleção real dos cortes

## Rodar localmente

```bash
cp .env.example .env
npm start
```

Abra:

```text
http://localhost:3000
```

> O Node puro não carrega `.env` automaticamente nesta versão. Em produção, configure as variáveis no provedor. Localmente, exporte as variáveis no shell ou use seu gerenciador de ambiente preferido.

## Variáveis principais

```text
OPENAI_API_KEY=
OPENAI_TEXT_MODEL=gpt-5-mini
OPENAI_TRANSCRIBE_MODEL=whisper-1
APP_SECRET=
FFMPEG_BIN=ffmpeg
FFPROBE_BIN=ffprobe
DATA_DIR=./data
DATABASE_PATH=./data/viraclip-v7.sqlite
MEDIA_DIR=./data/media
UPLOAD_DIR=./data/uploads
```

### Instagram

Configure por cliente na tela **Integrações**:

- Instagram Account ID
- Access Token
- Graph API version
- Public Base URL HTTPS

O MP4 precisa estar acessível por uma URL pública HTTPS para publicação automática.

## Endpoints novos da v7

### Fonte

- `POST /api/source-upload` — recebe o vídeo como corpo binário bruto.
- `POST /api/import-youtube` — ponto de integração opcional para importação autorizada por URL.
- `POST /api/clip-source` — transcreve, seleciona e renderiza vários cortes.

### Mantidos da v6

- autenticação;
- workspaces/clientes;
- projetos;
- agendamentos;
- calendário;
- publicação no Instagram;
- analytics;
- estratégia.

## Deploy no Render

A v7 inclui `Dockerfile` para garantir que o FFmpeg exista no ambiente. O `render.yaml` usa runtime Docker.

Para produção de verdade, use um plano com disco persistente ou migre os vídeos para object storage (S3/R2) e o SQLite para Postgres. Vídeos longos e renderização de múltiplos cortes consomem CPU, disco e tempo de execução; plano gratuito não é adequado para esse pipeline.

## Próximos passos recomendados

1. Auto-reframe com rastreamento de rosto/pessoa para manter quem fala no centro.
2. Editor visual de legendas (cores, fonte, palavras destacadas e emojis).
3. Tela para ajustar manualmente início/fim antes do render final.
4. Processamento em fila com workers.
5. Object storage/CDN.
6. TikTok e YouTube Shorts.
7. Planos de assinatura e créditos por minuto processado.

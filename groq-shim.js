'use strict';

// Loaded before server.js via NODE_OPTIONS. It keeps the existing ViraClip backend
// compatible while routing its OpenAI-compatible calls through Groq.
const fs = require('fs');
const path = require('path');
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

// Render Free can spin down after inactivity and mobile networks can interrupt a
// large POST. Patch the browser client at container startup so uploads first wake
// the service, expose real transfer progress and retry once on a network failure.
try {
  const appPath = path.join(__dirname, 'app.js');
  const marker = '/* ViraClip upload resilience v2 */';
  let app = fs.readFileSync(appPath, 'utf8');
  if (!app.includes(marker)) {
    app += `\n\n${marker}\n
async function __viraWakeServer(){
  let lastError=null;
  for(let i=0;i<3;i++){
    try{
      const r=await fetch('/api/status?wake='+Date.now(),{cache:'no-store'});
      if(r.ok)return true;
      lastError=new Error('Servidor indisponível ('+r.status+')');
    }catch(e){lastError=e}
    await new Promise(r=>setTimeout(r,2500*(i+1)));
  }
  throw lastError||new Error('Não foi possível conectar ao servidor');
}

function __viraUploadOnce(file){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/source-upload',true);
    xhr.timeout=20*60*1000;
    const headers=workspaceHeaders();
    Object.entries(headers).forEach(([k,v])=>xhr.setRequestHeader(k,v));
    xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');
    xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
    xhr.upload.onprogress=e=>{
      if(!e.lengthComputable)return;
      const sent=Math.round((e.loaded/e.total)*100);
      const overall=5+(sent*0.18);
      progress(overall,'Enviando o vídeo…',sent+'% enviado • mantenha esta tela aberta',0);
    };
    xhr.onload=()=>{
      let data=null;
      try{data=JSON.parse(xhr.responseText||'{}')}catch{}
      if(xhr.status>=200&&xhr.status<300)return resolve(data||{});
      reject(new Error(data?.error||('Falha no upload ('+xhr.status+')')));
    };
    xhr.onerror=()=>reject(new Error('A conexão caiu durante o upload.'));
    xhr.ontimeout=()=>reject(new Error('O upload demorou demais. Tente novamente em uma conexão mais estável.'));
    xhr.onabort=()=>reject(new Error('Upload cancelado.'));
    xhr.send(file);
  });
}

uploadSource=async function(file){
  progress(2,'Preparando upload…','Acordando o servidor antes de enviar o vídeo.',0);
  await __viraWakeServer();
  progress(5,'Servidor pronto','Iniciando o envio do vídeo.',0);
  try{
    const d=await __viraUploadOnce(file);
    progress(24,'Upload concluído','Agora vamos transcrever o áudio e entender o vídeo.',1);
    return d;
  }catch(first){
    const msg=String(first?.message||first||'');
    const network=/conexão|network|fetch|timeout|demorou/i.test(msg);
    if(!network)throw first;
    progress(3,'Reconectando…','A conexão caiu. O ViraClip vai tentar o upload mais uma vez automaticamente.',0);
    await new Promise(r=>setTimeout(r,3500));
    await __viraWakeServer();
    const d=await __viraUploadOnce(file);
    progress(24,'Upload concluído','Agora vamos transcrever o áudio e entender o vídeo.',1);
    return d;
  }
};\n`;
    fs.writeFileSync(appPath, app, 'utf8');
  }
} catch (e) {
  console.warn('ViraClip upload client patch was not applied:', e.message);
}

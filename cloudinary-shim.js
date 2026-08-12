'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const API_KEY = process.env.CLOUDINARY_API_KEY || '';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const configured = Boolean(CLOUD_NAME && API_KEY && API_SECRET);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'viraclip-v7.sqlite');
const db = new DatabaseSync(DB_PATH);

function now(){ return new Date().toISOString(); }
function sendJson(res,status,data){ const body=JSON.stringify(data); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'}); res.end(body); }
function parseCookies(req){ return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]})); }
function signedIn(req){ const sid=parseCookies(req).viraclip_session; if(!sid)return false; try{return Boolean(db.prepare('SELECT 1 ok FROM sessions WHERE id=? AND expires_at>?').get(sid,now()));}catch{return false;} }
function sign(params){ const base=Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('&'); return crypto.createHash('sha1').update(base + API_SECRET).digest('hex'); }

async function handle(req,res){
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/cloudinary/status' && req.method==='GET'){
    if(!signedIn(req)){sendJson(res,401,{error:'Faça login novamente'});return true;}
    sendJson(res,200,{configured,cloudName:configured?CLOUD_NAME:'',maxDirectBytes:100*1024*1024}); return true;
  }
  if(pathname==='/api/cloudinary/sign-upload' && req.method==='POST'){
    if(!signedIn(req)){sendJson(res,401,{error:'Faça login novamente'});return true;}
    if(!configured){sendJson(res,503,{error:'Cloudinary ainda não configurado'});return true;}
    const timestamp=Math.floor(Date.now()/1000),folder='viraclip/sources';
    sendJson(res,200,{cloudName:CLOUD_NAME,apiKey:API_KEY,timestamp,folder,signature:sign({folder,timestamp})}); return true;
  }
  return false;
}

const previousCreateServer=http.createServer;
http.createServer=function viraClipCloudinaryServer(listener){
  const wrapped=async(req,res)=>{if(await handle(req,res))return;return listener(req,res)};
  return previousCreateServer.call(this,wrapped);
};

try{
  const appPath=path.join(__dirname,'app.js'),marker='/* ViraClip Cloudinary direct upload v8 */';
  let app=fs.readFileSync(appPath,'utf8');
  if(!app.includes(marker)){
    app+=`\n\n${marker}\n
let __vcCloudinaryStatus=null;
async function __vcGetCloudinary(){if(__vcCloudinaryStatus)return __vcCloudinaryStatus;try{__vcCloudinaryStatus=await api('/api/cloudinary/status');}catch{__vcCloudinaryStatus={configured:false};}return __vcCloudinaryStatus;}
function __vcCloudUpload(file,sign){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','https://api.cloudinary.com/v1_1/'+encodeURIComponent(sign.cloudName)+'/video/upload',true);xhr.timeout=20*60*1000;const form=new FormData();form.append('file',file);form.append('api_key',sign.apiKey);form.append('timestamp',String(sign.timestamp));form.append('folder',sign.folder);form.append('signature',sign.signature);xhr.upload.onprogress=e=>{if(e.lengthComputable){const pct=Math.round((e.loaded/e.total)*100);progress(5+(pct*.19),'Enviando para a nuvem…',pct+'% enviado diretamente para o processador de vídeo.',0);}};xhr.onload=()=>{let d={};try{d=JSON.parse(xhr.responseText||'{}')}catch{};if(xhr.status>=200&&xhr.status<300)resolve(d);else reject(new Error(d?.error?.message||('Cloudinary HTTP '+xhr.status)))};xhr.onerror=()=>reject(new Error('Falha ao enviar o vídeo para a nuvem'));xhr.ontimeout=()=>reject(new Error('O upload para a nuvem demorou demais'));xhr.send(form);})}
const __vcLocalUploadSource=uploadSource;
uploadSource=async function(file){const cloud=await __vcGetCloudinary();if(!cloud.configured)return __vcLocalUploadSource(file);if(file.size>Number(cloud.maxDirectBytes||104857600))throw new Error('No modo gratuito em nuvem, teste primeiro com vídeos de até 100 MB.');progress(3,'Preparando upload na nuvem…','O vídeo será enviado direto para o processador, sem pesar no Render.',0);const sign=await api('/api/cloudinary/sign-upload',{method:'POST',body:'{}'});const d=await __vcCloudUpload(file,sign);progress(25,'Upload concluído','Vídeo armazenado na nuvem. Agora vamos transcrever e escolher os cortes.',1);return {sourceId:'cloudinary:'+d.public_id,sourceTitle:file.name,cloudinaryPublicId:d.public_id,cloudinarySecureUrl:d.secure_url,duration:Number(d.duration||0),bytes:Number(d.bytes||file.size),width:Number(d.width||0),height:Number(d.height||0)};};
processVideo=async function(){const btn=$('#processBtn');setBusy(btn,true,'Processando…','✦ Criar clipes automaticamente');try{let src;if(state.sourceMode==='upload'){const f=$('#videoFile').files?.[0];if(!f)throw new Error('Escolha um vídeo primeiro');src=await uploadSource(f);src.sourceTitle=f.name}else src=await importYoutube();state.source=src;progress(25,'Processamento iniciado','Preparando transcrição e seleção dos cortes.',1);const start=await api('/api/clip-job',{method:'POST',body:JSON.stringify({sourceId:src.sourceId,sourceTitle:src.sourceTitle||'',sourceUrl:src.sourceUrl||'',duration:Number(src.duration||0),cloudinaryPublicId:src.cloudinaryPublicId||'',cloudinarySecureUrl:src.cloudinarySecureUrl||'',count:Number($('#clipCount').value),minDuration:Number($('#minDuration').value),maxDuration:Number($('#maxDuration').value),goal:$('#clipGoal').value})});const d=await __vcWaitJob(start.jobId);progress(100,'Clipes prontos!','Selecione um corte para baixar, publicar ou agendar.',4);renderClipResults(d.items||[]);await loadProjects();toast((d.items?.length||0)+' clipes criados ✓');}catch(e){toast(e.message);progress(0,'Não foi possível processar',e.message,0)}finally{setBusy(btn,false,'Processando…','✦ Criar clipes automaticamente')}};
const __vcCloudBtn=$('#processBtn');if(__vcCloudBtn){__vcCloudBtn.onclick=processVideo;__vcCloudBtn.dataset.pipeline='cloud-v8';}
window.__VIRACLIP_PIPELINE='cloud-v8';\n`;
    fs.writeFileSync(appPath,app,'utf8');
  }
}catch(e){console.warn('Cloudinary client patch:',e.message)}

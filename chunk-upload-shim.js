'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'viraclip-v7.sqlite');
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
const CHUNK_SIZE = Math.max(512 * 1024, Math.min(4 * 1024 * 1024, Number(process.env.UPLOAD_CHUNK_BYTES || 2 * 1024 * 1024)));
const MAX_CHUNK = 6 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);

function now(){ return new Date().toISOString(); }
function sendJson(res,status,data){ const body=JSON.stringify(data); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'}); res.end(body); }
function parseCookies(req){ return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{ const i=x.indexOf('='); return i<0?[x,'']:[decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]; })); }
function auth(req){
  const sid=parseCookies(req).viraclip_session;
  const workspaceId=String(req.headers['x-workspace-id']||'');
  if(!sid||!workspaceId) return null;
  try{
    const row=db.prepare(`SELECT s.user_id FROM sessions s JOIN memberships m ON m.user_id=s.user_id WHERE s.id=? AND s.expires_at>? AND m.workspace_id=?`).get(sid,now(),workspaceId);
    return row?{userId:row.user_id,workspaceId}:null;
  }catch{return null;}
}
function safeName(v){ return path.basename(String(v||'video.mp4')).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180)||'video.mp4'; }
function extFor(name,type=''){ const ext=path.extname(name).toLowerCase(); if(['.mp4','.mov','.m4v','.webm','.mkv','.avi'].includes(ext)) return ext; if(type.includes('webm'))return '.webm'; if(type.includes('quicktime'))return '.mov'; return '.mp4'; }
function metaPath(id){ return path.join(UPLOAD_DIR,`.chunk-${id}.json`); }
function partPath(id,ext){ return path.join(UPLOAD_DIR,`${id}${ext}.part`); }
function finalPath(id,ext){ return path.join(UPLOAD_DIR,`${id}${ext}`); }
function loadMeta(id){ try{return JSON.parse(fs.readFileSync(metaPath(id),'utf8'));}catch{return null;} }
function saveMeta(m){ fs.writeFileSync(metaPath(m.sourceId),JSON.stringify(m),'utf8'); }
function readJson(req,limit=64*1024){ return new Promise((resolve,reject)=>{ let s=''; req.on('data',c=>{s+=c;if(Buffer.byteLength(s)>limit)reject(new Error('Payload grande demais'));}); req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error('JSON inválido'))}}); req.on('error',reject); }); }
function probe(file){ const r=spawnSync(FFPROBE_BIN,['-v','error','-print_format','json','-show_format','-show_streams',file],{encoding:'utf8',maxBuffer:8*1024*1024}); if(r.status!==0) throw new Error((r.stderr||'Vídeo inválido').trim()); const j=JSON.parse(r.stdout||'{}'),v=(j.streams||[]).find(x=>x.codec_type==='video')||{}; return {duration:Number(j.format?.duration||v.duration||0),width:Number(v.width||0),height:Number(v.height||0)}; }

async function handleChunkRoutes(req,res){
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!pathname.startsWith('/api/chunk-upload/')) return false;
  const who=auth(req); if(!who){ sendJson(res,401,{error:'Faça login novamente'}); return true; }
  try{
    if(req.method==='POST'&&pathname==='/api/chunk-upload/init'){
      const b=await readJson(req),fileName=safeName(b.fileName),fileSize=Math.max(0,Number(b.fileSize||0)),fileType=String(b.fileType||''),totalChunks=Math.max(1,Math.ceil(fileSize/CHUNK_SIZE));
      const sourceId=`source_${crypto.randomBytes(10).toString('hex')}`,ext=extFor(fileName,fileType),m={sourceId,workspaceId:who.workspaceId,fileName,fileType,fileSize,totalChunks,nextIndex:0,bytes:0,ext,createdAt:now()};
      fs.writeFileSync(partPath(sourceId,ext),''); saveMeta(m); sendJson(res,200,{sourceId,chunkSize:CHUNK_SIZE,totalChunks}); return true;
    }
    if(req.method==='POST'&&pathname==='/api/chunk-upload/chunk'){
      const sourceId=String(req.headers['x-upload-id']||''),index=Number(req.headers['x-chunk-index']),m=loadMeta(sourceId);
      if(!m||m.workspaceId!==who.workspaceId){sendJson(res,404,{error:'Sessão de upload não encontrada'});return true;}
      if(!Number.isInteger(index)||index<0||index>=m.totalChunks){sendJson(res,400,{error:'Índice de bloco inválido'});return true;}
      if(index<m.nextIndex){sendJson(res,200,{ok:true,index,nextIndex:m.nextIndex,bytes:m.bytes,duplicate:true});return true;}
      if(index!==m.nextIndex){sendJson(res,409,{error:`Envie primeiro o bloco ${m.nextIndex}`,nextIndex:m.nextIndex});return true;}
      const tmp=path.join(UPLOAD_DIR,`.chunk-${sourceId}-${index}.part`); let bytes=0,failed=false; const out=fs.createWriteStream(tmp);
      await new Promise((resolve,reject)=>{ const fail=e=>{if(failed)return;failed=true;out.destroy();try{fs.rmSync(tmp,{force:true})}catch{}reject(e)}; req.on('data',c=>{bytes+=c.length;if(bytes>MAX_CHUNK){fail(new Error('Bloco grande demais'));req.destroy();}}); req.on('error',fail); out.on('error',fail); out.on('finish',resolve); req.pipe(out); });
      if(bytes<=0)throw new Error('Bloco vazio');
      fs.appendFileSync(partPath(sourceId,m.ext),fs.readFileSync(tmp)); fs.rmSync(tmp,{force:true}); m.nextIndex++; m.bytes+=bytes; saveMeta(m);
      sendJson(res,200,{ok:true,index,nextIndex:m.nextIndex,bytes:m.bytes}); return true;
    }
    if(req.method==='POST'&&pathname==='/api/chunk-upload/finalize'){
      const b=await readJson(req),sourceId=String(b.sourceId||''),m=loadMeta(sourceId);
      if(!m||m.workspaceId!==who.workspaceId){sendJson(res,404,{error:'Sessão de upload não encontrada'});return true;}
      if(m.nextIndex!==m.totalChunks){sendJson(res,409,{error:`Upload incompleto: ${m.nextIndex}/${m.totalChunks} blocos`,nextIndex:m.nextIndex});return true;}
      if(m.fileSize&&m.bytes!==m.fileSize){sendJson(res,409,{error:`Tamanho recebido diferente do esperado (${m.bytes}/${m.fileSize})`});return true;}
      const part=partPath(sourceId,m.ext),final=finalPath(sourceId,m.ext); fs.renameSync(part,final); let info; try{info=probe(final);}catch(e){try{fs.rmSync(final,{force:true})}catch{} throw e;} fs.rmSync(metaPath(sourceId),{force:true});
      sendJson(res,200,{sourceId,fileName:m.fileName,bytes:m.bytes,...info}); return true;
    }
    sendJson(res,404,{error:'Rota de upload não encontrada'}); return true;
  }catch(e){ console.error('Chunk upload:',e); if(!res.headersSent)sendJson(res,500,{error:e.message||'Falha no upload'}); else try{res.end()}catch{} return true; }
}

const previousCreateServer=http.createServer;
http.createServer=function patchedChunkServer(listener){
  const wrapped=async(req,res)=>{ if(await handleChunkRoutes(req,res))return; return listener(req,res); };
  return previousCreateServer.call(this,wrapped);
};

// Append a browser-side override after the existing upload patch. Each request is
// only a small block; failed blocks retry without resending the whole video.
try{
  const appPath=path.join(__dirname,'app.js'),marker='/* ViraClip chunk upload v3 */'; let app=fs.readFileSync(appPath,'utf8');
  if(!app.includes(marker)){
    app+=`\n\n${marker}\n
function __vcChunkXhr(blob,sourceId,index){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/chunk-upload/chunk',true);xhr.timeout=120000;Object.entries(workspaceHeaders()).forEach(([k,v])=>xhr.setRequestHeader(k,v));xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-Upload-Id',sourceId);xhr.setRequestHeader('X-Chunk-Index',String(index));xhr.onload=()=>{let d={};try{d=JSON.parse(xhr.responseText||'{}')}catch{};if(xhr.status>=200&&xhr.status<300)resolve(d);else reject(new Error(d?.error||('Falha no bloco '+(index+1)+' ('+xhr.status+')')))};xhr.onerror=()=>reject(new Error('Conexão interrompida no bloco '+(index+1)));xhr.ontimeout=()=>reject(new Error('Tempo esgotado no bloco '+(index+1)));xhr.send(blob);})}
async function __vcSendChunk(blob,sourceId,index){let last;for(let attempt=1;attempt<=4;attempt++){try{return await __vcChunkXhr(blob,sourceId,index)}catch(e){last=e;if(attempt<4){progress(5,'Reconectando upload…','O bloco '+(index+1)+' falhou. Tentativa '+(attempt+1)+' de 4.',0);await new Promise(r=>setTimeout(r,1200*attempt));}}}throw last}
uploadSource=async function(file){progress(2,'Preparando upload…','Iniciando envio resistente a quedas de conexão.',0);await __viraWakeServer();const init=await api('/api/chunk-upload/init',{method:'POST',body:JSON.stringify({fileName:file.name,fileSize:file.size,fileType:file.type})});const chunkSize=Number(init.chunkSize||2097152),total=Math.ceil(file.size/chunkSize);for(let i=0;i<total;i++){const start=i*chunkSize,end=Math.min(file.size,start+chunkSize),blob=file.slice(start,end);await __vcSendChunk(blob,init.sourceId,i);const sent=Math.round((end/file.size)*100),overall=5+(sent*.18);progress(overall,'Enviando o vídeo…',sent+'% enviado • bloco '+(i+1)+' de '+total+' concluído',0);}const done=await api('/api/chunk-upload/finalize',{method:'POST',body:JSON.stringify({sourceId:init.sourceId})});progress(24,'Upload concluído','Agora vamos transcrever o áudio e entender o vídeo.',1);return done;};\n`;
    fs.writeFileSync(appPath,app,'utf8');
  }
}catch(e){console.warn('ViraClip chunk client patch was not applied:',e.message)}

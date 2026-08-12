'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'viraclip-v7.sqlite');
const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || 'v24.0';
const db = new DatabaseSync(DB_PATH);

function now(){ return new Date().toISOString(); }
function uid(prefix){ return `${prefix}_${crypto.randomBytes(10).toString('hex')}`; }
function parseCookies(req){
  return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{
    const i=x.indexOf('=');
    return i<0?[x,'']:[decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))];
  }));
}

function repairWorkspace(req){
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if(!pathname.startsWith('/api/')) return;
  if(pathname.startsWith('/api/auth/') || pathname==='/api/status') return;

  const sid = parseCookies(req).viraclip_session;
  if(!sid) return;

  let session;
  try{
    session = db.prepare('SELECT user_id FROM sessions WHERE id=? AND expires_at>?').get(sid, now());
  }catch{return;}
  if(!session?.user_id) return;

  const requested = String(req.headers['x-workspace-id'] || '');
  if(requested){
    const valid = db.prepare('SELECT 1 ok FROM memberships WHERE user_id=? AND workspace_id=?').get(session.user_id, requested);
    if(valid) return;
  }

  let ws = db.prepare(`SELECT w.id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at LIMIT 1`).get(session.user_id);

  // A valid logged-in user should always have a workspace, but during iterative
  // free-tier deploy tests an old client can briefly point at a removed workspace.
  // Create a safe default only when no membership exists at all.
  if(!ws){
    const id=uid('ws'), created=now();
    try{
      db.exec('BEGIN');
      db.prepare('INSERT INTO workspaces(id,name,owner_user_id,graph_version,created_at) VALUES(?,?,?,?,?)').run(id,'Meu perfil',session.user_id,META_GRAPH_API_VERSION,created);
      db.prepare('INSERT INTO memberships(user_id,workspace_id,role) VALUES(?,?,?)').run(session.user_id,id,'owner');
      db.exec('COMMIT');
      ws={id};
    }catch(e){
      try{db.exec('ROLLBACK')}catch{}
      console.warn('Workspace repair failed:', e.message);
      return;
    }
  }

  req.headers['x-workspace-id'] = ws.id;
  console.warn(`ViraClip repaired workspace header for ${pathname}: ${requested || '(empty)'} -> ${ws.id}`);
}

const previousCreateServer = http.createServer;
http.createServer = function workspaceRepairCreateServer(listener){
  const wrapped = (req,res) => {
    try{ repairWorkspace(req); }catch(e){ console.warn('Workspace repair:', e.message); }
    return listener(req,res);
  };
  return previousCreateServer.call(this, wrapped);
};

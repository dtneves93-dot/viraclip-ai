'use strict';
const fs=require('fs');
const path=require('path');
try{
  const p=path.join(__dirname,'index.html');
  let s=fs.readFileSync(p,'utf8');
  s=s.replace(/<script src="app\.js(?:\?[^\"]*)?"><\/script>/,'<script src="app.js?v=async-v6"></script>');
  s=s.replace('<option value="3">3 clipes</option><option value="5" selected>5 clipes</option>','<option value="3" selected>3 clipes</option><option value="5">5 clipes</option>');
  fs.writeFileSync(p,s,'utf8');
}catch(e){console.warn('Client version shim:',e.message)}
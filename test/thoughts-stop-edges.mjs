import { requireSandbox } from './guard/sandbox.mjs';
await requireSandbox(import.meta.url);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createThoughts } from '../lib/thoughts.mjs';
const t = fs.mkdtempSync(path.join(os.tmpdir(), 'j648-edges-'));
const fake = path.join(t, 'pi');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'); let busy=false, queue=[], buf='';
const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const log=x=>fs.appendFileSync(process.env.LOG,JSON.stringify(x)+'\\n');
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const c=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
if(c.type==='prompt'){if(c.message.startsWith('/jot-'))continue;if(busy)queue.push(c.message);else {busy=true;log({turn:c.message});out({type:'agent_start'});}}
if(c.type==='clear_queue'){const q=queue.splice(0);log({cleared:q});const answer=()=>out({id:c.id,type:'response',success:true,data:{steering:q.filter(x=>x.includes('STEER')),followUp:q.filter(x=>!x.includes('STEER'))}});if(process.env.MODE==='late')setTimeout(answer,500);else if(process.env.MODE!=='timeout')answer();}
if(c.type==='abort'){busy=false;setTimeout(()=>out({type:'agent_settled'}),100);}
}});process.stdin.on('end',()=>process.exit(0));
`,{mode:0o755});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const active=[];
function make(mode){const state=path.join(t,mode),log=path.join(t,mode+'.log');const api=createThoughts({stateDir:state,cfg:()=>({pi:fake}),env:{LOG:log,MODE:mode}});active.push(api);const logs=()=>{try{return fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)}catch{return []}};return {api,logs};}
try {
  const {api,logs}=make('normal');api.send('H','start');await sleep(200);api.reply('H','old','FOLLOW');api.reply('H','steer','STEER');api.send('H','drop-own');await sleep(100);api.interrupt('H',{ask:true});await sleep(350);
  const turns=logs().filter(x=>x.turn).map(x=>x.turn);assert(turns[1].startsWith('[Angus pressed stop'));assert(!logs().some(x=>x.turn?.includes('drop-own')));console.log('confirmed: phone stop note starts first, before kept replies; wrapped own prompt dropped');api.interrupt('H');await sleep(350);assert(logs().some(x=>x.turn?.includes('STEER')));
  // fake deliberately holds the replay turn; the remaining preserved follow-up must be queued there, not lost.
  api.interrupt('H');await sleep(350);assert(logs().some(x=>x.turn?.includes('FOLLOW')));console.log('confirmed: both steering and followUp preserved, without duplicate STEER after second stop');assert.equal(logs().filter(x=>x.turn?.includes('STEER')).length,1);
  const c=make('freshreply');c.api.send('H','start');await sleep(200);c.api.interrupt('H',{ask:true});c.api.reply('H','fresh','FRESH');await sleep(400);assert(c.logs().some(x=>x.turn?.startsWith('[Angus pressed stop')));console.log('fixed: NEW agent reply during stop no longer suppresses phone stop note');
  const a=make('late');a.api.send('H','start');await sleep(200);a.api.reply('H','late','LATE');await sleep(100);a.api.interrupt('H');await sleep(900);assert(a.logs().some(x=>x.turn?.includes('LATE')));assert.equal(a.logs().filter(x=>x.turn?.includes('LATE')).length,1);console.log('fixed: response after agent_settled replays preserved reply exactly once');
  const b=make('timeout');b.api.send('H','start');await sleep(200);b.api.reply('H','lost','LOST');await sleep(100);b.api.interrupt('H');await sleep(10500);assert(!b.logs().some(x=>x.turn?.includes('LOST')));assert(b.api.get('H').entries.some(e=>e.role==='note'&&e.text.startsWith('⚠')));console.log('fixed: missing clear_queue response produces visible warning after 10s');
} finally { for(const api of active)api.stopAll();await sleep(300);fs.rmSync(t,{recursive:true,force:true}); }

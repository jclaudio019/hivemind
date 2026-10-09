import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo=resolve(import.meta.dirname,'../..');
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'local-runtime-')); roots.push(root);
 const env={...process.env,HOME:root,USERPROFILE:root,HIVEMIND_BACKEND:'local',HIVEMIND_LOCAL_ROOT:join(root,'store'),HIVEMIND_USER_NAME:'tester',HIVEMIND_EMBEDDINGS:'false',HIVEMIND_GRAPH_ON_STOP:'0',HIVEMIND_AUTOPULL_DISABLED:'1'};
 const guard=join(root,'no-cloud.mjs');
 writeFileSync(guard,`import {appendFileSync} from 'node:fs'; globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(join(root,'cloud-attempts'))},'attempt\\n'); throw new Error('Cloud forbidden in local test');};`);
 return {root,env:{...env,NODE_OPTIONS:`--import=${guard}`}};
}
function hook(path:string,root:string,env:NodeJS.ProcessEnv,extra={}) {
 return spawnSync(process.execPath,[join(repo,path)],{cwd:root,env,input:JSON.stringify({session_id:'fresh-local',cwd:root,hook_event_name:'UserPromptSubmit',model:'test',prompt:'local capture',...extra}),encoding:'utf8',timeout:30000});
}

it('captures a fresh Codex session without credentials or preexisting tables',()=>{
 const {root,env}=fixture();
 const result=hook('harnesses/codex/bundle/capture.js',root,env);
 expect(result.status,result.stderr).toBe(0);
 const db=new DatabaseSync(join(root,'store','hivemind.db'));
 try {expect(Number(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n)).toBe(1);} finally {db.close();}
 expect(existsSync(join(root,'cloud-attempts'))).toBe(false);
});

it.each(['codex','hermes'].flatMap(agent=>[false,true].map(cloudCreds=>({agent,cloudCreds}))))('provisions $agent locally with cloud credentials=$cloudCreds',({agent,cloudCreds})=>{
 const {root,env}=fixture();
 if(cloudCreds) {
  mkdirSync(join(root,'.deeplake'));
  writeFileSync(join(root,'.deeplake','credentials.json'),JSON.stringify({token:'unusable-cloud-token',orgId:'cloud-org',userName:'cloud-user',apiUrl:'https://example.invalid',savedAt:'2026-01-01'}));
 }
 const path=agent==='codex'?'harnesses/codex/bundle/session-start-setup.js':'harnesses/hermes/bundle/session-start.js';
 const result=hook(path,root,env,{hook_event_name:'SessionStart'});
 expect(result.status,result.stderr).toBe(0);
 const db=new DatabaseSync(join(root,'store','hivemind.db'));
 try {expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','memory')").all()).toHaveLength(2);} finally {db.close();}
 expect(existsSync(join(root,'cloud-attempts'))).toBe(false);
});

it.each(['codex','cursor'].flatMap(agent=>[false,true].map(cloudCreds=>({agent,cloudCreds}))))('keeps $agent main startup offline with cloud credentials=$cloudCreds',({agent,cloudCreds})=>{
 const {root,env}=fixture();
 if(cloudCreds) {
  mkdirSync(join(root,'.deeplake'));
  writeFileSync(join(root,'.deeplake','credentials.json'),JSON.stringify({token:'unusable-cloud-token',orgId:'cloud-org',userName:'cloud-user',apiUrl:'https://example.invalid',savedAt:'2026-01-01'}));
 }
 const result=hook(`harnesses/${agent}/bundle/session-start.js`,root,{...env,HIVEMIND_WORKSPACE_ID:'named-local-workspace'},{hook_event_name:'SessionStart',workspace_roots:[root]});
 expect(result.status,result.stderr).toBe(0);
 expect(result.stdout).toContain('local');
 expect(existsSync(join(root,'cloud-attempts'))).toBe(false);
});

it('preserves backslashes through actual MCP summary save and exact readback',async()=>{
 const {root,env}=fixture();
 const client=new Client({name:'local-writer-proof',version:'1'});
 const text=String.raw`C:\Users\name and \d+; SQL-looking text ILIKE ::text and ') UNION ALL ('`;
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(repo,'scripts','local-mcp.mjs')],cwd:root,env:env as Record<string,string>,stderr:'pipe'}));
  const saved=await client.callTool({name:'hivemind_save_summary',arguments:{session_id:'roundtrip-proof',summary:text}});
  expect(saved.isError,JSON.stringify(saved)).not.toBe(true);
  const path=JSON.stringify(saved).match(/\/summaries\/[^\s"\\]+\.md/)?.[0];
  expect(path).toBeTruthy();
  const read=await client.callTool({name:'hivemind_read',arguments:{path}});
  expect((read.content as Array<{text:string}>).map(c=>c.text).join('\n')).toBe(text);
  expect(existsSync(join(root,'cloud-attempts'))).toBe(false);
 } finally {await client.close();}
});

it('runs the Prime executable from the npm package with no dist directory',()=>{
 const {root,env}=fixture();
 const packed=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',root],{cwd:repo,env,encoding:'utf8',timeout:60000});
 expect(packed.status,packed.stderr).toBe(0);
 const archive=join(root,JSON.parse(packed.stdout)[0].filename);
 const extracted=spawnSync('tar',['-xzf',archive,'-C',root],{encoding:'utf8'});
 expect(extracted.status,extracted.stderr).toBe(0);
 expect(existsSync(join(root,'package','dist'))).toBe(false);
 const fake=join(root,'fake-prime.mjs');
 writeFileSync(fake,`console.log(JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'packaged Prime proof'}]}}));`);
 const result=spawnSync(process.execPath,[join(root,'package','scripts','prime-hivemind.mjs'),fake,'--mode=json'],{cwd:root,env:{...env,PRIME_AGENT_BIN:process.execPath},encoding:'utf8',timeout:60000});
 expect(result.status,result.stderr).toBe(0);
 const db=new DatabaseSync(join(root,'store','hivemind.db'));
 try {
  const row=db.prepare('SELECT message FROM sessions').get() as {message:string};
  expect(JSON.parse(row.message)).toMatchObject({type:'user_message',content:'packaged Prime proof',source_agent:'prime'});
 } finally {db.close();}
});

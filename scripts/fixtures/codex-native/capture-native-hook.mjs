// Test-only observer. No tool strings are executed. Never read outside this fresh test profile.
import {readFileSync,writeFileSync,realpathSync,openSync,readSync,closeSync,constants,fstatSync} from 'node:fs';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url));
const input=JSON.parse(readFileSync(0,'utf8'));
const record=Object.fromEntries(['hook_event_name','session_id','agent_id','turn_id','tool_name','tool_use_id'].filter(k=>typeof input[k]==='string').map(k=>[k,input[k]]));
if(typeof input.tool_input?.task_name==='string')record.inputTaskName=input.tool_input.task_name;
if(input.hook_event_name==='PostToolUse'){
 const value=input.tool_response;
 let response=value;
 if(typeof value==='string'){try{response=JSON.parse(value);}catch{response=null;}}
 if(typeof response?.task_name==='string')record.resultTaskName=response.task_name;
 record.responseShape=Array.isArray(value)?'array':typeof value;
 if(value&&typeof value==='object')record.responseKeys=Object.keys(value);
}
if(input.hook_event_name==='SubagentStart'){
 try{
  const base=realpathSync(join(root,'codex/sessions'));
  const path=realpathSync(input.transcript_path);
  const rel=relative(base,path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('outside_fresh_session_tree');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   if(!fstatSync(fd).isFile())throw Error('not_regular_file');
   const buf=Buffer.alloc(256*1024),size=readSync(fd,buf,0,buf.length,0),end=buf.subarray(0,size).indexOf(10);
   if(end<0)throw Error('missing_or_large_header');
   const header=JSON.parse(buf.subarray(0,end).toString('utf8'));
   if(header.type!=='session_meta')throw Error('wrong_header_type');
   record.metadata=Object.fromEntries(['id','session_id','parent_thread_id','agent_path'].filter(k=>Object.hasOwn(header.payload,k)).map(k=>[k,header.payload[k]]));
  }finally{closeSync(fd);}
 }catch(e){record.captureError=e.code??e.message;}
}
writeFileSync(join(root,'events',randomUUID()+'.json'),JSON.stringify(record),{flag:'wx'});

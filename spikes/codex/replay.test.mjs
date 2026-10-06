// Synthetic Codex-shaped inputs. This proves reuse, not runtime compatibility.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handle,BRIEF_FIELDS,REPORT_FIELDS,slotsFor} from '../../plugins/sage/hooks/sage-hook.mjs';

// Deliberately only a prototype boundary. Actor identity must come from live captures.
function translate(x,actor) {
  if (!actor) throw new Error('Actor identity is unverified');
  const result={...x};
  if(actor.kind==='child') Object.assign(result,{agent_id:actor.id,agent_type:`sage:${actor.role}`});
  if(x.tool_name==='apply_patch') result.tool_name='Edit';
  if(x.tool_name==='spawn_agent') {
    result.tool_name='Agent';
    result.tool_input={subagent_type:`sage:${x.tool_input.agent_type}`,prompt:x.tool_input.message};
  }
  return result;
}
const dir=mkdtempSync(join(tmpdir(),'sage-codex-replay-'));
const parent={kind:'chief'};
const child={kind:'child',id:'child-1',role:'implementer'};
const state={sage:true,given:true};
const brief=BRIEF_FIELDS.map(x=>`${x} none`).join('\n');
const report=REPORT_FIELDS.map(x=>`${x} none`).join('\n');
const slots=slotsFor(join(dir,'slots'),'parent');
const event=(hook_event_name,extra={})=>({hook_event_name,session_id:'parent',cwd:dir,...extra});

test('unknown actor is rejected rather than guessed',()=>{
 assert.throws(()=>translate(event('PreToolUse'),null),/unverified/);
});
test('chief patch uses the existing edit policy',()=>{
 const x=event('PreToolUse',{tool_name:'apply_patch',tool_input:{command:'*** Begin Patch\n*** Add File: a.js\n+x\n*** End Patch'}});
 assert.equal(handle(translate(x,parent),state,slots).hookSpecificOutput.permissionDecision,'deny');
});
test('brief, slot and report rules reuse the current handler',()=>{
 const spawn=message=>event('PreToolUse',{tool_name:'spawn_agent',tool_use_id:'call-1',tool_input:{agent_type:'implementer',message}});
 assert.equal(handle(translate(spawn('missing brief'),parent),state,slots).hookSpecificOutput.permissionDecision,'deny');
 handle(translate(spawn(brief),parent),state,slots);
 assert.equal(readdirSync(join(dir,'slots')).length,1);
 handle(translate(event('SubagentStart'),child),state,slots);
 assert.equal(handle(translate(event('SubagentStop',{last_assistant_message:'incomplete'}),child),state,slots).decision,'block');
 assert.equal(readdirSync(join(dir,'slots')).length,1);
 handle(translate(event('SubagentStop',{last_assistant_message:report}),child),state,slots);
 assert.equal(readdirSync(join(dir,'slots')).length,0);
 rmSync(dir,{recursive:true,force:true});
});

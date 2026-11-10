// Minimal server-rendered operations console. It is NOT the product UI (Milestone 5 builds that); it lets the
// founder finish setup and run an investigation end to end. Plain JS, no external scripts, no inline secrets.
export function setupPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>P&amp;H R&amp;D Agent: setup</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#ddd;--ok:#0a7d33;--bad:#b3261e;--accent:#1f4fd8}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--mut:#9a9a9a;--line:#333;--ok:#4ade80;--bad:#f87171;--accent:#7aa2ff}}
body{font:15px/1.45 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}main{max-width:760px;margin:0 auto;padding:12px 14px 80px}
h1{font-size:19px;margin:10px 0}h2{font-size:16px;margin:22px 0 6px;border-top:1px solid var(--line);padding-top:12px}
input,textarea,select,button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:7px 9px;max-width:100%}
textarea{width:100%;box-sizing:border-box;min-height:90px}button{cursor:pointer;background:var(--accent);color:#fff;border:0}button.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}
label{display:block;margin:6px 0 2px;color:var(--mut);font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.ok{color:var(--ok)}.bad{color:var(--bad)}.mut{color:var(--mut);font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;background:rgba(127,127,127,.12);padding:8px;border-radius:6px;font-size:13px}.card{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}
#msg{position:fixed;left:0;right:0;bottom:0;padding:10px 14px;background:var(--bg);border-top:1px solid var(--line);font-size:14px}
</style></head><body><main>
<h1>P&amp;H R&amp;D Agent: setup and operations</h1>
<div id="login"><h2>Sign in</h2><div class="row"><div><label>Email</label><input id="em" type="email" autocomplete="username"></div><div><label>Password</label><input id="pw" type="password" autocomplete="current-password"></div><button id="go">Sign in</button></div></div>
<div id="app" hidden>
<div class="mut" id="who"></div>
<h2>1. Keys and readiness</h2><div id="status"></div>
<h2>2. Budgets</h2><div class="row"><div><label>Monthly budget (₹)</label><input id="mb" type="number"></div><div><label>Per investigation (₹)</label><input id="ic" type="number"></div><div><label>Test-run cap (₹, optional)</label><input id="tc" type="number"></div><div><label>₹ per US$</label><input id="fx" type="number" step="0.01"></div><button id="saveBudget">Save</button></div>
<h2>3. Models</h2><div id="models"></div>
<div class="card"><b>Add a model</b><div class="mut">List what your key can use, then pick one.</div><div class="row"><button class="sec" id="listModels">List available models</button></div><div id="avail"></div></div>
<h2>4. Team</h2><div id="team"></div><div class="row"><div><label>Email (already created in Supabase)</label><input id="te" type="email"></div><div><label>Role</label><select id="tr"><option>member</option><option>architect</option><option>founder</option></select></div><button class="sec" id="addTeam">Add access</button></div>
<h2>5. Instruction files</h2><div id="prompts"></div>
<h2>6. Investigations</h2>
<div class="card"><label>Title</label><input id="nt" style="width:100%;box-sizing:border-box"><label>Problem</label><textarea id="np"></textarea><div class="row"><div><label>Cap for this run (₹, optional, can only lower)</label><input id="nc" type="number"></div><div><label><input id="nconf" type="checkbox" checked style="width:auto"> Confidential</label></div><button id="create">Create and plan</button></div></div>
<div id="invs"></div><div id="detail"></div>
</div></main><div id="msg" class="mut">Ready.</div>
<script>
(function(){
var cfg,token=null,$=function(i){return document.getElementById(i)};
function say(t,bad){var m=$('msg');m.textContent=t;m.className=bad?'bad':'mut'}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
async function api(method,path,body){var r=await fetch(path,{method:method,headers:{'content-type':'application/json',authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined});var j=await r.json().catch(function(){return {}});if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
async function login(){say('Signing in...');try{
 if(!cfg)cfg=await (await fetch('/setup/config.json')).json();
 var r=await fetch(cfg.supabaseUrl+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'content-type':'application/json',apikey:cfg.anonKey},body:JSON.stringify({email:$('em').value,password:$('pw').value})});
 var j=await r.json();if(!r.ok||!j.access_token)throw new Error(j.error_description||j.msg||'sign-in failed');token=j.access_token;$('pw').value='';
 var me=await api('GET','/api/me');$('login').hidden=true;$('app').hidden=false;$('who').textContent=me.email+' ('+me.role+')';say('Signed in.');refresh();
 setTimeout(function relogin(){},0)}catch(e){say(e.message,true)}}
$('go').onclick=login;
function yn(b){return b?'<span class="ok">✓ present</span>':'<span class="bad">✗ missing</span>'}
async function refresh(){try{
 var s=await api('GET','/api/setup/status');
 $('status').innerHTML=Object.keys(s.keys).map(function(k){return '<div>'+esc(k)+': '+yn(s.keys[k])+'</div>'}).join('')+'<div>Budgets set: '+yn(s.ready.budgets)+'</div><div>Models routed: '+yn(s.ready.routes)+'</div><div class="mut">Key values are never shown.</div>';
 var st=s.settings;$('mb').value=st.monthly_budget_inr||'';$('ic').value=st.investigation_cap_inr||'';$('tc').value=st.test_run_cap_inr||'';$('fx').value=st.fx_rate_inr_per_usd||'';
 $('models').innerHTML=s.models.map(function(m){var pr=m.prices.map(function(p){return '<div class="mut">price $'+p.input_usd_per_m+' in / $'+p.output_usd_per_m+' out per M, from '+esc(String(p.effective_from).slice(0,10))+' '+(p.verified_at?'<span class="ok">verified</span>':'<button class="sec" data-vp="'+p.id+'">Verify price</button>')+'</div>'}).join('');
  return '<div class="card"><b>'+esc(m.display_name)+'</b> <span class="mut">'+esc(m.provider)+' / '+esc(m.provider_model)+' / '+esc(m.status)+'</span>'+pr+
  '<div class="row"><button class="sec" data-addprice="'+m.id+'">Add price</button><button class="sec" data-dp="'+m.id+'">Verify data policy</button><button class="sec" data-conf="'+m.id+'">Run conformance check</button><button class="sec" data-act="'+m.id+'">Activate</button><button class="sec" data-all="'+m.id+'">Use for all tasks</button></div>'+
  '<div class="mut">Data policy: '+esc(m.trains_on_inputs)+(m.data_policy_verified_at?' (verified '+esc(String(m.data_policy_verified_at).slice(0,10))+')':' (not verified)')+' · conformance: '+(m.conformance_passed_at?'<span class="ok">passed</span>':'not passed')+' · cleared for confidential: '+(m.confidential_ok?'<span class="ok">yes</span>':'<span class="bad">no</span>')+'</div></div>'}).join('')||'<div class="mut">No models yet.</div>';
 $('prompts').innerHTML=s.prompts.map(function(p){return '<div class="mut">'+esc(p.kind)+' v'+p.version+' '+esc(p.name)+' <b>'+esc(p.status)+'</b></div>'}).join('');
 var t=await api('GET','/api/setup/team').catch(function(){return []});$('team').innerHTML=t.map(function(x){return '<div class="mut">'+esc(x.email)+' · '+esc(x.role)+'</div>'}).join('');
 var iv=await api('GET','/api/investigations');$('invs').innerHTML=iv.map(function(i){return '<div class="card"><a href="#" data-open="'+i.id+'"><b>'+esc(i.title)+'</b></a><div class="mut">'+esc(i.status)+' · spent ₹'+Number(i.spent_inr).toFixed(2)+' of ₹'+Number(i.cap_inr).toFixed(0)+(i.coverage_note?' · '+esc(i.coverage_note):'')+'</div></div>'}).join('')||'<div class="mut">None yet.</div>';
}catch(e){say(e.message,true)}}
$('saveBudget').onclick=async function(){try{await api('PUT','/api/setup/settings',{monthlyBudgetInr:+$('mb').value,investigationCapInr:+$('ic').value,testRunCapInr:$('tc').value?+$('tc').value:null,fxRateInrPerUsd:+$('fx').value});say('Budgets saved.');refresh()}catch(e){say(e.message,true)}};
$('listModels').onclick=async function(){try{say('Asking the provider...');var a=await api('GET','/api/setup/available-models');var h='';Object.keys(a).forEach(function(p){var l=a[p];if(l.error){h+='<div class="bad">'+esc(p)+': '+esc(l.error)+'</div>';return}l.filter(function(m){return m.supportsGeneration}).forEach(function(m,i){h+='<div class="row"><span>'+esc(m.displayName)+' <span class="mut">'+esc(m.providerModel)+' · ctx '+m.contextTokens+' · out '+m.maxOutputTokens+'</span></span><button class="sec" data-pick="'+esc(p)+'|'+i+'">Add</button></div>'});window.__avail=a});$('avail').innerHTML=h;say('Done.')}catch(e){say(e.message,true)}};
$('avail').onclick=async function(ev){var k=ev.target.getAttribute&&ev.target.getAttribute('data-pick');if(!k)return;var p=k.split('|')[0],i=+k.split('|')[1];var m=window.__avail[p].filter(function(x){return x.supportsGeneration})[i];
 try{await api('POST','/api/setup/models',{provider:p,providerModel:m.providerModel,displayName:m.displayName,contextTokens:m.contextTokens||1,maxOutputTokens:m.maxOutputTokens||1,supportsStructuredOutput:true,supportsToolCalling:true,supportsEmbeddings:m.supportsEmbeddings});say('Added. Now add its price from the provider pricing page.');refresh()}catch(e){say(e.message,true)}};
$('models').onclick=async function(ev){var a=ev.target;try{
 if(a.dataset.vp){await api('POST','/api/setup/prices/'+a.dataset.vp+'/verify');say('Price verified.')}
 else if(a.dataset.addprice){var i=prompt('Input price, US$ per million tokens');var o=prompt('Output price, US$ per million tokens');var d=prompt('Effective from (YYYY-MM-DD)');var n=prompt('Where you read it (page name or URL)');if(!i||!o||!d)return;await api('POST','/api/setup/models/'+a.dataset.addprice+'/prices',{inputUsdPerM:+i,outputUsdPerM:+o,effectiveFrom:d,sourceNote:n});say('Price added. Compare it with the provider page, then click Verify price.')}
 else if(a.dataset.dp){var url=prompt('URL of the data-use terms you read');var note=prompt('How long are prompts and responses retained? (your words)');var tr=confirm('Press OK if the terms say your content is NOT used to train or improve products on this paid plan. Press Cancel if it IS used or you are unsure.')?'no':'yes';if(!url||!note)return;await api('POST','/api/setup/models/'+a.dataset.dp+'/data-policy',{trainsOnInputs:tr,sourceUrl:url,retentionNote:note});say('Data policy recorded as verified today.')}
 else if(a.dataset.conf){say('Running the conformance check (about ten tiny calls)...');var r=await api('POST','/api/setup/models/'+a.dataset.conf+'/conformance');say((r.passed?'PASSED':'FAILED')+': '+r.checks.map(function(c){return (c.skipped?'skip ':c.passed?'ok ':'FAIL ')+c.id+(c.passed?'':' ('+c.detail+')')}).join('; '),!r.passed)}
 else if(a.dataset.act){await api('POST','/api/setup/models/'+a.dataset.act+'/activate');say('Model activated.')}
 else if(a.dataset.all){await api('PUT','/api/setup/routes',{allTasks:a.dataset.all});say('This model is now used for every task.')}
 else return;refresh()}catch(e){say(e.message,true)}};
$('addTeam').onclick=async function(){try{await api('POST','/api/setup/team',{email:$('te').value,role:$('tr').value});say('Access added.');refresh()}catch(e){say(e.message,true)}};
$('create').onclick=async function(){try{var r=await api('POST','/api/investigations',{title:$('nt').value,problem:$('np').value,capInr:$('nc').value?+$('nc').value:undefined,confidential:$('nconf').checked});say('Created. Planning...');open_(r.id)}catch(e){say(e.message,true)}};
$('invs').onclick=function(ev){var id=ev.target.getAttribute&&ev.target.getAttribute('data-open');if(id){ev.preventDefault();open_(id)}};
var timer=null;
async function open_(id){clearInterval(timer);await show(id);timer=setInterval(function(){show(id)},4000)}
async function show(id){try{var d=await api('GET','/api/investigations/'+id);var i=d.investigation,h='<h2>'+esc(i.title)+'</h2><div>Status: <b>'+esc(i.status)+'</b> · spent ₹'+d.spentInr.toFixed(2)+' of ₹'+i.capInr+(i.coverageNote?' · <span class="bad">'+esc(i.coverageNote)+'</span>':'')+'</div>';
 if(i.coverageProfile&&i.coverageProfile.limited)h+='<div class="card"><b>Limited coverage:</b> '+esc(i.coverageProfile.reasons.join('; '))+'</div>';
 if(i.status==='awaiting_approval'&&d.plan){h+='<h3>Plan for your approval</h3>';if(d.plan.estimate)h+='<div class="mut">Estimated research cost ₹'+d.plan.estimate.lowInr+' to ₹'+d.plan.estimate.highInr+' (expected ₹'+d.plan.estimate.expectedInr+'). '+esc(d.plan.estimate.assumptions)+'</div>';
  h+='<div>You can edit the JSON below (remove searches you do not want), then approve.</div><textarea id="planbox" style="min-height:260px">'+esc(JSON.stringify(d.plan.plan,null,2))+'</textarea><div class="row"><button id="approve">Approve and start research</button><button class="sec" id="reject">Reject</button></div>'}
 if(['researching','reporting'].includes(i.status))h+='<div class="row"><button class="sec" id="stop">Stop now</button></div>';
 if(d.searchLog.length)h+='<h3>Coverage log</h3>'+d.searchLog.map(function(l){return '<div class="mut">'+esc(l.origin)+' · '+esc(l.tool)+' · '+esc(l.query)+' · <b>'+esc(l.status)+'</b>'+(l.result_count!=null?' ('+l.result_count+')':'')+'</div>'}).join('');
 if(d.report){h+='<h3>Report'+(d.report.partial?' (partial)':'')+'</h3>'+(d.report.banner?'<div class="card">'+esc(d.report.banner)+'</div>':'')+d.report.sections.map(function(s){return '<div class="card"><b>'+esc(s.title)+'</b><pre>'+esc(s.content)+'</pre></div>'}).join('')}
 if(d.findings.length)h+='<h3>Findings ('+d.findings.length+')</h3>'+d.findings.map(function(f){return '<div class="card">'+esc(f.claim)+'<div class="mut">'+esc(f.evidence_label)+' · '+esc(f.verification_status)+(f.label_check==='failed'?' · <span class="bad">label not supported: '+esc(f.label_check_note)+'</span>':'')+' · '+f.sources.map(function(s){return esc(s.handle)}).join(', ')+'</div></div>'}).join('');
 if(d.sources.length)h+='<h3>Sources</h3>'+d.sources.map(function(s){return '<div class="mut">'+esc(s.handle)+' · '+esc(s.title)+' · '+esc(s.type)+' · '+esc(s.verification)+' · seen: '+esc(s.seen)+(s.doi?' · doi '+esc(s.doi):'')+'</div>'}).join('');
 var box=$('detail'),keep=document.getElementById('planbox')&&document.activeElement===document.getElementById('planbox');if(keep)return;box.innerHTML=h;
 if($('approve'))$('approve').onclick=async function(){try{var plan=JSON.parse($('planbox').value);await api('POST','/api/investigations/'+id+'/approve',{plan:plan});say('Approved. Research started.');show(id)}catch(e){say(e.message,true)}};
 if($('reject'))$('reject').onclick=async function(){try{await api('POST','/api/investigations/'+id+'/reject');say('Rejected.');show(id)}catch(e){say(e.message,true)}};
 if($('stop'))$('stop').onclick=async function(){try{await api('POST','/api/investigations/'+id+'/stop');say('Stop requested.')}catch(e){say(e.message,true)}};
 if(['complete','stopped_budget','stopped_user','failed'].includes(i.status)){clearInterval(timer);refresh()}
}catch(e){say(e.message,true)}}
})();
</script></body></html>`;
}

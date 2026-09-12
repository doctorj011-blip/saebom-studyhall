const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const core = require('../saebom-admin-core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../saebom_schedule_with_hours.html'), 'utf8');
function section(a, b) {
  const i = source.indexOf(a), j = source.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, a);
  return source.slice(i, j);
}
test('every inline script parses, including Firebase modules', () => {
  for (const [, attrs, code] of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!code.trim() || /application\/ld\+json/.test(attrs)) continue;
    const r = spawnSync(process.execPath, ['--check', '--input-type=' + (/type="module"/.test(attrs) ? 'module' : 'commonjs')], {input:code, encoding:'utf8'});
    assert.equal(r.status, 0, r.stderr);
  }
});
for (const [label, student, month, expected] of [
  ['future withdrawal still bills this month', {withdrawAt:'2026-12-31'}, '2026-09', true],
  ['withdrawal before month excluded', {withdrawAt:'2026-08-31'}, '2026-09', false],
  ['withdrawal on first day included', {withdrawAt:'2026-09-01'}, '2026-09', true],
  ['future enrolment excluded', {startDate:'2026-10-01'}, '2026-09', false],
  ['end-of-month enrolment included', {startDate:'2026-09-30'}, '2026-09', true],
  ['invalid month rejected', {}, '2026-13', false]
]) test(label, () => assert.equal(core.billingEligible(student, month), expected));
test('configured base is shared, discount applied once', () => assert.deepEqual(core.bill({}, core.baseFee({defaultFee:350000}), 20000), {base:350000,won:20000,pay:330000,flat:false}));
test('flat fee does not receive general discount', () => assert.deepEqual(core.bill({fee:80000},350000,20000), {base:80000,won:0,pay:80000,flat:true}));
test('discount cannot make a negative fee', () => assert.equal(core.bill({},300000,400000).pay,0));
test('missing and invalid configuration fail closed; explicit free fee allowed', () => {
  for (const value of [null,{}, {defaultFee:-1}, {defaultFee:'abc'}, {defaultFee:''}]) assert.throws(() => core.baseFee(value));
  assert.equal(core.baseFee({defaultFee:0}),0);
});
test('latest state collapses repeat visits without merging different student IDs', () => {
  const rows = [{uid:'a',inTs:1,outTime:'done'}, {uid:'a',inTs:2}, {uid:'b',inTs:1}];
  assert.deepEqual(core.latestRecords(rows),rows.slice(1));
});
test('bounded reads preserve input order', async () => {
  let active=0, peak=0;
  const out = await core.mapLimit([1,2,3,4,5],2,async n => {peak=Math.max(peak,++active); await new Promise(r=>setImmediate(r)); active--; return n*2;});
  assert.deepEqual(out,[2,4,6,8,10]); assert.equal(peak,2);
});
function periodContext(date, vacation) {
  const NativeDate=Date;
  const ctx=vm.createContext({window:{}, Date:class extends NativeDate {constructor(...args){super(...(args.length ? args : date));}}});
  vm.runInContext(section('const PERIODS_WEEKDAY','function updateNowPeriodChip()') + section('function getCurrentPeriod() {','// 오늘 입실 현황 팝업'),ctx);
  vm.runInContext('VACATION_MODE = '+vacation,ctx);
  return ctx;
}
for (const [label, date, vacation, phase, period] of [
  ['term Monday morning', [2026,8,14,9,30],false,'before',null],
  ['vacation morning', [2026,6,27,9,30],true,'in',1],
  ['vacation midnight excludes 11', [2026,6,28,0,20],true,'after',null],
  ['term midnight retains 11', [2026,8,15,0,20],false,'in',11],
  ['Sunday closed', [2026,8,13,12,0],false,'closed',null],
  ['Saturday midnight continues on Sunday', [2026,8,13,0,20],false,'in',11],
  ['period end is break', [2026,8,14,18,50],false,'break',null]
]) test(label,()=>{
  const ctx=periodContext(date,vacation);
  assert.equal(vm.runInContext('_currentPeriodInfo().phase',ctx),phase);
  assert.equal(vm.runInContext('getCurrentPeriod()',ctx),period);
});
function checkinContext(resultPromise) {
  const el = new Map();
  const get = id => {if(!el.has(id))el.set(id,{style:{},textContent:'',classList:{},disabled:false});return el.get(id);};
  get('confirm-ok-btn')._student={uid:'fixture',name:'테스트',seat:'1'};
  get('confirm-ok-btn')._isCheckout=false;
  const calls=[];
  const ctx=vm.createContext({window:{}, document:{getElementById:get,querySelectorAll:()=>[]},
    waitSessionApi:async()=>({checkin:()=>resultPromise}),
    todayRecords:[], PRESENT:[], isLateNightCheckinBlocked:()=>false,
    checkinReset:()=>{ctx.window._checkinProcessing=false;calls.push('reset');},
    showAdminToast:()=>{}, console:{error(){}}, setTimeout:()=>{},
    maskName:s=>s, studyroomForEntry:()=>({room:null,duringPeriod:false}),
    saveCheckinToFirebase:()=>calls.push('log'),sendCheckinSMS:()=>calls.push('sms'),
    buildCheckinTodayList:()=>{},buildDashboard:()=>{},buildFloorplan:()=>{},
  });
  ctx.window.requestDoorOpen=()=>calls.push('door');
  vm.runInContext(section('async function confirmSessionAction(action)', '// ── 외출/복귀: 문자'),ctx);
  return {ctx,calls,get};
}
test('no completion, local record, SMS or door before commit', async()=>{
  let resolve;
  const pending=new Promise(r=>{resolve=r;});
  const {ctx,calls,get}=checkinContext(pending);
  const task=ctx.window.checkinConfirm();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls,[]); assert.equal(ctx.todayRecords.length,0);
  assert.notEqual(get('checkin-done-panel').style.display,'block');
  resolve({ok:true,inTs:Date.now()}); await task;
  assert.deepEqual(calls,['log','sms','door']); assert.equal(ctx.todayRecords.length,1);
});
for(const value of [{ok:false,reason:'error'}, {ok:false,reason:'already-open'}, {ok:true,fallback:true}, null]) {
  test('unsuccessful session produces no downstream actions '+JSON.stringify(value),async()=>{
    const {ctx,calls,get}=checkinContext(Promise.resolve(value));
    await ctx.window.checkinConfirm();
    assert.deepEqual(calls,['reset']); assert.equal(ctx.todayRecords.length,0);
    assert.equal(ctx.window._checkinProcessing,false);
    assert.equal(get('checkin-error').style.display,'block');
  });
}
test('double tap while saving creates one request',async()=>{
  let resolve; const {ctx,calls}=checkinContext(new Promise(r=>{resolve=r;}));
  const a=ctx.window.checkinConfirm(); await ctx.window.checkinConfirm();
  resolve({ok:true,inTs:Date.now()}); await a;
  assert.deepEqual(calls,['log','sms','door']);
});
test('log cleanup never reads or deletes attendance sessions',async()=>{
  const reads=[],removed=[];
  const ctx=vm.createContext({window:{},db:{},collection:(_,col)=>col,doc:(_,col,id)=>col+'/'+id,
    getDocs:async col=>{reads.push(col);return {forEach:f=>f({id:'old',data:()=>({date:'2020-01-01'})})};},
    deleteDoc:async ref=>removed.push(ref), console:{log(){},warn(){}}});
  vm.runInContext(section('window.purgeOldLogs = async function','// 설정 탭 버튼용: 건수 확인'),ctx);
  await ctx.window.purgeOldLogs(60,true);
  assert.deepEqual(reads,['checkin_logs','sms_logs','usage_logs']); assert.equal(removed.length,3);
  assert.ok(removed.every(x=>!x.startsWith('attendance_sessions/')));
});
test('frozen billing notice takes priority over changed fee/discount',()=>{
  const ctx=vm.createContext({_billingNotices:{id:{pay:280000,won:20000}},_billingYm:'2026-09',
    _billingConfig:{defaultFee:350000},_billingDiscounts:{u:10000},SaebomAdminCore:core,
    window:{_billingDocId:()=> 'id'}});
  vm.runInContext(section('function _billingDiscOf(s){','function _billingMonthLabel'),ctx);
  assert.equal(vm.runInContext('_billingFee({uid:"u"})',ctx),280000);
  assert.equal(vm.runInContext('_billingDiscOf({uid:"u"})',ctx),20000);
});
test('failed discount lookup blocks payment and SMS actions',async()=>{
  let sends=0;
  const elements=new Map();
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:'',value:''});return elements.get(id);}};
  const api={doc:(_,col,id)=>col+'/'+id,collection:(_,col)=>col,where:(...args)=>args,query:(...args)=>args,
    getDoc:async()=>({exists:()=>true,data:()=>({defaultFee:300000}),metadata:{fromCache:false}}),
    getDocs:async()=>{throw Error('discount query failed');}};
  const ctx=vm.createContext({window:{_adminDb:{},_fs:api},document,STUDENTS:[],SaebomAdminCore:core,
    _curYm:()=> '2026-09', console:{error(){}},setTimeout:()=>{},showAdminToast:()=>{},solapiSend:()=>{sends++;}});
  vm.runInContext(section('let _billingYm = _curYm();','let _smsLogData = []'),ctx);
  await ctx.window.loadBillingTab();
  assert.equal(vm.runInContext('_billingReady',ctx),false);
  await ctx.window.sendBillingReminders();
  await ctx.window.confirmBillingPayment('any');
  assert.equal(sends,0);
  assert.match(document.getElementById('billing-list').textContent,/중지/);
});
for(const action of ['sessionCheckin','sessionCheckout','sessionAway']) test(action+' failure never uses non-atomic fallback writes',async()=>{
  let writes=0;
  const ctx=vm.createContext({window:{},db:{},runTransaction:async()=>{throw Object.assign(Error('offline'),{code:'unavailable'});},
    _sessCleanSeat:s=>s,_sessUid:s=>s.uid,SH:{sessMonthKey:()=> '2026-09'},
    recomputeMonthHours:async()=>{},setDoc:()=>{writes++;},updateDoc:()=>{writes++;},deleteDoc:()=>{writes++;},
    console:{warn(){},error(){}}});
  vm.runInContext(section('async function sessionCheckin(student){','// ── 월 누적 재계산 (멱등)'),ctx);
  const result=await vm.runInContext(action+'({seat:"1",name:"테스트",uid:"fixture"})',ctx);
  assert.equal(result.ok,false); assert.equal(writes,0);
});

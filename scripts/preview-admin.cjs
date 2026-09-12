// Local visual fixture. Removes all app scripts; never initializes Firebase.
// Run: node scripts/preview-admin.cjs, then open http://127.0.0.1:8765/
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.join(__dirname,'..');
const original=fs.readFileSync(path.join(root,'saebom_schedule_with_hours.html'),'utf8');
const start=original.indexOf('function buildCheckinTodayList() {');
const end=original.indexOf('// 외출 경과 시간',start);
const core=fs.readFileSync(path.join(root,'saebom-admin-core.js'),'utf8');
const fixture=`${core}
window._checkinLoadState='ready'; window.isNonStudent=()=>false; window._awayStudents={};
const todayRecords=[{uid:'fixture-a',studentName:'테스트학생',seat:'1',inTime:'오후 06:00',inTs:1,outTime:'오후 06:30'},
{uid:'fixture-a',studentName:'테스트학생',seat:'1',inTime:'오후 07:00',inTs:2,outTime:null}];
function maskName(n){return n[0]+'O'.repeat(n.length-1);} function awayInfo(){return null;}
${original.slice(start,end)}
buildCheckinTodayList();
document.getElementById('now-period-chip').textContent='10교시 · 22:30~23:50';
`;
const html=original.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'') + '<script>'+fixture+'</script>';
http.createServer((req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; img-src 'self' data:; script-src 'unsafe-inline'; connect-src 'none'");
  if(req.url==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  const asset=path.basename(req.url.split('?')[0]);
  if(!/\.(png|jpg)$/.test(asset)){res.writeHead(404);res.end();return;}
  const file=path.join(root,asset);
  if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',asset.endsWith('.png')?'image/png':'image/jpeg');res.end(fs.readFileSync(file));
}).listen(8765,'127.0.0.1',()=>console.log('Isolated preview: http://127.0.0.1:8765/ (Firebase disabled)'));

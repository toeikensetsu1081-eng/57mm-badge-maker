const express=require('express');
const multer=require('multer');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const QRCode=require('qrcode');
const {PDFDocument}=require('pdf-lib');
const {Pool}=require('pg');

const app=express();
app.disable('x-powered-by');
const PORT=process.env.PORT||3000;
const DIR=path.join(__dirname,'uploads');
fs.mkdirSync(DIR,{recursive:true});
const MAX_AGE=2*60*60*1000;
const sessions=new Map();
const photos=new Map();

function token(n=24){return crypto.randomBytes(n).toString('base64url');}
function safeSession(s){return typeof s==='string' && /^[A-Za-z0-9_-]{20,80}$/.test(s);}
function owns(id,s){const p=photos.get(id);return p && p.session===s;}
function mm(v){return v*72/25.4;}

const storage=multer.diskStorage({
 destination:(req,file,cb)=>cb(null,DIR),
 filename:(req,file,cb)=>cb(null,token(18)+'.upload')
});
const upload=multer({
 storage,
 limits:{fileSize:15*1024*1024,files:1},
 fileFilter:(req,file,cb)=>{
   const ok=['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.mimetype);
   cb(ok?null:new Error('画像形式が未対応です'),ok);
 }
});

app.use((req,res,next)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Cache-Control',req.path.startsWith('/api/')?'no-store':'no-cache');
 next();
});

app.use(express.json({limit:'20mb'}));

const BLOCKED_FILES=new Set([
 'server.js','package.json','package-lock.json','render.yaml',
 'README.txt','README_Ver6.1.txt','README_Ver6.3.txt','.env'
]);
app.use((req,res,next)=>{
 if(req.path.startsWith('/uploads/'))return res.status(404).end();
 if(BLOCKED_FILES.has(path.basename(req.path)))return res.status(404).end();
 next();
});
app.use(express.static(__dirname,{index:false}));

// Shared queue: DATABASE_URL enables durable PostgreSQL storage.
// Local JSON fallback is only for testing: Render Free restarts can erase it.
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false}}):null;
const queueFile=path.join(DIR,'shared-queue.json');
let localQueue=[];
try{if(!pool&&fs.existsSync(queueFile))localQueue=JSON.parse(fs.readFileSync(queueFile,'utf8'));}catch(e){localQueue=[];}
function writeLocal(){fs.writeFileSync(queueFile+'.tmp',JSON.stringify(localQueue));fs.renameSync(queueFile+'.tmp',queueFile);}
let dbReady=pool?pool.query('CREATE TABLE IF NOT EXISTS badge_queue (id TEXT PRIMARY KEY, image TEXT NOT NULL, created_at BIGINT NOT NULL)').then(()=>true).catch(e=>{console.error('Queue database unavailable:',e);return false}):Promise.resolve(true);
async function queryQueue(){
 if(pool){if(!await dbReady)throw Error('database unavailable');const r=await pool.query('SELECT id,image,created_at FROM badge_queue ORDER BY created_at ASC,id ASC');return r.rows;}
 return localQueue.slice().sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id));
}
// No-password operation: the print queue can be viewed and marked printed
// by anyone who can reach the service. Use only in a trusted event workflow.
app.get('/api/queue',async(req,res)=>{
 try{
  const items=await queryQueue();
  res.json({count:items.length,items:items.slice(0,6)});
 }catch(e){res.status(503).json({error:'印刷待ちを取得できません'});}
});
app.post('/api/queue',async(req,res)=>{
 try{
  const image=req.body&&req.body.image;
  if(typeof image!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>6*1024*1024)return res.status(400).json({error:'画像形式またはサイズが不正です'});
  const id=token(18),created=Date.now();
  if(pool){if(!await dbReady)throw Error('database unavailable');await pool.query('INSERT INTO badge_queue(id,image,created_at) VALUES($1,$2,$3)',[id,image,created]);}
  else{localQueue.push({id,image,created_at:created});writeLocal();}
  res.json({ok:true,id});
 }catch(e){res.status(503).json({error:'共通の印刷待ちに保存できません'});}
});
app.post('/api/queue/printed',async(req,res)=>{
 try{
  const ids=req.body&&req.body.ids;
  if(!Array.isArray(ids)||!ids.length||ids.length>6||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{20,80}$/.test(id)))return res.status(400).json({error:'対象が不正です'});
  if(pool){if(!await dbReady)throw Error('database unavailable');await pool.query('DELETE FROM badge_queue WHERE id=ANY($1::text[])',[ids]);}
  else{localQueue=localQueue.filter(item=>!ids.includes(item.id));writeLocal();}
  res.json({ok:true});
 }catch(e){res.status(503).json({error:'印刷済み処理に失敗しました'});}
});

app.get('/',(req,res)=>res.redirect('/staff.html'));

app.post('/api/session',(req,res)=>{
 const s=token(24);
 sessions.set(s,{created:Date.now()});
 res.json({session:s});
});

app.get('/api/qr',async(req,res)=>{
 const s=req.query.session;
 if(!safeSession(s)||!sessions.has(s))return res.status(403).end();
 try{
   const url=`${req.protocol}://${req.get('host')}/customer.html?s=${encodeURIComponent(s)}`;
   const png=await QRCode.toBuffer(url,{type:'png',width:440,margin:2,errorCorrectionLevel:'M'});
   res.type('png');
   res.setHeader('Cache-Control','no-store');
   res.send(png);
 }catch(e){res.status(500).end();}
});

app.post('/api/upload',upload.single('photo'),(req,res)=>{
 try{
   const s=req.body.session;
   if(!safeSession(s)||!sessions.has(s)){
     if(req.file)fs.unlink(req.file.path,()=>{});
     return res.status(400).json({error:'受付QRが無効です'});
   }
   if(!req.file)return res.status(400).json({error:'画像がありません'});
   const id=token(18);
   photos.set(id,{
     id,session:s,path:req.file.path,mime:req.file.mimetype,
     created:Date.now(),claimed:false
   });
   res.json({ok:true});
 }catch(e){
   if(req.file)fs.unlink(req.file.path,()=>{});
   res.status(500).json({error:'upload error'});
 }
});

app.get('/api/incoming',(req,res)=>{
 const s=req.query.session;
 if(!safeSession(s)||!sessions.has(s))return res.status(403).end();
 const items=[...photos.values()]
   .filter(p=>p.session===s&&!p.claimed)
   .sort((a,b)=>a.created-b.created)
   .map(p=>({
     id:p.id,
     created:p.created,
     thumb:'/api/photo/'+p.id+'?session='+encodeURIComponent(s)
   }));
 res.json({items});
});

app.get('/api/photo/:id',(req,res)=>{
 const s=req.query.session,p=photos.get(req.params.id);
 if(!safeSession(s)||!p||p.session!==s)return res.status(404).end();
 res.type(p.mime);
 res.setHeader('Cache-Control','no-store');
 res.sendFile(p.path);
});

app.post('/api/claim/:id',(req,res)=>{
 const s=req.query.session,p=photos.get(req.params.id);
 if(!safeSession(s)||!p||p.session!==s)return res.status(404).end();
 p.claimed=true;
 res.json({ok:true});
});

app.delete('/api/photo/:id',(req,res)=>{
 const s=req.query.session,p=photos.get(req.params.id);
 if(!safeSession(s)||!p||p.session!==s)return res.status(404).end();
 try{fs.unlinkSync(p.path)}catch(e){}
 photos.delete(p.id);
 res.json({ok:true});
});

// A4 PDF generation for Android / iPhone.
// Images are already cropped to the outer badge circle in staff.html.
app.post('/api/print-pdf',async(req,res)=>{
 try{
   const images=req.body&&req.body.images;
   if(!Array.isArray(images)||images.length<1||images.length>6){
     return res.status(400).json({error:'印刷データがありません'});
   }

   const outer=66.44;
   const centers=[
     [41.293,40.362],[117.493,40.127],[41.175,132.378],
     [118.404,133.407],[43.115,222.615],[117.934,223.615]
   ];

   const pdf=await PDFDocument.create();
   const page=pdf.addPage([mm(210),mm(297)]);

   for(let i=0;i<images.length;i++){
     const src=images[i];
     if(typeof src!=='string')return res.status(400).json({error:'印刷画像が不正です'});
     const m=src.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
     if(!m)return res.status(400).json({error:'印刷画像形式が不正です'});
     const buf=Buffer.from(m[1],'base64');
     if(buf.length>4*1024*1024)return res.status(413).json({error:'印刷画像が大きすぎます'});

     const jpg=await pdf.embedJpg(buf);
     const cx=centers[i][0],cy=centers[i][1];
     const left=cx-outer/2;
     const top=cy-outer/2;

     page.drawImage(jpg,{
       x:mm(left),
       y:mm(297-top-outer),
       width:mm(outer),
       height:mm(outer)
     });
   }

   const bytes=await pdf.save({useObjectStreams:false});
   res.setHeader('Content-Type','application/pdf');
   res.setHeader('Content-Disposition','inline; filename="57mm-badge-a4.pdf"');
   res.setHeader('Cache-Control','no-store');
   res.send(Buffer.from(bytes));
 }catch(e){
   console.error(e);
   res.status(500).json({error:'PDFを作成できませんでした'});
 }
});

function cleanup(){
 const cutoff=Date.now()-MAX_AGE;
 for(const [id,p] of photos){
   if(p.created<cutoff){
     try{fs.unlinkSync(p.path)}catch(e){}
     photos.delete(id);
   }
 }
 for(const [s,x] of sessions){
   if(x.created<cutoff)sessions.delete(s);
 }
}
setInterval(cleanup,5*60*1000).unref();

app.use((err,req,res,next)=>{
 if(req.file)fs.unlink(req.file.path,()=>{});
 res.status(400).json({error:err.message||'request error'});
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Badge app listening on ${PORT}`));

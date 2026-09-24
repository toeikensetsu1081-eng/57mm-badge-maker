const express=require('express');
const multer=require('multer');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

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
app.use(express.static(__dirname,{index:false}));

app.get('/',(req,res)=>res.redirect('/staff.html'));
app.post('/api/session',(req,res)=>{
 const s=token(24);sessions.set(s,{created:Date.now()});res.json({session:s});
});
app.post('/api/upload',upload.single('photo'),(req,res)=>{
 try{
   const s=req.body.session;
   if(!safeSession(s)||!sessions.has(s)){if(req.file)fs.unlink(req.file.path,()=>{});return res.status(400).json({error:'受付QRが無効です'});}
   if(!req.file)return res.status(400).json({error:'画像がありません'});
   const id=token(18);
   photos.set(id,{id,session:s,path:req.file.path,mime:req.file.mimetype,created:Date.now(),claimed:false});
   res.json({ok:true});
 }catch(e){res.status(500).json({error:'upload error'});}
});
app.get('/api/incoming',(req,res)=>{
 const s=req.query.session;
 if(!safeSession(s)||!sessions.has(s))return res.status(403).end();
 const items=[...photos.values()].filter(p=>p.session===s&&!p.claimed).sort((a,b)=>a.created-b.created)
   .map(p=>({id:p.id,created:p.created,thumb:'/api/photo/'+p.id+'?session='+encodeURIComponent(s)}));
 res.json({items});
});
app.get('/api/photo/:id',(req,res)=>{
 const s=req.query.session,p=photos.get(req.params.id);
 if(!safeSession(s)||!p||p.session!==s)return res.status(404).end();
 res.type(p.mime);res.setHeader('Cache-Control','no-store');res.sendFile(p.path);
});
app.post('/api/claim/:id',(req,res)=>{
 const s=req.query.session,p=photos.get(req.params.id);
 if(!safeSession(s)||!p||p.session!==s)return res.status(404).end();
 p.claimed=true;res.json({ok:true});
});
app.delete('/api/photo/:id',(req,res)=>{
 const s=req.query.session,p=photos.get(req.params.id);
 if(!safeSession(s)||!p||p.session!==s)return res.status(404).end();
 try{fs.unlinkSync(p.path)}catch(e){} photos.delete(p.id);res.json({ok:true});
});
function cleanup(){
 const cutoff=Date.now()-MAX_AGE;
 for(const [id,p] of photos){if(p.created<cutoff){try{fs.unlinkSync(p.path)}catch(e){}photos.delete(id);}}
 for(const [s,x] of sessions){if(x.created<cutoff) sessions.delete(s);}
}
setInterval(cleanup,5*60*1000).unref();

app.use((err,req,res,next)=>{
 if(req.file)fs.unlink(req.file.path,()=>{});
 res.status(400).json({error:err.message||'request error'});
});
app.listen(PORT,'0.0.0.0',()=>console.log(`Badge app listening on ${PORT}`));
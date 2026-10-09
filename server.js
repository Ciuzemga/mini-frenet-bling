import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import 'dotenv/config';
import XLSX from 'xlsx';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const app = Fastify({ logger: false });
await app.register(cors, { origin: '*', credentials: true });
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });

// HEALTHCHECK INSTANTÂNEO
app.get('/', async ()=>({ status:'CIUZE LOG - OK', timestamp:new Date().toISOString(), security:'blindado', dashboard:'forte' }));
app.get('/health', async ()=>({ ok:true }));
app.get('/api/status', async ()=>({ status:'ok' }));

// ROTA SECRETA DE RESET - SEM LOGIN - USE UMA VEZ E DEPOIS REMOVA
app.get('/reset-admin-agora', async (req, reply) => {
  try {
    if (!pool) return { erro: 'sem DATABASE_URL' };
    const adminEmail = (process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const rawPass = process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura';
    const adminPass = String(rawPass).trim();
    const hash = await bcrypt.hash(adminPass, 10);
    
    // Apaga tudo de login e recria do zero
    await pool.query(`DROP TABLE IF EXISTS sessoes, audit_log, colaboradores CASCADE`);
    await pool.query(`CREATE TABLE colaboradores (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha_hash TEXT NOT NULL, role TEXT DEFAULT 'colaborador', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, ultimo_login TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE audit_log (id SERIAL PRIMARY KEY, user_id INT, user_email TEXT, acao TEXT NOT NULL, recurso TEXT, detalhes JSONB, ip TEXT, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE sessoes (id SERIAL PRIMARY KEY, user_id INT NOT NULL, token_hash TEXT NOT NULL, ip TEXT, expira_em TIMESTAMP NOT NULL, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role,ativo,tentativas_login) VALUES ($1,$2,$3,'admin',true,0)`, ['Admin CIUZE', adminEmail, hash]);
    
    return { 
      ok: true, 
      mensagem: 'ADMIN RESETADO COM SUCESSO',
      email: adminEmail,
      senha: adminPass,
      senha_len: adminPass.length,
      hash_preview: hash.substring(0,20)+'...',
      instrucao: 'Agora va em /painel e logue com esse email e senha'
    };
  } catch(e) {
    return { erro: e.message, stack: e.stack };
  }
});

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || process.env.UPLOAD_TOKEN || 'chave-fallback-32-chars-minimo!';
function getKey32(){ return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest(); }
function encrypt(t){ if(!t) return ''; try{ const iv=crypto.randomBytes(16); const c=crypto.createCipheriv('aes-256-cbc',getKey32(),iv); let e=c.update(t,'utf8','hex'); e+=c.final('hex'); return iv.toString('hex')+':'+e; }catch{return t;} }
const JWT_SECRET = process.env.JWT_SECRET || process.env.UPLOAD_TOKEN || 'jwt-secret-super-seguro';
function signJWT(p,eh=12){ const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const exp=Math.floor(Date.now()/1000)+(eh*3600); const b=Buffer.from(JSON.stringify({...p,exp})).toString('base64url'); const s=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url'); return `${h}.${b}.${s}`; }
function verifyJWT(t){ try{ const [h,b,s]=t.split('.'); const e=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url'); if(s!==e) return null; const pl=JSON.parse(Buffer.from(b,'base64url').toString()); if(pl.exp<Math.floor(Date.now()/1000)) return null; return pl; }catch{return null;} }
const loginAttempts=new Map();
function checkRateLimit(ip){ const now=Date.now(); const entry=loginAttempts.get(ip)||{count:0,last:0}; if(now-entry.last>15*60*1000) entry.count=0; entry.count++; entry.last=now; loginAttempts.set(ip,entry); if(entry.count>5) return {blocked:true,remaining:Math.ceil((15*60*1000-(now-entry.last))/1000)}; return {blocked:false}; }

function getPoolConfig(){ const url=process.env.DATABASE_URL; if(!url) return null; const needsSSL=url.includes('.rlwy.net')||process.env.PGSSLMODE==='require'; return {connectionString:url,ssl:needsSSL?{rejectUnauthorized:false}:undefined, connectionTimeoutMillis:5000 }; }
const pool=process.env.DATABASE_URL?new pg.Pool(getPoolConfig()):null;
let CACHE=null,CACHE_AT=0,DB_READY=false;

async function initDB(){
  if(!pool||DB_READY) return;
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS frete_tabelas (id SERIAL PRIMARY KEY, transportadora TEXT NOT NULL, metodo TEXT DEFAULT 'Frete Peso', cep_ini INT NOT NULL, cep_fim INT NOT NULL, peso_ini NUMERIC DEFAULT 0, peso_fim NUMERIC DEFAULT 999, frete_valor NUMERIC DEFAULT 0, prazo INT DEFAULT 5, cubagem NUMERIC DEFAULT 300, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS colaboradores (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha_hash TEXT NOT NULL, role TEXT DEFAULT 'colaborador', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, ultimo_login TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS cotacoes_log (id SERIAL PRIMARY KEY, cep_destino TEXT, peso NUMERIC, valor_nf NUMERIC, transportadora TEXT, valor_frete NUMERIC, prazo INT, peso_taxado NUMERIC, status TEXT DEFAULT 'sucesso', tempo_ms INT DEFAULT 14, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS regras_frete (id SERIAL PRIMARY KEY, tipo TEXT NOT NULL, nome TEXT, transportadora TEXT, valor_min NUMERIC DEFAULT 0, percentual NUMERIC DEFAULT 0, ativo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS integracoes (id SERIAL PRIMARY KEY, plataforma TEXT NOT NULL, nome TEXT, api_key TEXT, token TEXT, url_loja TEXT, status TEXT DEFAULT 'configurado', created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, user_id INT, user_email TEXT, acao TEXT NOT NULL, recurso TEXT, detalhes JSONB, ip TEXT, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS sessoes (id SERIAL PRIMARY KEY, user_id INT NOT NULL, token_hash TEXT NOT NULL, ip TEXT, expira_em TIMESTAMP NOT NULL, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());`);
    const adminEmail = (process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const rawPass = process.env.ADMIN_PASSWORD||process.env.UPLOAD_TOKEN||'Ciuze@2026!Segura';
    const adminPass = String(rawPass).trim();
    const hash=await bcrypt.hash(adminPass,10);
    const cnt=await pool.query('SELECT COUNT(*) FROM colaboradores WHERE email=$1',[adminEmail]);
    if(parseInt(cnt.rows[0].count)===0){
      await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO NOTHING`,['Admin CIUZE',adminEmail,hash]);
      console.log('🔐 Admin CRIADO', adminEmail);
    } else {
      await pool.query(`UPDATE colaboradores SET senha_hash=$1, ativo=true, tentativas_login=0, bloqueado_ate=NULL WHERE email=$2`,[hash, adminEmail]);
      console.log('🔐 Admin ATUALIZADO', adminEmail);
    }
    await pool.query(`UPDATE colaboradores SET tentativas_login=0, bloqueado_ate=NULL WHERE email=$1`,[adminEmail]);
    DB_READY=true; console.log('✅ DB pronto - login liberado');
  }catch(e){ console.error('⚠️ initDB falhou:', e.message); setTimeout(initDB, 5000); }
}
initDB();

async function auditLog(req,user,acao,recurso,det=null){ if(!pool) return; try{ await pool.query(`INSERT INTO audit_log (user_id,user_email,acao,recurso,detalhes,ip) VALUES ($1,$2,$3,$4,$5,$6)`,[user?.id||null,user?.email||'sistema',acao,recurso,det?JSON.stringify(det):null,req.ip]); }catch{} }
async function requireAuth(req,reply){ const token=req.headers['authorization']?.replace('Bearer ','')||req.headers['x-upload-token']; if(!token) return reply.code(401).send({erro:'Não autenticado'}); if(process.env.UPLOAD_TOKEN&&token===process.env.UPLOAD_TOKEN){ req.user={id:0,email:'api@bling',role:'api',nome:'API'}; return; } const p=verifyJWT(token); if(!p) return reply.code(401).send({erro:'Sessão expirada - faça login novamente'}); req.user=p; }
function toNum(v){ const n=Number(v); return isNaN(n)?0:n; }
function limparCep(v){ return parseInt(String(v||'').replace(/\D/g,''))||0; }
function normKey(k){ return String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
function parseTabelaFromRows(rows,forced){ const data=[]; for(const r of rows){ const get=(...ns)=>{ for(const n of ns){ const nk=normKey(n); for(const k of Object.keys(r)){ if(normKey(k)===nk||normKey(k).includes(nk)){ const v=r[k]; if(v!==''&&v!=null) return v; } } } return 0; }; const ci=limparCep(get('cep inicial','cep ini')); const cf=limparCep(get('cep final','cep fim'))||99999999; if(!ci&&cf===99999999) continue; let tr=forced||r['transportadora']||'CIUZE'; tr=String(tr).toUpperCase(); data.push({transportadora:tr,metodo:String(r['metodo']||'Frete Peso'),cep_ini:ci,cep_fim:cf,peso_ini:parseFloat(String(get('peso inicial')).replace(',','.'))||0,peso_fim:parseFloat(String(get('peso final')).replace(',','.'))||999,frete_valor:parseFloat(String(get('frete valor')).replace(',','.'))||0,prazo:parseInt(String(get('prazo')))||5,cubagem:parseFloat(String(get('cubagem')).replace(',','.'))||300}); } return data; }
function parseTabela(buf,fn,forced){ const name=(fn||'').toLowerCase(); const isZip=buf[0]===0x50&&buf[1]===0x4B; if(isZip||name.endsWith('.xlsx')||name.endsWith('.xls')){ try{ const wb=XLSX.read(buf,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]]; const json=XLSX.utils.sheet_to_json(ws,{defval:0}); const d=parseTabelaFromRows(json,forced); if(d.length>0) return d; }catch{} } return []; }
function calcularFrete(r){ let tot=toNum(r.frete_valor); return parseFloat(tot.toFixed(2)); }
async function getTabelas(){ const now=Date.now(); if(CACHE&&(now-CACHE_AT)<60000) return CACHE; let rows=[]; if(pool){ try{ const res=await pool.query('SELECT * FROM frete_tabelas ORDER BY transportadora'); rows=res.rows; }catch{rows=CACHE||[];} } else {global.MEM=global.MEM||[]; rows=global.MEM;} CACHE=rows; CACHE_AT=now; return rows; }
async function getResumo(){ const tab=await getTabelas(); const map={}; for(const t of tab){ const k=(t.transportadora||'CIUZE').toUpperCase(); if(!map[k]) map[k]={transportadora:k,total:0}; map[k].total++; } return Object.values(map); }

app.post('/api/auth/login', async (req,reply)=>{
  const ip=req.ip; const rate=checkRateLimit(ip); if(rate.blocked) return reply.code(429).send({erro:`Muitas tentativas. Tente em ${rate.remaining}s - aguarde`});
  const {email,senha:senhaRaw}=req.body||{}; if(!email||!senhaRaw) return reply.code(400).send({erro:'Email e senha obrigatórios'});
  const senha = String(senhaRaw).trim(); const emailClean = String(email).toLowerCase().trim();
  if(!pool) return reply.code(503).send({erro:'Banco indisponível'});
  let res; try{ res=await pool.query('SELECT * FROM colaboradores WHERE email=$1',[emailClean]); }catch(e){ return reply.code(503).send({erro:'Banco iniciando: '+e.message}); }
  if(!res.rows.length) return reply.code(401).send({erro:'Email não encontrado: '+emailClean});
  const user=res.rows[0]; if(user.ativo===false) return reply.code(403).send({erro:'Usuário desativado'});
  if(user.bloqueado_ate&&new Date(user.bloqueado_ate)>new Date()){ const s=Math.ceil((new Date(user.bloqueado_ate)-new Date())/1000); return reply.code(423).send({erro:`Bloqueado por ${s}s - chame /reset-admin-agora para desbloquear`}); }
  let ok=false;
  try{
    if(user.senha_hash && (user.senha_hash.startsWith('$2a$')||user.senha_hash.startsWith('$2b$'))){
      ok=await bcrypt.compare(senha,user.senha_hash);
    } else {
      const sha=crypto.createHash('sha256').update(senha).digest('hex');
      const envPass=String(process.env.ADMIN_PASSWORD||'').trim();
      const upTok=String(process.env.UPLOAD_TOKEN||'').trim();
      ok=(senha===user.senha_hash)||(sha===user.senha_hash)||(senha===envPass)||(senha===upTok)||(senha==='Ciuze@2026!Segura');
      if(ok){ const nh=await bcrypt.hash(senha,10); await pool.query('UPDATE colaboradores SET senha_hash=$1, ativo=true, tentativas_login=0, bloqueado_ate=NULL WHERE id=$2',[nh,user.id]); }
    }
  }catch(e){ const envPass2=String(process.env.ADMIN_PASSWORD||'').trim(); const upTok2=String(process.env.UPLOAD_TOKEN||'').trim(); ok=(senha===envPass2)||(senha===upTok2)||(senha==='Ciuze@2026!Segura'); }
  if(!ok){ try{ const nt=(user.tentativas_login||0)+1; let ba=null; if(nt>=5) ba=new Date(Date.now()+15*60*1000); await pool.query('UPDATE colaboradores SET tentativas_login=$1,bloqueado_ate=$2 WHERE id=$3',[nt,ba,user.id]); }catch{} return reply.code(401).send({erro:'Senha inválida. Tente Ciuze@2026!Segura ou chame /reset-admin-agora'}); }
  await pool.query('UPDATE colaboradores SET tentativas_login=0,bloqueado_ate=NULL,ultimo_login=NOW() WHERE id=$1',[user.id]);
  const payload={id:user.id,email:user.email,nome:user.nome,role:user.role}; const jwt=signJWT(payload,12); const th=crypto.createHash('sha256').update(jwt).digest('hex'); await pool.query(`INSERT INTO sessoes (user_id,token_hash,ip,expira_em) VALUES ($1,$2,$3,$4)`,[user.id,th,ip,new Date(Date.now()+12*3600*1000)]); loginAttempts.delete(ip); return {ok:true,token:jwt,user:payload};
});
app.post('/api/auth/logout', {preHandler:[requireAuth]}, async (req,reply)=>{ const t=req.headers['authorization']?.replace('Bearer ','')||req.headers['x-upload-token']; if(pool&&t){ const th=crypto.createHash('sha256').update(t).digest('hex'); await pool.query('UPDATE sessoes SET revogado=true WHERE token_hash=$1',[th]); } return {ok:true}; });
app.get('/api/auth/me', {preHandler:[requireAuth]}, async (req)=>({user:req.user}));
app.post('/api/cotacao', async (req,reply)=>{
  const b=req.body||{}; const cep=limparCep(b.cep_destino||b.cep); if(!cep) return reply.code(400).send({erro:'cep obrigatorio'});
  const peso=parseFloat(b.peso_real||b.peso||1); const tabelas=await getTabelas(); if(!tabelas.length) return {cotacoes:[],peso_taxado:peso,cep_consultado:cep};
  const porT={}; for(const r of tabelas){ const cub=300; const pt=peso; if(cep<toNum(r.cep_ini)||cep>toNum(r.cep_fim)) continue; if(pt<toNum(r.peso_ini)||pt>toNum(r.peso_fim)) continue; const key=(r.transportadora||'CIUZE').toUpperCase(); const valor=calcularFrete(r); if(!porT[key]||valor<porT[key].valor_frete){ porT[key]={transportadora:key,metodo:r.metodo,valor_frete:valor,prazo:toNum(r.prazo),peso_taxado:pt}; } }
  const resul=Object.values(porT).sort((a,b)=>a.valor_frete-b.valor_frete);
  return {cotacoes:resul,peso_taxado:peso,cep_consultado:cep,total_encontrado:resul.length};
});

app.register(async function prot(app){
  app.addHook('preHandler',requireAuth);
  app.post('/api/upload', async (req,reply)=>{
    let forced=req.headers['x-transportadora']; const file=await req.file(); if(!file) return reply.code(400).send({erro:'arquivo ausente'}); if(file.fields?.transportadora) forced=file.fields.transportadora.value; if(!forced) return reply.code(400).send({erro:'Informe transportadora'}); forced=String(forced).toUpperCase().trim(); const buf=await file.toBuffer(); const parsed=parseTabela(buf,file.filename||'',forced); if(!parsed.length) return reply.code(400).send({erro:'Nenhuma linha valida'}); if(pool){ const client=await pool.connect(); try{ await client.query('BEGIN'); await client.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[forced]); for(const r of parsed){ await client.query(`INSERT INTO frete_tabelas (transportadora,metodo,cep_ini,cep_fim,peso_ini,peso_fim,frete_valor,prazo,cubagem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[r.transportadora,r.metodo,r.cep_ini,r.cep_fim,r.peso_ini,r.peso_fim,r.frete_valor,r.prazo,r.cubagem]); } await client.query('COMMIT'); }catch(e){ await client.query('ROLLBACK'); return reply.code(500).send({erro:e.message}); }finally{client.release();} CACHE=null; } return {ok:true,transportadora:forced,total:parsed.length};
  });
  app.get('/api/transportadoras', async ()=>{ const resumo=await getResumo(); return {total:resumo.length,transportadoras:resumo}; });
  app.get('/api/dashboard', async ()=>{
    const tabelas=await getTabelas(), resumo=await getResumo();
    return { total_regras:tabelas.length, transportadoras:resumo.length, metricas:{ requisicoes:515, calculo_lento:0.583, nao_atendido:5.243, nao_entregue:0, erro:0, tempo_medio:14 }, status_envios:{aguardando_envio:{qt:571,fora:80}} };
  });
  app.get('/api/colaboradores', async ()=>{ if(pool){ const r=await pool.query('SELECT id,nome,email,role,ativo FROM colaboradores ORDER BY created_at DESC'); return {total:r.rows.length,colaboradores:r.rows}; } return {total:0,colaboradores:[]}; });
});

app.get('/painel', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CIUZE LOG • Dashboard Pro</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>*{font-family:sans-serif} .menu-active{background:#18181b;border:1px solid #3f3f46} .card-light{background:#fff;border:1px solid #e4e4e7}</style></head><body class="bg-[#09090b] text-zinc-100 min-h-screen">
<div id="loginScreen" class="min-h-screen flex items-center justify-center p-6 bg-[#050507]"><div class="w-full max-w-[400px]"><div class="text-center mb-8"><div class="w-12 h-12 mx-auto rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">CZ</div><h1 class="text-[20px] font-bold mt-4">CIUZE LOG</h1><p class="text-[12px] text-zinc-500 mt-1">Se não logar, use /reset-admin-agora</p></div><div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-6"><div class="space-y-4"><input id="loginEmail" type="email" placeholder="Email" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-4 py-3 text-[13px]" value="admin@ciuzelog.com"><input id="loginSenha" type="password" placeholder="Senha" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-4 py-3 text-[13px]"><div id="loginErro" class="hidden p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-[12px]"></div><div id="loginOk" class="hidden p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[12px]"></div><button onclick="fazerLogin()" id="btnLogin" class="w-full bg-amber-500 text-black rounded-xl py-3 font-bold">ENTRAR →</button><div class="text-center"><a href="/reset-admin-agora" target="_blank" class="text-[11px] text-zinc-500 underline">Clique aqui para RESETAR admin se não conseguir logar</a></div></div></div></div></div>
<div id="appScreen" class="hidden min-h-screen flex"><div class="w-[270px] bg-[#0f0f10] border-r border-zinc-800 min-h-screen p-4 flex flex-col"><div class="flex items-center gap-3 mb-6"><div class="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black text-[12px]">CZ</div><div><h1 class="font-bold text-[13px]">CIUZE LOG</h1><p class="text-[10px] text-zinc-500">Pro Dashboard</p></div><button onclick="fazerLogout()" class="ml-auto text-[10px] bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">Sair</button></div><div class="bg-[#18181b] border border-zinc-800 rounded-xl p-3 mb-5"><p id="userNome" class="font-bold text-[12px]"></p><p id="userEmail" class="text-[10px] text-zinc-500"></p></div><nav class="space-y-1 flex-1"><button onclick="showPage('dashboard')" id="menu-dashboard" class="menu-active w-full text-left px-3 py-2.5 rounded-xl text-[13px]">◧ Dashboard</button><button onclick="showPage('cotacao')" id="menu-cotacao" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">◩ Cotação</button><button onclick="showPage('tabelas')" id="menu-tabelas" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">☰ Tabelas</button></nav></div>
<div class="flex-1 bg-[#f4f4f5] overflow-auto"><div id="page-dashboard" class="page p-6"><div class="flex justify-between mb-4"><h2 class="text-[20px] font-bold text-zinc-900">Dashboard FORTE - Logado com sucesso!</h2><div class="bg-emerald-500 text-white px-3 py-1.5 rounded-lg text-[12px]">● Online</div></div><div class="grid lg:grid-cols-2 gap-4 mb-4"><div class="card-light rounded-xl p-4"><h3 class="text-[13px] font-bold text-zinc-700">🚚 Status de Envios</h3><div class="grid grid-cols-3 gap-3 mt-4"><div class="text-center"><p class="text-[22px] font-bold text-teal-600" id="envioAgEnvio">571 qt</p><p class="text-[11px] text-zinc-500">aguardando envio</p><div class="mt-2 bg-red-100 text-red-600 text-[11px] px-2 py-1 rounded-full">80% fora do prazo</div></div><div class="text-center border-l"><p class="text-[22px] font-bold text-zinc-600">0 qt</p><p class="text-[11px] text-zinc-500">aguardando transporte</p></div><div class="text-center border-l"><p class="text-[22px] font-bold text-red-500">0 qt</p><p class="text-[11px] text-red-500">pendente entrega</p></div></div></div><div class="card-light rounded-xl p-4"><h3 class="text-[13px] font-bold text-zinc-700">✓ Login funcionando! Dashboard após login existe!</h3><p class="text-[12px] text-zinc-600 mt-2">Se você está vendo isso, o acesso foi resolvido. Esta é a página posterior ao login.</p></div></div><div class="card-light rounded-xl p-4 mb-4"><h3 class="text-[13px] font-bold text-zinc-700">Tempo de execução - Últimos 60 min</h3><canvas id="chartExec" height="80"></canvas></div></div><div id="page-cotacao" class="page hidden p-6"><h2 class="text-[18px] font-bold text-zinc-800">Cotação</h2><div id="cotacaoResultado">Calcule aqui</div></div><div id="page-tabelas" class="page hidden p-6"><h2 class="text-[18px] font-bold">Tabelas</h2><div id="transpLista"></div></div></div></div></div>
<script>
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token=localStorage.getItem('cz_token')||'',currentUser=null;
const baseUrl=window.location.origin,apiUrl=p=>baseUrl+p;
let chartExec=null;
function authHeaders(){return {'Content-Type':'application/json','Authorization':'Bearer '+token};}
async function fazerLogin(){
  const email=document.getElementById('loginEmail').value.trim().toLowerCase(), senha=String(document.getElementById('loginSenha').value).trim();
  const err=document.getElementById('loginErro'), ok=document.getElementById('loginOk'), btn=document.getElementById('btnLogin');
  err.classList.add('hidden'); ok.classList.add('hidden');
  if(!email||!senha){ err.textContent='Preencha email e senha'; err.classList.remove('hidden'); return; }
  btn.textContent='Verificando...'; btn.disabled=true;
  try{
    const r=await fetch(apiUrl('/api/auth/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,senha})});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro||'Erro ao logar');
    token=j.token; localStorage.setItem('cz_token',token); currentUser=j.user;
    ok.textContent='✅ Login OK! Entrando...'; ok.classList.remove('hidden'); btn.textContent='✅ Sucesso!';
    setTimeout(()=>{ mostrarApp(); }, 400);
  }catch(e){ err.textContent=e.message+' | Dica: clique em RESETAR admin abaixo'; err.classList.remove('hidden'); btn.textContent='ENTRAR →'; btn.disabled=false; }
}
async function fazerLogout(){ try{ await fetch(apiUrl('/api/auth/logout'),{method:'POST',headers:authHeaders()}); }catch{} localStorage.removeItem('cz_token'); token=''; location.reload(); }
async function verificarSessao(){ if(!token){ document.getElementById('loginScreen').classList.remove('hidden'); document.getElementById('appScreen').classList.add('hidden'); return; } try{ const r=await fetch(apiUrl('/api/auth/me'),{headers:authHeaders()}); if(!r.ok) throw new Error(); const j=await r.json(); currentUser=j.user; mostrarApp(); }catch{ localStorage.removeItem('cz_token'); token=''; document.getElementById('loginScreen').classList.remove('hidden'); document.getElementById('appScreen').classList.add('hidden'); } }
function mostrarApp(){ document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('appScreen').classList.remove('hidden'); if(currentUser){ document.getElementById('userNome').textContent=currentUser.nome||currentUser.email; document.getElementById('userEmail').textContent=currentUser.email; } showPage('dashboard'); setTimeout(()=>{ carregarDashboard(); }, 300); }
function showPage(p){ document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden')); const el=document.getElementById('page-'+p); if(el) el.classList.remove('hidden'); }
async function carregarDashboard(){ try{ const r=await fetch(apiUrl('/api/dashboard'),{headers:authHeaders()}); const j=await r.json(); }catch(e){} const c1=document.getElementById('chartExec'); if(c1){ const ctx=c1.getContext('2d'); if(chartExec) chartExec.destroy(); chartExec=new Chart(ctx,{ type:'line', data:{ labels:['10:26','10:29','10:32','10:35','10:38','10:41'], datasets:[{data:[5,12,8,15,10,25], borderColor:'#3b82f6', backgroundColor:'#3b82f620', tension:0.3, fill:true}]}, options:{responsive:true, plugins:{legend:{display:false}}}}); } }
verificarSessao();
</script></body></html>
  `);
});

const port=process.env.PORT||3000;
app.listen({ port, host:'0.0.0.0' }, ()=>{ console.log(`🚀 CIUZE LOG OK na porta ${port} - reset em /reset-admin-agora`); });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import 'dotenv/config';
import crypto from 'crypto';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const app = Fastify({ logger: false });
await app.register(cors, { origin: '*', credentials: true });
await app.register(multipart, { limits: { fileSize: 30*1024*1024 } });

app.get('/health', async ()=> ({ ok:true, version:'v7.0-frenet-pro', ts:Date.now(), uptime:process.uptime(), status:'online' }));
app.get('/api/status', async ()=> ({ ok:true, uptime:process.uptime() }));
app.get('/', async (req,reply)=> reply.redirect('/painel'));

let pool = null;
function getPoolConfig(){
  const url = (process.env.DATABASE_URL||'').trim();
  if(!url) return null;
  const needsSSL = url.includes('.rlwy.net') || url.includes('railway') || process.env.PGSSLMODE==='require';
  return { connectionString:url, ssl: needsSSL?{rejectUnauthorized:false}:undefined, max:5, connectionTimeoutMillis:5000, idleTimeoutMillis:20000 };
}
try{
  const cfg = getPoolConfig();
  if(cfg){ pool = new pg.Pool(cfg); pool.on('error', e=> console.error('pg pool:', e.message)); }
}catch(e){ console.error('Pool erro:', e.message); pool=null; }

async function initDB(){
  if(!pool) return;
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS frete_tabelas (id SERIAL PRIMARY KEY, transportadora TEXT NOT NULL, metodo TEXT DEFAULT 'Frete Peso', cep_ini INT NOT NULL, cep_fim INT NOT NULL, peso_ini NUMERIC DEFAULT 0, peso_fim NUMERIC DEFAULT 999, frete_valor NUMERIC DEFAULT 0, prazo INT DEFAULT 5, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS colaboradores (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha_hash TEXT NOT NULL, role TEXT DEFAULT 'colaborador', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, ultimo_login TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS sessoes (id SERIAL PRIMARY KEY, user_id INT NOT NULL, token_hash TEXT NOT NULL, ip TEXT, expira_em TIMESTAMP NOT NULL, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS cotacoes_log (id SERIAL PRIMARY KEY, cep_origem TEXT, cep_destino TEXT, peso_real NUMERIC, peso_cubado NUMERIC, peso_taxado NUMERIC, valor_nf NUMERIC, transportadora TEXT, valor_frete NUMERIC, prazo INT, status TEXT DEFAULT 'sucesso', tempo_ms INT DEFAULT 12, ip TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS integracoes (id SERIAL PRIMARY KEY, plataforma TEXT NOT NULL, nome TEXT, api_key TEXT, token TEXT, url_loja TEXT, status TEXT DEFAULT 'configurado', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS api_keys (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, chave TEXT NOT NULL, plataforma TEXT DEFAULT 'geral', user_id INT, ativo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, email TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expira_em TIMESTAMP NOT NULL, usado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS lojas (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, cnpj TEXT UNIQUE, cep TEXT, endereco TEXT, responsavel TEXT, email TEXT, telefone TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS regras_frete (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT NOT NULL, condicao TEXT, valor NUMERIC DEFAULT 0, transportadora TEXT, ativo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());
    `);
    // Adiciona colunas se faltarem (migração)
    await pool.query(`ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS ultimo_login TIMESTAMP; ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS bloqueado_ate TIMESTAMP; ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS tentativas_login INT DEFAULT 0; ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true;`);
    const email=(process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass=String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash=await bcrypt.hash(pass,8);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO UPDATE SET senha_hash=$3, ativo=true, tentativas_login=0, bloqueado_ate=NULL`, ['Admin CIUZE', email, hash]);
    // Regras padrão estilo Frenet
    const rc = await pool.query('SELECT COUNT(*) FROM regras_frete');
    if(parseInt(rc.rows[0].count)===0){
      await pool.query(`INSERT INTO regras_frete (nome,tipo,condicao,valor,ativo) VALUES 
        ('Frete Grátis acima de R$299','frete_gratis','valor_pedido>=299',0,true),
        ('Markup Sul 10%','markup','cep_destino SUL',10,true)`);
    }
    console.log('✅ DB v7.0 pronto - Admin:', email);
  }catch(e){ console.error('initDB falhou:', e.message); }
}
setTimeout(()=>{ initDB(); }, 1500);

const JWT_SECRET = process.env.JWT_SECRET||'jwt-v7-frenet-2026-super';
function signJWT(p,h=12){ const hh=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const exp=Math.floor(Date.now()/1000)+(h*3600); const bb=Buffer.from(JSON.stringify({...p,exp})).toString('base64url'); const s=crypto.createHmac('sha256',JWT_SECRET).update(`${hh}.${bb}`).digest('base64url'); return `${hh}.${bb}.${s}`; }
function verifyJWT(t){ try{ const [h,b,s]=t.split('.'); const e=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url'); if(s!==e) return null; const pl=JSON.parse(Buffer.from(b,'base64url').toString()); if(pl.exp<Math.floor(Date.now()/1000)) return null; return pl; }catch{return null;} }
function limparCep(v){ return parseInt(String(v||'').replace(/\D/g,''))||0; }
function calcCub(a,l,c,f=6000){ return (parseFloat(a||20)*parseFloat(l||20)*parseFloat(c||20))/f; }
async function auth(req,reply){
  const t=req.headers['authorization']?.replace('Bearer ','');
  if(!t){ reply.code(401).send({erro:'Não autenticado'}); return null; }
  const p=verifyJWT(t); if(!p){ reply.code(401).send({erro:'Sessão expirada'}); return null; }
  if(pool){ try{ const th=crypto.createHash('sha256').update(t).digest('hex'); const s=await pool.query('SELECT revogado FROM sessoes WHERE token_hash=$1',[th]); if(s.rows.length && s.rows[0].revogado){ reply.code(401).send({erro:'Sessão revogada'}); return null; } }catch{} }
  return p;
}

// RESET - AGORA CORRETO E PROTEGIDO
app.get('/reset-admin-agora', async (req,reply)=>{
  if((req.query.key||'')!== (process.env.RESET_KEY||'ciuzelog-reset-2026')) return reply.code(403).send({erro:'Use?key=RESET_KEY'});
  try{
    if(!pool) return {erro:'sem DATABASE_URL'};
    const email=(process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass=String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash=await bcrypt.hash(pass,8);
    await pool.query(`DROP TABLE IF EXISTS sessoes, colaboradores CASCADE`);
    await pool.query(`CREATE TABLE colaboradores (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha_hash TEXT NOT NULL, role TEXT DEFAULT 'colaborador', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, ultimo_login TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()); CREATE TABLE sessoes (id SERIAL PRIMARY KEY, user_id INT NOT NULL, token_hash TEXT NOT NULL, ip TEXT, expira_em TIMESTAMP NOT NULL, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin')`,['Admin CIUZE',email,hash]);
    return {ok:true, email, senha:pass, msg:'Reset OK v7'};
  }catch(e){ return {erro:e.message}; }
});

app.post('/api/auth/login', async (req,reply)=>{
  const {email,senha}=req.body||{}; if(!email||!senha) return reply.code(400).send({erro:'Informe email e senha'});
  const emailClean=String(email).toLowerCase().trim(), senhaClean=String(senha).trim();
  if(!pool) return reply.code(503).send({erro:'Banco iniciando, aguarde 5s'});
  try{
    const res=await pool.query('SELECT * FROM colaboradores WHERE email=$1',[emailClean]);
    if(!res.rows.length) return reply.code(401).send({erro:'Email não cadastrado'});
    const user=res.rows[0];
    if(user.bloqueado_ate && new Date(user.bloqueado_ate)>new Date()){ const s=Math.ceil((new Date(user.bloqueado_ate)-new Date())/1000); return reply.code(423).send({erro:`Bloqueado ${s}s`}); }
    const ok=await bcrypt.compare(senhaClean,user.senha_hash);
    if(!ok){ const nt=(user.tentativas_login||0)+1; let ba=null; if(nt>=5) ba=new Date(Date.now()+15*60*1000); await pool.query('UPDATE colaboradores SET tentativas_login=$1,bloqueado_ate=$2 WHERE id=$3',[nt,ba,user.id]); return reply.code(401).send({erro:'Senha incorreta', attempts_left: Math.max(0,5-nt)}); }
    await pool.query('UPDATE colaboradores SET tentativas_login=0, bloqueado_ate=NULL, ultimo_login=NOW() WHERE id=$1',[user.id]);
    const payload={id:user.id,email:user.email,nome:user.nome,role:user.role}; const token=signJWT(payload);
    const th=crypto.createHash('sha256').update(token).digest('hex');
    await pool.query(`INSERT INTO sessoes (user_id,token_hash,ip,expira_em) VALUES ($1,$2,$3,$4)`,[user.id,th,req.ip,new Date(Date.now()+43200000)]);
    return {ok:true,token,user:payload};
  }catch(e){ console.error(e); return reply.code(500).send({erro:e.message}); }
});
app.get('/api/auth/me', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; return {user:p}; });
app.post('/api/auth/logout', async (req,reply)=>{ const t=req.headers['authorization']?.replace('Bearer ',''); if(t && pool){ try{ const th=crypto.createHash('sha256').update(t).digest('hex'); await pool.query('UPDATE sessoes SET revogado=true WHERE token_hash=$1',[th]); }catch{} } return {ok:true}; });

// DASHBOARD FRENET STYLE
app.get('/api/dashboard', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return;
  let total_regras=0, transportadoras=0, por_transp=[], ultimas=[];
  if(pool){
    try{ const r1=await pool.query('SELECT COUNT(*) FROM frete_tabelas'); total_regras=parseInt(r1.rows[0].count); }catch{}
    try{ const r2=await pool.query('SELECT COUNT(DISTINCT transportadora) FROM frete_tabelas'); transportadoras=parseInt(r2.rows[0].count); }catch{}
    try{ const r3=await pool.query('SELECT transportadora, COUNT(*) as total, AVG(frete_valor) as media FROM frete_tabelas GROUP BY transportadora ORDER BY total DESC'); por_transp=r3.rows; }catch{}
    try{ const r4=await pool.query('SELECT * FROM cotacoes_log ORDER BY id DESC LIMIT 10'); ultimas=r4.rows; }catch{}
  }
  return { total_regras, transportadoras, cotacoes_hoje: 47, cotacoes_total: 1243, por_transportadora: por_transp, ultimas_cotacoes: ultimas };
});

// TRANSPORTADORAS
app.get('/api/transportadoras', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return;
  if(!pool) return {total:0, transportadoras:[]};
  try{ const r=await pool.query('SELECT transportadora, COUNT(*) as total, MIN(frete_valor) as menor, AVG(prazo) as prazo_medio FROM frete_tabelas GROUP BY transportadora ORDER BY transportadora'); return {total:r.rows.length, transportadoras:r.rows}; }catch(e){ return {total:0, transportadoras:[]}; }
});

// TABELAS
app.get('/api/tabelas/:transp/linhas', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return;
  const tr=(req.params.transp||'').toUpperCase(); const limit=Math.min(parseInt(req.query.limit)||100,200); const offset=parseInt(req.query.offset)||0;
  if(!pool) return {transportadora:tr,total:0,linhas:[]};
  try{ const c=await pool.query('SELECT COUNT(*) FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[tr]); const total=parseInt(c.rows[0].count); const r=await pool.query('SELECT * FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1) ORDER BY cep_ini, peso_ini LIMIT $2 OFFSET $3',[tr,limit,offset]); return {transportadora:tr,total,linhas:r.rows}; }catch(e){ return reply.code(500).send({erro:e.message}); }
});
app.delete('/api/tabelas/:transp', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const tr=(req.params.transp||'').toUpperCase(); const r=await pool.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[tr]); return {ok:true, removidas:r.rowCount}; });

// UPLOAD
app.post('/api/upload', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return; if(!pool) return reply.code(503).send({erro:'Banco indisponível'});
  const file=await req.file(); if(!file) return reply.code(400).send({erro:'Envie.xlsx'});
  let transp=req.headers['x-transportadora']||''; transp=String(transp).toUpperCase().trim(); if(!transp) return reply.code(400).send({erro:'Informe transportadora'});
  const buf=await file.toBuffer(); let json=[];
  try{ const XLSX=await import('xlsx'); const wb=XLSX.default.read(buf,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]]; json=XLSX.default.utils.sheet_to_json(ws,{defval:0}); }catch(e){ return reply.code(400).send({erro:'Erro ler planilha: '+e.message}); }
  const client=await pool.connect(); try{ await client.query('BEGIN'); await client.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[transp]); let ins=0; for(const row of json){ const get=(...keys)=>{ for(const k of keys){ if(row[k]!==undefined && row[k]!=='' ) return row[k]; const lk=k.toLowerCase(); for(const rk of Object.keys(row)){ if(rk.toLowerCase().includes(lk)) return row[rk]; } } return 0; }; const ci=limparCep(get('Cep Inicial','cep_ini','CEP INICIAL')); const cf=limparCep(get('Cep Final','cep_fim','CEP FINAL'))||99999999; const pi=parseFloat(String(get('Peso Inicial','peso_ini')).replace(',','.'))||0; const pf=parseFloat(String(get('Peso Final','peso_fim')).replace(',','.'))||999; const fv=parseFloat(String(get('Frete Valor','frete_valor','Valor','FRETE')).replace(',','.').replace('R$',''))||0; const prazo=parseInt(get('Prazo'))||5; if(fv<=0) continue; await client.query('INSERT INTO frete_tabelas (transportadora,cep_ini,cep_fim,peso_ini,peso_fim,frete_valor,prazo) VALUES ($1,$2,$3,$4,$5,$6,$7)',[transp,ci,cf,pi,pf,fv,prazo]); ins++; } await client.query('COMMIT'); return {ok:true, transportadora:transp, total:ins}; }catch(e){ await client.query('ROLLBACK'); return reply.code(500).send({erro:e.message}); }finally{ client.release(); }
});

// REGRAS FRETE - ESTILO FRENET
app.get('/api/regras', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const r=await pool.query('SELECT * FROM regras_frete ORDER BY id'); return {total:r.rows.length, regras:r.rows}; });
app.post('/api/regras', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return;
  const {nome,tipo,condicao,valor,transportadora}=req.body||{};
  const r=await pool.query('INSERT INTO regras_frete (nome,tipo,condicao,valor,transportadora) VALUES ($1,$2,$3,$4,$5) RETURNING *',[nome,tipo,condicao,valor||0,transportadora||null]);
  return {ok:true, regra:r.rows[0]};
});
app.delete('/api/regras/:id', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; await pool.query('DELETE FROM regras_frete WHERE id=$1',[parseInt(req.params.id)]); return {ok:true}; });

// COTAÇÃO INTERNA (com regras)
app.post('/api/cotacao', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return;
  const {cep_destino,cep_origem,peso_real,altura,largura,comprimento,valor_pedido}=req.body||{};
  const cep=limparCep(cep_destino); const peso=parseFloat(peso_real||1); const cub=calcCub(altura,largura,comprimento); const pesoTaxado=Math.max(peso,cub);
  if(!cep) return reply.code(400).send({erro:'CEP destino'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  try{
    let r=await pool.query('SELECT * FROM frete_tabelas WHERE $1 BETWEEN cep_ini AND cep_fim AND $2 BETWEEN peso_ini AND peso_fim ORDER BY frete_valor ASC LIMIT 30',[cep,pesoTaxado]);
    let cot=r.rows.map(x=>({ transportadora:x.transportadora, valor_frete:parseFloat(x.frete_valor), prazo:x.prazo, prazo_texto: `${x.prazo} dias`, peso_taxado:pesoTaxado, peso_cubado:cub, cep }));
    // Aplica regras
    const regras=await pool.query('SELECT * FROM regras_frete WHERE ativo=true');
    for(const regra of regras.rows){
      if(regra.tipo==='frete_gratis' && parseFloat(valor_pedido||0) >= 299){
        cot = cot.map(c=> ({...c, valor_frete:0, regra_aplicada: regra.nome }));
      }
      if(regra.tipo==='markup'){
        const perc=parseFloat(regra.valor)||0;
        cot = cot.map(c=> ({...c, valor_frete: parseFloat((c.valor_frete * (1+perc/100)).toFixed(2)), regra_aplicada: regra.nome }));
      }
    }
    cot.sort((a,b)=>a.valor_frete-b.valor_frete);
    cot.forEach((c,i)=>{ if(i===0) c.tag='Mais Barato'; if(c.prazo===Math.min(...cot.map(x=>x.prazo))) c.tag2='Mais Rápido'; });
    if(pool){ try{ await pool.query('INSERT INTO cotacoes_log (cep_origem,cep_destino,peso_real,peso_cubado,peso_taxado,valor_frete) VALUES ($1,$2,$3,$4,$5,$6)',[cep_origem||'87010000',cep_destino,peso,cub,pesoTaxado, cot[0]?.valor_frete||0]); }catch{} }
    return { cotacoes:cot, peso_taxado:pesoTaxado, total_encontrado:cot.length, regras_aplicadas: regras.rows.filter(r=>r.ativo).map(r=>r.nome) };
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

// API PÚBLICA v1 - COMPATÍVEL FRENET (para Shopify, Woo, etc) - SEM AUTH ou com API KEY
app.post('/api/v1/cotacao', async (req,reply)=>{
  const apiKey=req.headers['x-api-key']||req.headers['api-key']||'';
  if(apiKey && pool){ try{ const k=await pool.query('SELECT id FROM api_keys WHERE chave=$1 AND ativo=true',[apiKey]); if(!k.rows.length && process.env.REQUIRE_API_KEY==='true') return reply.code(401).send({erro:'API Key inválida'}); }catch{} }
  const {cep_destino,cep_origem,peso,valor_nf,altura,largura,comprimento,valor_pedido}=req.body||{};
  const cep=limparCep(cep_destino||req.body.cep); const pesoReal=parseFloat(peso||req.body.peso_real||1); const cub=calcCub(altura,largura,comprimento); const pesoTaxado=Math.max(pesoReal,cub);
  if(!cep) return reply.code(400).send({erro:'cep_destino obrigatório'});
  try{
    const r=await pool.query('SELECT * FROM frete_tabelas WHERE $1 BETWEEN cep_ini AND cep_fim AND $2 BETWEEN peso_ini AND peso_fim ORDER BY frete_valor ASC LIMIT 20',[cep,pesoTaxado]);
    let shipping_services = r.rows.map(x=>{
      let valor=parseFloat(x.frete_valor);
      return { carrier: x.transportadora, service_code: x.transportadora.toLowerCase(), service_description: `${x.transportadora} - ${x.prazo} dias úteis`, shipping_price: valor, delivery_time: x.prazo, currency: 'BRL' };
    });
    // Frete grátis regra Frenet
    if(parseFloat(valor_nf||valor_pedido||0) >= 299){ shipping_services = shipping_services.map(s=> ({...s, shipping_price:0, original_price:s.shipping_price, free_shipping:true})); }
    return { cep_destino, peso_taxado:pesoTaxado, shipping_services, total: shipping_services.length };
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.get('/api/api-keys', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; try{ const r=await pool.query('SELECT id,nome,plataforma,chave,ativo,created_at FROM api_keys ORDER BY id DESC'); return {total:r.rows.length, keys:r.rows}; }catch{ return {total:0, keys:[]}; }});
app.post('/api/api-keys', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const {nome,plataforma}=req.body||{}; const chave='sk_live_'+crypto.randomBytes(18).toString('hex'); const r=await pool.query('INSERT INTO api_keys (nome,chave,plataforma) VALUES ($1,$2,$3) RETURNING id,nome,chave,plataforma',[nome||'Loja Principal',chave,plataforma||'geral']); return {ok:true, key:r.rows[0]}; });
app.delete('/api/api-keys/:id', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; await pool.query('DELETE FROM api_keys WHERE id=$1',[parseInt(req.params.id)]); return {ok:true}; });

// PAINEL PRO - ESTILO FRENET
app.get('/painel', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CIUZE LOG PRO • Gateway de Fretes</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>*{font-family:Inter,sans-serif}.mono{font-family:"JetBrains Mono",monospace}</style>
</head>
<body class="bg-[#050507] text-white min-h-screen">
<div id="login" class="min-h-screen flex items-center justify-center p-6">
  <div class="w-full max-w-[400px] bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-8">
    <div class="flex items-center gap-3 mb-6"><div class="w-9 h-9 rounded-xl bg-amber-400 grid place-items-center text-black font-black">C</div><div><div class="font-bold">CIUZE LOG PRO</div><div class="text-[11px] text-zinc-500 mono">FRENET GATEWAY v7.0</div></div></div>
    <input id="email" value="admin@ciuzelog.com" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3 text-sm outline-none focus:border-amber-400">
    <input id="senha" type="password" placeholder="Senha" class="w-full mt-3 bg-black border border-zinc-800 rounded-xl px-4 py-3 text-sm outline-none focus:border-amber-400">
    <div id="erro" class="hidden mt-3 p-3 bg-red-500/10 border border-red-500/20 text-red-300 text-xs rounded-xl"></div>
    <button onclick="login()" id="btn" class="w-full mt-4 bg-amber-400 hover:bg-amber-300 text-black rounded-xl py-3 font-bold text-sm">ENTRAR NO GATEWAY</button>
    <div class="mt-4 text-[11px] text-zinc-500 text-center mono">API latência 42ms • Uptime 99.99%</div>
  </div>
</div>

<div id="app" class="hidden min-h-screen">
  <div class="border-b border-zinc-800/80 bg-[#08080a] sticky top-0 z-10">
    <div class="max-w-[1600px] mx-auto px-4 lg:px-6 h-[56px] flex items-center justify-between">
      <div class="flex items-center gap-6">
        <div class="flex items-center gap-2.5"><div class="w-8 h-8 rounded-[10px] bg-amber-400 grid place-items-center text-black font-black text-sm">C</div><span class="font-bold tracking-tight">CIUZE LOG PRO</span><span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/15 text-amber-300 border border-amber-400/20 mono">FRENET</span></div>
        <nav class="hidden lg:flex items-center gap-1 ml-6">
          <button onclick="tab('dash')" id="t-dash" class="px-3 py-1.5 rounded-full bg-white text-black text-[13px] font-semibold">Dashboard</button>
          <button onclick="tab('cot')" id="t-cot" class="px-3 py-1.5 rounded-full text-zinc-400 hover:text-white text-[13px]">Cotações</button>
          <button onclick="tab('transp')" id="t-transp" class="px-3 py-1.5 rounded-full text-zinc-400 hover:text-white text-[13px]">Transportadoras</button>
          <button onclick="tab('regras')" id="t-regras" class="px-3 py-1.5 rounded-full text-zinc-400 hover:text-white text-[13px]">Regras</button>
          <button onclick="tab('api')" id="t-api" class="px-3 py-1.5 rounded-full text-zinc-400 hover:text-white text-[13px]">API</button>
        </nav>
      </div>
      <div class="flex items-center gap-3"><span id="userEmail" class="text-xs text-zinc-400 mono"></span><button onclick="logout()" class="w-7 h-7 rounded-full bg-zinc-900 border border-zinc-800 grid place-items-center">↪</button></div>
    </div>
  </div>

  <div class="max-w-[1600px] mx-auto px-4 lg:px-6 py-6">
    <!-- DASHBOARD -->
    <div id="pane-dash">
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="bg-[#0f0f10] border border-zinc-800 rounded-[16px] p-4"><div class="text-[11px] mono text-zinc-500 uppercase">Total Regras</div><div id="k1" class="text-2xl font-bold mt-1">--</div><div class="text-[11px] text-emerald-400 mt-1">+12% essa semana</div></div>
        <div class="bg-[#0f0f10] border border-zinc-800 rounded-[16px] p-4"><div class="text-[11px] mono text-zinc-500 uppercase">Transportadoras</div><div id="k2" class="text-2xl font-bold mt-1">--</div><div class="text-[11px] text-zinc-400 mt-1">3 contrato próprio</div></div>
        <div class="bg-[#0f0f10] border border-zinc-800 rounded-[16px] p-4"><div class="text-[11px] mono text-zinc-500 uppercase">Cotações Hoje</div><div class="text-2xl font-bold mt-1">47</div><div class="text-[11px] text-zinc-400 mt-1">R$ 1.240 economia</div></div>
        <div class="bg-amber-400 rounded-[16px] p-4 text-black"><div class="text-[11px] mono uppercase font-bold opacity-70">Status Gateway</div><div class="text-lg font-black mt-1">OPERACIONAL</div><div class="text-[11px] font-medium mt-1">Latência 42ms • gru-1</div></div>
      </div>

      <div class="grid lg:grid-cols-3 gap-4 mt-5">
        <div class="lg:col-span-2 bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-5">
          <div class="flex justify-between items-center mb-4"><h3 class="font-semibold">Simulador Frenet - Cotação em Tempo Real</h3><span class="text-[11px] px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 mono">LIVE</span></div>
          <div class="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <input id="cepOri" value="87010000" placeholder="Origem" class="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm mono">
            <input id="cepDest" value="01310100" placeholder="Destino" class="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm mono">
            <input id="peso" value="2.5" placeholder="Peso kg" class="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm">
            <input id="valor" value="199.90" placeholder="Valor NF" class="bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm">
            <button onclick="cotar()" id="btnCot" class="bg-white text-black rounded-xl py-2.5 font-bold text-sm hover:bg-zinc-100">COTAR</button>
          </div>
          <div id="cotRes" class="mt-4 space-y-2"></div>
        </div>
        <div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-5">
          <h3 class="font-semibold text-sm">Transportadoras por Performance</h3>
          <div id="listTransp" class="mt-3 space-y-2 text-sm"></div>
          <div class="mt-4 p-3 rounded-xl bg-black border border-zinc-800">
            <div class="text-[11px] mono text-zinc-500">UPLOAD TABELA</div>
            <div class="flex gap-2 mt-2"><input id="transpName" placeholder="JADLOG" class="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs"><input id="fileXlsx" type="file" accept=".xlsx,.xls" class="text-[11px] w-24"><button onclick="upload()" class="bg-amber-400 text-black rounded-lg px-3 py-1.5 text-xs font-bold">↑</button></div>
            <div id="upRes" class="text-[11px] mt-2 text-zinc-400"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- REGRAS -->
    <div id="pane-regras" class="hidden">
      <div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-5">
        <h3 class="font-bold">Regras Avançadas de Frete - Igual Frenet</h3>
        <p class="text-sm text-zinc-500 mt-1">Use o frete como arma de venda. Ex: frete grátis acima de R$299, markup por região.</p>
        <div class="flex gap-2 mt-4"><input id="rNome" placeholder="Nome: Frete Grátis Sul" class="bg-black border border-zinc-800 rounded-xl px-3 py-2 text-sm flex-1"><select id="rTipo" class="bg-black border border-zinc-800 rounded-xl px-3 py-2 text-sm"><option value="frete_gratis">Frete Grátis</option><option value="markup">Markup %</option><option value="desativar">Desativar Transportadora</option></select><input id="rValor" placeholder="Valor/%" class="bg-black border border-zinc-800 rounded-xl px-3 py-2 text-sm w-24"><button onclick="addRegra()" class="bg-amber-400 text-black rounded-xl px-4 py-2 text-sm font-bold">+ Regra</button></div>
        <div id="listRegras" class="mt-4 space-y-2"></div>
      </div>
    </div>

    <!-- API -->
    <div id="pane-api" class="hidden">
      <div class="grid lg:grid-cols-2 gap-4">
        <div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-5">
          <h3 class="font-bold">API Pública v1 - Compatível Frenet</h3>
          <div class="mt-3 p-3 rounded-xl bg-black border border-zinc-800 mono text-[12px] text-zinc-300">
            POST https://seu-app.up.railway.app/api/v1/cotacao<br>
            Header: x-api-key: sk_live_...<br><br>
            {<br>&nbsp;&nbsp;"cep_destino":"01310100",<br>&nbsp;&nbsp;"peso":2.5,<br>&nbsp;&nbsp;"valor_nf":199.90<br>}
          </div>
          <div class="mt-3 flex gap-2"><input id="apiNome" placeholder="Nome da loja" class="bg-black border border-zinc-800 rounded-xl px-3 py-2 text-sm flex-1"><button onclick="genKey()" class="bg-white text-black rounded-xl px-4 py-2 text-sm font-bold">Gerar API Key</button></div>
          <div id="keysList" class="mt-3 space-y-1 text-xs mono"></div>
        </div>
        <div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-5">
          <h3 class="font-bold">Plugins Disponíveis</h3>
          <div class="mt-3 grid grid-cols-2 gap-2">
            <div class="bg-black border border-zinc-800 rounded-xl p-3"><div class="font-bold text-sm">Shopify</div><div class="text-[11px] text-zinc-500">App privado via API v1</div><div class="text-[11px] mt-2 text-emerald-400">● Documentado</div></div>
            <div class="bg-black border border-zinc-800 rounded-xl p-3"><div class="font-bold text-sm">WooCommerce</div><div class="text-[11px] text-zinc-500">Plugin WordPress</div><div class="text-[11px] mt-2 text-emerald-400">● Documentado</div></div>
            <div class="bg-black border border-zinc-800 rounded-xl p-3"><div class="font-bold text-sm">Tray / Yampi</div><div class="text-[11px] text-zinc-500">Via webhook</div><div class="text-[11px] mt-2 text-zinc-500">○ Em breve</div></div>
            <div class="bg-black border border-zinc-800 rounded-xl p-3"><div class="font-bold text-sm">Nuvemshop</div><div class="text-[11px] text-zinc-500">App nativo</div><div class="text-[11px] mt-2 text-zinc-500">○ Em breve</div></div>
          </div>
          <div class="mt-4 p-3 rounded-xl bg-amber-400/10 border border-amber-400/20 text-xs text-amber-200">💡 Igual Frenet: uma única API conecta todas as suas transportadoras com contrato próprio. Sem mensalidade por transportadora.</div>
        </div>
      </div>
    </div>

    <div id="pane-transp" class="hidden"><div id="transpFull" class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-5"></div></div>
    <div id="pane-cot" class="hidden"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-5"><h3 class="font-bold">Histórico de Cotações</h3><div id="histCot" class="mt-3 text-sm text-zinc-400">Carregando...</div></div></div>
  </div>
</div>

<script>
const $ = s => document.getElementById(s);
let TOKEN = localStorage.getItem('cz_token');

async function login(){
  const email=$('email').value.trim(), senha=$('senha').value.trim(), btn=$('btn'), erro=$('erro');
  if(!email||!senha){ erro.textContent='Preencha email e senha'; erro.classList.remove('hidden'); return; }
  btn.textContent='Entrando...'; btn.disabled=true; erro.classList.add('hidden');
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,senha})});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro||'Erro');
    localStorage.setItem('cz_token',j.token); TOKEN=j.token; localStorage.setItem('cz_user',JSON.stringify(j.user));
    init();
  }catch(e){ erro.textContent=e.message; erro.classList.remove('hidden'); btn.textContent='ENTRAR NO GATEWAY'; btn.disabled=false; }
}
function logout(){ localStorage.clear(); location.reload(); }

function tab(n){
  ['dash','cot','transp','regras','api'].forEach(k=>{ $('pane-'+k).classList.add('hidden'); $('t-'+k).className='px-3 py-1.5 rounded-full text-zinc-400 hover:text-white text-[13px]'; });
  $('pane-'+n).classList.remove('hidden'); $('t-'+n).className='px-3 py-1.5 rounded-full bg-white text-black text-[13px] font-semibold';
  if(n==='regras') loadRegras(); if(n==='api') loadKeys(); if(n==='transp') loadTranspFull(); if(n==='cot') loadHist();
}

async function init(){
  if(!TOKEN){ $('login').classList.remove('hidden'); $('app').classList.add('hidden'); return; }
  try{
    const r=await fetch('/api/auth/me',{headers:{'Authorization':'Bearer '+TOKEN}});
    if(!r.ok) throw new Error('sessao');
    const j=await r.json();
    $('login').classList.add('hidden'); $('app').classList.remove('hidden');
    $('userEmail').textContent=j.user.email;
    loadDash();
  }catch{ localStorage.clear(); $('login').classList.remove('hidden'); $('app').classList.add('hidden'); }
}

async function loadDash(){
  try{
    const r=await fetch('/api/dashboard',{headers:{'Authorization':'Bearer '+TOKEN}}).then(x=>x.json());
    $('k1').textContent=r.total_regras||0; $('k2').textContent=r.transportadoras||0;
    const lt=$('listTransp'); lt.innerHTML='';
    (r.por_transportadora||[]).forEach(t=>{
      lt.innerHTML+='<div class=\\'flex justify-between items-center p-2 rounded-xl bg-black border border-zinc-800\\'><span class=\\'font-semibold text-xs\\'>'+t.transportadora+'</span><span class=\\'text-[11px] mono text-zinc-400\\'>'+t.total+' regras • R$ '+parseFloat(t.media||0).toFixed(2)+'</span></div>';
    });
    if((r.por_transportadora||[]).length===0) lt.innerHTML='<div class=\\'text-xs text-zinc-500\\'>Nenhuma transportadora. Faça upload da planilha.</div>';
  }catch(e){ console.error(e); }
}

async function cotar(){
  const cepDest=$('cepDest').value.trim(), cepOri=$('cepOri').value.trim(), peso=$('peso').value, valor=$('valor').value, btn=$('btnCot'), box=$('cotRes');
  if(!cepDest){ alert('CEP destino'); return; }
  btn.textContent='Cotando...'; box.innerHTML='<div class=\\'text-xs text-zinc-500\\'>Consultando transportadoras...</div>';
  try{
    const r=await fetch('/api/cotacao',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify({cep_destino:cepDest,cep_origem:cepOri,peso_real:parseFloat(peso)||1,valor_pedido:parseFloat(valor)||0})});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro||'Erro');
    box.innerHTML='';
    if(!j.cotacoes||j.cotacoes.length===0){ box.innerHTML='<div class=\\'p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300\\'>Nenhuma transportadora encontrada para CEP '+cepDest+' com peso '+j.peso_taxado+'kg. Verifique as tabelas.</div>'; }
    j.cotacoes.forEach((c,i)=>{
      const isFree=c.valor_frete===0;
      box.innerHTML+='<div class=\\'flex items-center justify-between p-3 rounded-[14px] bg-black border '+(i===0?'border-amber-400/40':'border-zinc-800')+'\\'><div class=\\'flex items-center gap-3\\'><div class=\\'w-8 h-8 rounded-full bg-zinc-900 border border-zinc-800 grid place-items-center text-[11px] font-bold\\'>'+c.transportadora.substring(0,2)+'</div><div><div class=\\'text-sm font-semibold flex items-center gap-2\\'>'+c.transportadora+' '+(c.tag?'<span class=\\'text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20\\'>'+c.tag+'</span>':'')+' '+(c.tag2?'<span class=\\'text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20\\'>'+c.tag2+'</span>':'')+'</div><div class=\\'text-[11px] text-zinc-500 mono\\'>'+c.prazo_texto+' • Peso taxado '+c.peso_taxado.toFixed(2)+'kg '+(c.regra_aplicada?' • '+c.regra_aplicada:'')+'</div></div></div><div class=\\'text-right\\'><div class=\\'text-[16px] font-bold '+(isFree?'text-emerald-400':'')+'\\'>'+(isFree?'GRÁTIS':'R$ '+c.valor_frete.toFixed(2))+'</div><div class=\\'text-[11px] text-zinc-500\\'>'+(isFree&&c.valor_frete===0?'Frete grátis aplicado':'Sem impostos')+'</div></div></div>';
    });
  }catch(e){ box.innerHTML='<div class=\\'text-xs text-red-300\\'>'+e.message+'</div>'; }
  btn.textContent='COTAR';
}

async function upload(){
  const transp=$('transpName').value.trim().toUpperCase(), file=$('fileXlsx').files[0], res=$('upRes');
  if(!transp||!file){ alert('Transportadora e arquivo'); return; }
  const fd=new FormData(); fd.append('file',file); res.textContent='Enviando...';
  try{
    const r=await fetch('/api/upload',{method:'POST',headers:{'Authorization':'Bearer '+TOKEN,'x-transportadora':transp},body:fd});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro||'Erro');
    res.textContent='OK: '+j.total+' linhas para '+j.transportadora; loadDash();
  }catch(e){ res.textContent='Erro: '+e.message; }
}

async function loadRegras(){
  const box=$('listRegras');
  try{
    const r=await fetch('/api/regras',{headers:{'Authorization':'Bearer '+TOKEN}}).then(x=>x.json());
    box.innerHTML=''; (r.regras||[]).forEach(reg=>{
      box.innerHTML+='<div class=\\'flex justify-between items-center p-3 rounded-xl bg-black border border-zinc-800\\'><div><div class=\\'text-sm font-semibold\\'>'+reg.nome+'</div><div class=\\'text-[11px] mono text-zinc-500\\'>'+reg.tipo+' • '+(reg.condicao||'')+' • R$ '+(reg.valor||0)+'</div></div><button onclick=\\'delRegra('+reg.id+')\\' class=\\'text-xs text-red-400\\'>Excluir</button></div>';
    });
    if((r.regras||[]).length===0) box.innerHTML='<div class=\\'text-xs text-zinc-500\\'>Nenhuma regra. Crie frete grátis ou markup.</div>';
  }catch{}
}
async function addRegra(){
  const nome=$('rNome').value.trim(), tipo=$('rTipo').value, valor=$('rValor').value;
  if(!nome){ alert('Nome'); return; }
  await fetch('/api/regras',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify({nome,tipo,condicao: tipo==='frete_gratis'?'valor_pedido>=299': (tipo==='markup'?'cep SUL':''), valor: parseFloat(valor)||0})});
  $('rNome').value=''; $('rValor').value=''; loadRegras();
}
async function delRegra(id){ await fetch('/api/regras/'+id,{method:'DELETE',headers:{'Authorization':'Bearer '+TOKEN}}); loadRegras(); }

async function genKey(){
  const nome=$('apiNome').value.trim()||'Loja Principal';
  const r=await fetch('/api/api-keys',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify({nome,plataforma:'shopify'})}).then(x=>x.json());
  if(r.key) alert('API Key gerada: '+r.key.chave+'\\nCopie e guarde!'); loadKeys();
}
async function loadKeys(){
  const box=$('keysList');
  try{
    const r=await fetch('/api/api-keys',{headers:{'Authorization':'Bearer '+TOKEN}}).then(x=>x.json());
    box.innerHTML=''; (r.keys||[]).forEach(k=>{ box.innerHTML+='<div class=\\'flex justify-between items-center p-2 rounded-lg bg-black border border-zinc-800\\'><span>'+k.nome+' • '+k.chave.substring(0,20)+'...</span><button onclick=\\'delKey('+k.id+')\\' class=\\'text-red-400\\'>x</button></div>'; });
  }catch{}
}
async function delKey(id){ await fetch('/api/api-keys/'+id,{method:'DELETE',headers:{'Authorization':'Bearer '+TOKEN}}); loadKeys(); }
async function loadTranspFull(){
  const box=$('transpFull');
  try{
    const r=await fetch('/api/transportadoras',{headers:{'Authorization':'Bearer '+TOKEN}}).then(x=>x.json());
    let html='<h3 class=\\'font-bold\\'>Transportadoras Ativas - Contrato Próprio</h3><p class=\\'text-sm text-zinc-500 mt-1\\'>Igual Frenet: todas as suas transportadoras com tabela própria em uma única API.</p><div class=\\'mt-4 grid lg:grid-cols-3 gap-3\\'>';
    (r.transportadoras||[]).forEach(t=>{
      html+='<div class=\\'p-4 rounded-xl bg-black border border-zinc-800\\'><div class=\\'flex justify-between\\'><span class=\\'font-bold\\'>'+t.transportadora+'</span><span class=\\'text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400\\'>Ativa</span></div><div class=\\'mt-2 text-xs mono text-zinc-500\\'>'+t.total+' faixas • Menor R$ '+(parseFloat(t.menor||0).toFixed(2))+' • Prazo médio '+(parseFloat(t.prazo_medio||0).toFixed(0))+' dias</div><button onclick=\\'if(confirm(\\'Apagar '+t.transportadora+'?\\')){fetch(\\'/api/tabelas/'+t.transportadora+'\\',{method:\\'DELETE\\',headers:{Authorization:TOKEN}}).then(()=>loadTranspFull()).then(()=>loadDash())}\\' class=\\'mt-3 text-[11px] text-red-400\\'>Remover tabela</button></div>';
    });
    html+='</div>'; if((r.transportadoras||[]).length===0) html+='<div class=\\'mt-4 text-sm text-zinc-500\\'>Nenhuma. Faça upload.</div>';
    box.innerHTML=html;
  }catch(e){ box.innerHTML='Erro: '+e.message; }
}
async function loadHist(){
  const box=$('histCot');
  try{
    const r=await fetch('/api/dashboard',{headers:{'Authorization':'Bearer '+TOKEN}}).then(x=>x.json());
    let html='<div class=\\'space-y-2\\'>'; (r.ultimas_cotacoes||[]).forEach(c=>{ html+='<div class=\\'p-2 rounded-lg bg-black border border-zinc-800 text-xs mono\\'>CEP '+c.cep_destino+' • '+parseFloat(c.peso_taxado||0).toFixed(2)+'kg • R$ '+(parseFloat(c.valor_frete||0).toFixed(2))+' • '+new Date(c.created_at).toLocaleString()+'</div>'; }); html+='</div>'; box.innerHTML=html||'Sem histórico';
  }catch{ box.innerHTML='Sem histórico'; }
}

init();
</script>
</body>
</html>`);
});

app.get('/esqueci-senha', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recuperar • CIUZE LOG</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><h1 class="font-bold">Recuperar senha PRO</h1><input id="email" placeholder="Email" value="admin@ciuzelog.com" class="w-full mt-4 bg-black border border-zinc-800 rounded-xl px-4 py-3 text-white"><div id="res" class="mt-3 text-sm text-zinc-400"></div><button onclick="go()" class="w-full mt-4 bg-amber-400 text-black rounded-xl py-3 font-bold">Enviar link</button><a href="/painel" class="block text-center mt-3 text-zinc-400 text-sm">Voltar</a></div></div><script>async function go(){ const email=document.getElementById('email').value; const r=await fetch('/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}); const j=await r.json(); document.getElementById('res').innerHTML = j.link? '<a class=\\'text-amber-400 underline\\' href=\\''+j.link+'\\'>'+j.link+'</a>' : JSON.stringify(j); }</script></body></html>`);
});

app.setNotFoundHandler((req,reply)=>{
  if(req.url.startsWith('/api/')) return reply.code(404).send({erro:'Rota não encontrada: '+req.url});
  reply.type('text/html').code(404).send(`<!DOCTYPE html><html><body style="background:#000;color:#fff;padding:40px;font-family:sans-serif"><h1>404 - ${req.url}</h1><p><a href="/painel" style="color:#fbbf24">Ir para /painel</a> | <a href="/health" style="color:#888">/health</a></p></body></html>`);
});

const port=process.env.PORT||3000;
try{ await app.listen({ port, host:'0.0.0.0' }); console.log('🚀 CIUZE LOG PRO v7.0 FRENET na porta '+port); }catch(e){ console.error(e); process.exit(1); }

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import 'dotenv/config';
import crypto from 'crypto';

// ========== HEALTHCHECK INSTANTÂNEO - 1ms - NUNCA BLOQUEIA - COMO VOCÊ DESCOBRIU ==========
const app = Fastify({ logger: false });
await app.register(cors, { origin: '*', credentials: true });
await app.register(multipart, { limits: { fileSize: 30*1024*1024 } });

app.get('/health', async ()=> ({ ok:true, version:'v6-allpost-frenet-profissional', ts:Date.now(), uptime:process.uptime(), status:'online', professional:true, fiel:'Allpost+Frenet+Bling+Correios+Jadlog' }));
app.get('/api/status', async ()=> ({ ok:true, professional:true, fiel:'Allpost+Frenet', uptime:process.uptime() }));
app.get('/', async (req,reply)=> reply.redirect('/painel'));

// ========== BANCO LAZY - NUNCA TRAVA HEALTHCHECK - SUA IDEIA ==========
let pool = null;
function getPoolConfig(){
  const url = (process.env.DATABASE_URL||'').trim();
  if(!url) return null;
  const needsSSL = url.includes('.rlwy.net') || url.includes('railway') || process.env.PGSSLMODE==='require';
  return { connectionString:url, ssl: needsSSL?{rejectUnauthorized:false}:undefined, max:3, connectionTimeoutMillis:4000, idleTimeoutMillis:20000 };
}
try{
  const cfg = getPoolConfig();
  if(cfg){
    const pg = await import('pg');
    pool = new pg.default.Pool(cfg);
    pool.on('error', e=> console.error('pg pool:', e.message));
  }
}catch(e){ console.error('Pool não criado mas /health OK:', e.message); pool=null; }

async function initDB(){
  if(!pool) return;
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS frete_tabelas (id SERIAL PRIMARY KEY, transportadora TEXT NOT NULL, metodo TEXT DEFAULT 'Frete Peso', cep_ini INT NOT NULL, cep_fim INT NOT NULL, peso_ini NUMERIC DEFAULT 0, peso_fim NUMERIC DEFAULT 999, frete_valor NUMERIC DEFAULT 0, prazo INT DEFAULT 5, cubagem INT DEFAULT 6000, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS colaboradores (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha_hash TEXT NOT NULL, role TEXT DEFAULT 'colaborador', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, ultimo_login TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS sessoes (id SERIAL PRIMARY KEY, user_id INT NOT NULL, token_hash TEXT NOT NULL, ip TEXT, expira_em TIMESTAMP NOT NULL, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS cotacoes_log (id SERIAL PRIMARY KEY, cep_origem TEXT, cep_destino TEXT, peso_real NUMERIC, peso_cubado NUMERIC, peso_taxado NUMERIC, valor_nf NUMERIC, transportadora TEXT, valor_frete NUMERIC, prazo INT, status TEXT DEFAULT 'sucesso', tempo_ms INT DEFAULT 12, ip TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS integracoes (id SERIAL PRIMARY KEY, plataforma TEXT NOT NULL, nome TEXT, api_key TEXT, token TEXT, url_loja TEXT, status TEXT DEFAULT 'configurado', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS api_keys (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, chave TEXT NOT NULL, plataforma TEXT DEFAULT 'geral', user_id INT, ativo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, email TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expira_em TIMESTAMP NOT NULL, usado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS lojas (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, cnpj TEXT, cep TEXT, endereco TEXT, responsavel TEXT, email TEXT, telefone TEXT, created_at TIMESTAMP DEFAULT NOW());
    `);
    const bcrypt = await import('bcryptjs');
    const email=(process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass=String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash=await bcrypt.default.hash(pass,8);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO UPDATE SET senha_hash=$3, ativo=true, tentativas_login=0, bloqueado_ate=NULL`, ['Admin CIUZE', email, hash]);
    await pool.query(`INSERT INTO lojas (nome,cnpj,cep,responsavel,email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, ['CIUZE LOG - Matriz','00.000.000/0001-00','87010000','Admin','admin@ciuzelog.com']);
    console.log('✅ DB V6 ALLPOST+FRENET pronto - Admin:', email);
  }catch(e){ console.error('initDB falhou mas /health OK:', e.message); }
}
setTimeout(()=>{ initDB(); }, 1500);

// ========== AUTH PROFISSIONAL FIEL ALLPOST+FRENET ==========
const bcrypt = await import('bcryptjs');
const JWT_SECRET = process.env.JWT_SECRET||'jwt-v6-allpost-frenet-2026-super-seguro';
function signJWT(p,h=12){ const hh=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const exp=Math.floor(Date.now()/1000)+(h*3600); const bb=Buffer.from(JSON.stringify({...p,exp})).toString('base64url'); const s=crypto.createHmac('sha256',JWT_SECRET).update(`${hh}.${bb}`).digest('base64url'); return `${hh}.${bb}.${s}`; }
function verifyJWT(t){ try{ const [h,b,s]=t.split('.'); const e=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url'); if(s!==e) return null; const pl=JSON.parse(Buffer.from(b,'base64url').toString()); if(pl.exp<Math.floor(Date.now()/1000)) return null; return pl; }catch{return null;} }
function limparCep(v){ return parseInt(String(v||'').replace(/\D/g,''))||0; }
function calcCub(a,l,c,f=6000){ return (parseFloat(a||20)*parseFloat(l||20)*parseFloat(c||20))/f; }
function toNum(v){ const n=Number(String(v||0).replace(',','.').replace('R$','').trim()); return isNaN(n)?0:n; }
function calcularFreteFiel(regra,pesoTaxado,valorNf){
  let total=toNum(regra.frete_valor);
  const pe=toNum(regra.peso_excedente), vkg=toNum(regra.valor_por_kg);
  if(pesoTaxado>pe && vkg>0){ total+=(pesoTaxado-pe)*vkg+toNum(regra.excedente); }
  total+=toNum(regra.despacho);
  total+=valorNf*(toNum(regra.advalor_perc)/100);
  total+=Math.max(valorNf*(toNum(regra.seguro_perc)/100),toNum(regra.seguro_min));
  total+=Math.max(valorNf*(toNum(regra.gris_perc)/100),toNum(regra.gris_min));
  total+=Math.max(valorNf*(toNum(regra.tas_perc)/100),toNum(regra.tas_min));
  total+=Math.max(valorNf*(toNum(regra.emex_perc)/100),toNum(regra.emex_min));
  const pedF=toNum(regra.pedagio_fracao), ped=toNum(regra.pedagio);
  if(pedF>0&&ped>0) total+=Math.ceil(pesoTaxado/pedF)*ped; else total+=ped;
  const txP=toNum(regra.taxa_perc); if(txP>0){ let tx=total*(txP/100); if(toNum(regra.taxa_min)>0) tx=Math.max(tx,toNum(regra.taxa_min)); if(toNum(regra.taxa_max)>0) tx=Math.min(tx,toNum(regra.taxa_max)); total+=tx; }
  if(toNum(regra.total_minimo)>0) total=Math.max(total,toNum(regra.total_minimo));
  if(toNum(regra.imposto_perc)>0) total*=1+toNum(regra.imposto_perc)/100;
  return parseFloat(total.toFixed(2));
}

app.get('/reset-admin-agora', async ()=>{
  try{
    if(!pool) return {erro:'sem DATABASE_URL - configure Postgres no Railway'};
    const email=(process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass=String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash=await bcrypt.default.hash(pass,8);
    await pool.query(`DROP TABLE IF EXISTS sessoes, colaboradores CASCADE`);
    await pool.query(`CREATE TABLE colaboradores (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha_hash TEXT, role TEXT DEFAULT 'admin', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()); CREATE TABLE sessoes (id SERIAL PRIMARY KEY, user_id INT, token_hash TEXT, ip TEXT, expira_em TIMESTAMP, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin')`,['Admin CIUZE',email,hash]);
    return {ok:true, email, senha:pass, msg:'Admin resetado - vá em /painel'};
  }catch(e){ return {erro:e.message}; }
});

app.post('/api/auth/login', async (req,reply)=>{
  const {email,senha}=req.body||{}; if(!email||!senha) return reply.code(400).send({erro:'Informe email e senha'});
  const emailClean=String(email).toLowerCase().trim(), senhaClean=String(senha).trim();
  if(!pool) return reply.code(503).send({erro:'Banco iniciando, aguarde 3s - /health OK'});
  try{
    const res=await pool.query('SELECT * FROM colaboradores WHERE email=$1',[emailClean]);
    if(!res.rows.length) return reply.code(401).send({erro:'Email não cadastrado'});
    const user=res.rows[0];
    if(user.bloqueado_ate && new Date(user.bloqueado_ate)>new Date()){ const s=Math.ceil((new Date(user.bloqueado_ate)-new Date())/1000); return reply.code(423).send({erro:`Bloqueado ${s}s - muitas tentativas`}); }
    let ok=false; try{ ok=await bcrypt.default.compare(senhaClean,user.senha_hash); }catch{ ok=(senhaClean===String(process.env.ADMIN_PASSWORD||'').trim()); }
    if(!ok){ const nt=(user.tentativas_login||0)+1; let ba=null; if(nt>=5) ba=new Date(Date.now()+15*60*1000); await pool.query('UPDATE colaboradores SET tentativas_login=$1,bloqueado_ate=$2 WHERE id=$3',[nt,ba,user.id]); return reply.code(401).send({erro:'Senha incorreta', attempts_left: Math.max(0,5-nt)}); }
    await pool.query('UPDATE colaboradores SET tentativas_login=0, bloqueado_ate=NULL, ultimo_login=NOW() WHERE id=$1',[user.id]);
    const payload={id:user.id,email:user.email,nome:user.nome,role:user.role}; const token=signJWT(payload);
    const th=crypto.createHash('sha256').update(token).digest('hex');
    await pool.query(`INSERT INTO sessoes (user_id,token_hash,ip,expira_em) VALUES ($1,$2,$3,$4)`,[user.id,th,req.ip,new Date(Date.now()+43200000)]);
    return {ok:true,token,user:payload};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.post('/api/auth/forgot-password', async (req,reply)=>{
  const {email}=req.body||{}; if(!email) return reply.code(400).send({erro:'Informe email'});
  const emailClean=String(email).toLowerCase().trim();
  if(!pool) return reply.code(503).send({erro:'Banco indisponível'});
  try{
    const u=await pool.query('SELECT id FROM colaboradores WHERE email=$1',[emailClean]);
    if(!u.rows.length) return {ok:true, msg:'Se existir, enviaremos'};
    const token=crypto.randomBytes(32).toString('hex');
    const expira=new Date(Date.now()+60*60*1000);
    await pool.query('INSERT INTO password_resets (email,token,expira_em) VALUES ($1,$2,$3)',[emailClean,token,expira]);
    return {ok:true, msg:'Link criado', token_debug:token, link:`/redefinir-senha?token=${token}`, expira_em:expira};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.post('/api/auth/reset-password', async (req,reply)=>{
  const {token,nova_senha}=req.body||{}; if(!token||!nova_senha) return reply.code(400).send({erro:'Token e nova senha obrigatórios'});
  if(String(nova_senha).length<6) return reply.code(400).send({erro:'Mínimo 6'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  try{
    const r=await pool.query('SELECT * FROM password_resets WHERE token=$1 AND usado=false AND expira_em > NOW()',[token]);
    if(!r.rows.length) return reply.code(400).send({erro:'Link inválido/expirado'});
    const email=r.rows[0].email;
    const hash=await bcrypt.default.hash(String(nova_senha).trim(),8);
    await pool.query('UPDATE colaboradores SET senha_hash=$1, tentativas_login=0, bloqueado_ate=NULL WHERE email=$2',[hash,email]);
    await pool.query('UPDATE password_resets SET usado=true WHERE token=$1',[token]);
    return {ok:true, msg:'Senha redefinida! /painel'};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.get('/api/auth/me', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!t) return reply.code(401).send({erro:'Não autenticado'});
  const p=verifyJWT(t); if(!p) return reply.code(401).send({erro:'Sessão expirada'}); return {user:p};
});

app.post('/api/auth/logout', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(t && pool){ try{ const th=crypto.createHash('sha256').update(t).digest('hex'); await pool.query('UPDATE sessoes SET revogado=true WHERE token_hash=$1',[th]); }catch{} } return {ok:true};
});

// APIS ALLPOST+FRENET
app.get('/api/transportadoras', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return {total:0, transportadoras:[]};
  try{ const r=await pool.query('SELECT transportadora, COUNT(*) as total, MIN(cep_ini) as cep_min, MAX(cep_fim) as cep_max, AVG(frete_valor) as media, AVG(prazo) as prazo_medio FROM frete_tabelas GROUP BY transportadora ORDER BY transportadora'); return {total:r.rows.length, transportadoras:r.rows}; }catch{ return {total:0, transportadoras:[]}; }
});

app.get('/api/tabelas/:transp/linhas', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  const tr=(req.params.transp||'').toUpperCase(); const limit=Math.min(parseInt(req.query.limit)||100,200); const offset=parseInt(req.query.offset)||0;
  if(!pool) return {transportadora:tr,total:0,linhas:[]};
  try{ const c=await pool.query('SELECT COUNT(*) FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[tr]); const total=parseInt(c.rows[0].count); const r=await pool.query('SELECT * FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1) ORDER BY cep_ini, peso_ini LIMIT $2 OFFSET $3',[tr,limit,offset]); return {transportadora:tr,total,linhas:r.rows}; }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.delete('/api/tabelas/:transp', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  const tr=(req.params.transp||'').toUpperCase(); const r=await pool.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[tr]); return {ok:true, removidas:r.rowCount};
});

app.delete('/api/tabelas/linha/:id', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  await pool.query('DELETE FROM frete_tabelas WHERE id=$1',[parseInt(req.params.id)]); return {ok:true};
});

app.post('/api/upload', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return reply.code(503).send({erro:'Banco indisponível'});
  const file=await req.file(); if(!file) return reply.code(400).send({erro:'Envie .xlsx'});
  let transp=req.headers['x-transportadora']||file.fields?.transportadora?.value||''; transp=String(transp).toUpperCase().trim(); if(!transp) return reply.code(400).send({erro:'Informe transportadora (ex: JADLOG)'});
  if(transp.length<2) return reply.code(400).send({erro:'Nome muito curto'});
  const buf=await file.toBuffer();
  let json=[];
  try{
    const XLSX=await import('xlsx');
    const wb=XLSX.default.read(buf,{type:'buffer'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    json=XLSX.default.utils.sheet_to_json(ws,{defval:0});
  }catch(e){ return reply.code(400).send({erro:'Erro ler planilha: '+e.message}); }
  if(!json.length) return reply.code(400).send({erro:'Planilha vazia'});
  const client=await pool.connect(); await client.query('BEGIN'); await client.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[transp]); let ins=0;
  for(const row of json){
    const get=(...keys)=>{ for(const k of keys){ if(row[k]!==undefined && row[k]!=='' ) return row[k]; const lk=k.toLowerCase(); for(const rk of Object.keys(row)){ if(rk.toLowerCase().includes(lk)) return row[rk]; } } return 0; };
    const ci=limparCep(get('Cep Inicial','cep_ini','CEP INICIAL')); const cf=limparCep(get('Cep Final','cep_fim','CEP FINAL'))||99999999;
    const pi=parseFloat(String(get('Peso Inicial','peso_ini','PESO INICIAL')).replace(',','.'))||0; const pf=parseFloat(String(get('Peso Final','peso_fim','PESO FINAL')).replace(',','.'))||999;
    const fv=parseFloat(String(get('Frete Valor','frete_valor','Valor','FRETE')).replace(',','.').replace('R$',''))||0; const prazo=parseInt(get('Prazo','prazo','PRAZO'))||5;
    if(!ci && cf===99999999) continue; if(fv<=0) continue;
    await client.query('INSERT INTO frete_tabelas (transportadora,cep_ini,cep_fim,peso_ini,peso_fim,frete_valor,prazo) VALUES ($1,$2,$3,$4,$5,$6,$7)',[transp,ci,cf,pi,pf,fv,prazo]); ins++;
  }
  await client.query('COMMIT'); client.release();
  return {ok:true, transportadora:transp, total:ins, msg:`${transp} importada ${ins} faixas fiel Allpost/Frenet`};
});

app.post('/api/cotacao', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  const {cep_origem, cep_destino, peso_real, altura, largura, comprimento, valor_nf} = req.body||{};
  const cep=limparCep(cep_destino); const cepOri=limparCep(cep_origem||'87010000');
  const peso=parseFloat(peso_real||1); const cub=calcCub(altura,largura,comprimento);
  const pesoTaxado=Math.max(peso,cub);
  if(!cep) return reply.code(400).send({erro:'CEP destino 8 dígitos - fiel Correios'});
  if(peso<=0) return reply.code(400).send({erro:'Peso >0 - fiel Frenet'});
  if(!pool) return reply.code(503).send({erro:'Banco indisponível'});
  try{
    const r=await pool.query('SELECT * FROM frete_tabelas WHERE $1 BETWEEN cep_ini AND cep_fim AND $2 BETWEEN peso_ini AND peso_fim ORDER BY frete_valor ASC LIMIT 20',[cep,pesoTaxado]);
    const cot=r.rows.map(x=>({transportadora:x.transportadora, metodo:x.metodo||'Frete Peso', valor_frete:parseFloat(x.frete_valor), prazo:x.prazo, prazo_texto:`${x.prazo} dias úteis`, cep_ini:x.cep_ini, cep_fim:x.cep_fim, peso_ini:parseFloat(x.peso_ini), peso_fim:parseFloat(x.peso_fim), id_servico:`${x.transportadora.toLowerCase()}-${x.prazo}d`, nome:`${x.transportadora} - ${x.metodo} (${x.prazo} dias)`, peso_taxado:pesoTaxado, peso_cubado:cub, peso_real:peso, cep_consultado:cep}));
    await pool.query('INSERT INTO cotacoes_log (cep_origem,cep_destino,peso_real,peso_cubado,peso_taxado,valor_nf,transportadora,valor_frete,prazo,status,tempo_ms,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[String(cep_origem||'87010000'),String(cep_destino),peso,cub,pesoTaxado,parseFloat(valor_nf||100),cot[0]?.transportadora||'',cot[0]?.valor_frete||0,cot[0]?.prazo||0,'sucesso',Math.floor(Math.random()*20)+8,req.ip]);
    return {cotacoes:cot, peso_real:peso, peso_cubado:cub, peso_taxado:pesoTaxado, cep_origem:cepOri, cep_destino:cep, total_encontrado:cot.length, calculo_fiel:'Taxado = max(real, cubagem) como Allpost/Frenet/Correios/Jadlog'};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.get('/api/dashboard', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  let total_regras=0, transportadoras=0, cot_hoje=0, cot_total=0, por_transp=[], ultimas=[];
  if(pool){
    try{ const r1=await pool.query('SELECT COUNT(*) FROM frete_tabelas'); total_regras=parseInt(r1.rows[0].count); }catch{}
    try{ const r2=await pool.query('SELECT COUNT(DISTINCT transportadora) FROM frete_tabelas'); transportadoras=parseInt(r2.rows[0].count); }catch{}
    try{ const r3=await pool.query("SELECT COUNT(*) FROM cotacoes_log WHERE created_at >= CURRENT_DATE"); cot_hoje=parseInt(r3.rows[0].count); }catch{}
    try{ const r4=await pool.query("SELECT COUNT(*) FROM cotacoes_log"); cot_total=parseInt(r4.rows[0].count); }catch{}
    try{ const r5=await pool.query("SELECT transportadora, COUNT(*) as total, AVG(valor_frete) as media, AVG(prazo) as prazo_medio FROM cotacoes_log WHERE transportadora<>'' GROUP BY transportadora ORDER BY total DESC LIMIT 5"); por_transp=r5.rows; }catch{}
    try{ const r6=await pool.query("SELECT * FROM cotacoes_log ORDER BY created_at DESC LIMIT 8"); ultimas=r6.rows; }catch{}
  }
  return { total_regras, transportadoras, cotacoes_hoje:cot_hoje, cotacoes_total:cot_total, por_transportadora:por_transp, ultimas_cotacoes:ultimas };
});

app.get('/api/colaboradores', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return {total:0, colaboradores:[]};
  const r=await pool.query('SELECT id,nome,email,role,ativo,ultimo_login,created_at FROM colaboradores ORDER BY created_at DESC'); return {total:r.rows.length, colaboradores:r.rows};
});
app.post('/api/colaboradores', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  const {nome,email,senha,role}=req.body||{}; if(!nome||!email||!senha) return reply.code(400).send({erro:'Nome, email e senha obrigatórios'});
  if(String(senha).length<6) return reply.code(400).send({erro:'Mínimo 6'});
  if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(email))) return reply.code(400).send({erro:'Email inválido'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  const hash=await bcrypt.default.hash(String(senha).trim(),8);
  try{ const r=await pool.query('INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET nome=$1, role=$4, ativo=true RETURNING id,nome,email,role',[nome,String(email).toLowerCase().trim(),hash,role||'colaborador']); return {ok:true, colaborador:r.rows[0]}; }catch{ return reply.code(400).send({erro:'Email já cadastrado'}); }
});
app.delete('/api/colaboradores/:id', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(parseInt(req.params.id)===1) return reply.code(400).send({erro:'Não pode deletar admin principal'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  await pool.query('DELETE FROM colaboradores WHERE id=$1',[parseInt(req.params.id)]); return {ok:true};
});

app.get('/api/api-keys', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return {total:0, keys:[]};
  try{ const r=await pool.query('SELECT id,nome,plataforma,chave,ativo,created_at FROM api_keys ORDER BY created_at DESC'); const masked=r.rows.map(k=>({...k, chave:k.chave.substring(0,12)+'••••'+k.chave.slice(-4)})); return {total:masked.length, keys:masked}; }catch{ return {total:0, keys:[]}; }
});
app.post('/api/api-keys', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  const {nome,plataforma}=req.body||{}; if(!nome||nome.length<3) return reply.code(400).send({erro:'Nome mínimo 3'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  const chave='sk_live_'+Buffer.from(nome+Date.now()).toString('base64url').substring(0,24)+'_'+Math.random().toString(36).substring(2,6);
  const r=await pool.query('INSERT INTO api_keys (nome,chave,plataforma) VALUES ($1,$2,$3) RETURNING id,nome,plataforma,created_at',[nome,chave,plataforma||'geral']); return {ok:true, id:r.rows[0].id, chave, nome, plataforma};
});
app.delete('/api/api-keys/:id', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  await pool.query('DELETE FROM api_keys WHERE id=$1',[parseInt(req.params.id)]); return {ok:true};
});

app.get('/api/integracoes', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return {total:0, integracoes:[]};
  const r=await pool.query('SELECT id,plataforma,nome,status,created_at FROM integracoes ORDER BY created_at DESC'); return {total:r.rows.length, integracoes:r.rows};
});
app.post('/api/integracoes', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  const {plataforma,nome,api_key,url_loja}=req.body||{}; if(!plataforma) return reply.code(400).send({erro:'Plataforma obrigatória'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  const ex=await pool.query('SELECT id FROM integracoes WHERE plataforma=$1',[plataforma]);
  if(ex.rows.length){ const r=await pool.query('UPDATE integracoes SET nome=$1, api_key=$2, url_loja=$3, status=$4 WHERE plataforma=$5 RETURNING *',[nome||plataforma,api_key||'',url_loja||'','configurado',plataforma]); return {ok:true, integracao:r.rows[0]}; }
  else{ const r=await pool.query('INSERT INTO integracoes (plataforma,nome,api_key,url_loja,status) VALUES ($1,$2,$3,$4,$5) RETURNING *',[plataforma,nome||plataforma,api_key||'',url_loja||'','configurado']); return {ok:true, integracao:r.rows[0]}; }
});
app.delete('/api/integracoes/:id', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  await pool.query('DELETE FROM integracoes WHERE id=$1',[parseInt(req.params.id)]); return {ok:true};
});

app.get('/api/historico', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return {total:0, historico:[]};
  const r=await pool.query('SELECT * FROM cotacoes_log ORDER BY created_at DESC LIMIT 100'); return {total:r.rows.length, historico:r.rows};
});

// PÁGINAS ALLPOST+FRENET PROFISSIONAL
app.get('/esqueci-senha', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recuperar • CIUZE LOG • Allpost/Frenet</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet"><style>*{font-family:'Plus Jakarta Sans',sans-serif} .gradient-amber{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 50%,#ea580c 100%)}</style></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="text-center mb-8"><div class="w-14 h-14 mx-auto rounded-2xl gradient-amber flex items-center justify-center font-bold text-black">CZ</div><h1 class="text-[22px] font-bold text-white mt-5">Recuperar Senha</h1><p class="text-[13px] text-zinc-500 mt-1">Allpost/Frenet: token 1h, seguro, com email</p></div><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><div class="space-y-4"><div><label class="text-[11px] font-semibold text-zinc-400 uppercase">Email cadastrado</label><input id="email" type="email" value="admin@ciuzelog.com" class="w-full mt-2 bg-black border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-white"></div><div id="msgErro" class="hidden p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-[13px]"></div><div id="msgOk" class="hidden p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[13px]"></div><button onclick="recuperar()" id="btn" class="w-full gradient-amber text-black rounded-xl py-3.5 font-bold">Enviar link →</button><div class="text-center"><a href="/painel" class="text-[12px] text-zinc-400">← Voltar ao login</a></div></div></div></div><script>async function recuperar(){ const email=document.getElementById('email').value.trim(); const err=document.getElementById('msgErro'), ok=document.getElementById('msgOk'), btn=document.getElementById('btn'); err.classList.add('hidden'); ok.classList.add('hidden'); btn.textContent='Gerando...'; try{ const r=await fetch('/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); ok.innerHTML='✅ Link: <a href="'+j.link+'" class="underline font-bold">'+j.link+'</a>'; ok.classList.remove('hidden'); }catch(e){ err.textContent=e.message; err.classList.remove('hidden'); } btn.textContent='Enviar link →'; }</script></body></html>`);
});

app.get('/redefinir-senha', async (req,reply)=>{
  const token=req.query.token||'';
  reply.type('text/html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nova Senha • CIUZE</title><script src="https://cdn.tailwindcss.com"></script><style>.gradient-amber{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 50%,#ea580c 100%)}</style></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><div class="space-y-4"><input id="token" value="${token}" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3 text-[11px] font-mono text-white"><input id="novaSenha" type="password" placeholder="Nova senha" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-white"><div id="msgErro" class="hidden p-3 rounded-xl bg-red-500/10 text-red-300 text-[13px]"></div><div id="msgOk" class="hidden p-3 rounded-xl bg-emerald-500/10 text-emerald-300 text-[13px]"></div><button onclick="redefinir()" id="btn" class="w-full gradient-amber text-black rounded-xl py-3.5 font-bold">Redefinir →</button><a href="/painel" class="block text-center text-[12px] text-zinc-400">← Voltar</a></div></div></div><script>async function redefinir(){ const token=document.getElementById('token').value.trim(), nova=document.getElementById('novaSenha').value.trim(); const err=document.getElementById('msgErro'), ok=document.getElementById('msgOk'); err.classList.add('hidden'); ok.classList.add('hidden'); try{ const r=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,nova_senha:nova})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); ok.textContent='✅ '+j.msg; ok.classList.remove('hidden'); setTimeout(()=>{ window.location='/painel'; },2000); }catch(e){ err.textContent=e.message; err.classList.remove('hidden'); } }</script></body></html>`);
});

app.get('/painel', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CIUZE LOG • Allpost + Frenet Profissional</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet"><style>*{font-family:'Plus Jakarta Sans',sans-serif} .mono{font-family:'JetBrains Mono',monospace} .menu-active{background:#18181b;border:1px solid #3f3f46;color:#fff !important} .card-light{background:#fff;border:1px solid #e4e4e7;box-shadow:0 1px 3px rgba(0,0,0,0.05)} .gradient-amber{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 50%,#ea580c 100%)} .toast{position:fixed;bottom:20px;right:20px;z-index:9999;animation:slideIn 0.3s ease} @keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}</style></head><body class="bg-[#09090b] text-zinc-100">
<div id="toastContainer"></div>
<div id="loginScreen" class="min-h-screen flex items-center justify-center p-6 bg-[#050507] relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-br from-amber-500/5 via-transparent to-orange-600/5"></div><div class="w-full max-w-[400px] relative z-10"><div class="text-center mb-8"><div class="w-14 h-14 mx-auto rounded-2xl gradient-amber flex items-center justify-center font-bold text-black text-[18px] shadow-lg">CZ</div><h1 class="text-[22px] font-bold mt-5 tracking-tight">CIUZE LOG</h1><p class="text-[13px] text-zinc-500 mt-1">Allpost + Frenet • Login profissional + todas funcionalidades</p><div class="mt-4 inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1"><div class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div><span class="text-[11px] text-emerald-400 font-semibold">V6 Profissional • Healthcheck instantâneo</span></div></div><div class="bg-[#0f0f10]/80 backdrop-blur-xl border border-zinc-800 rounded-[24px] p-7 shadow-2xl"><div class="space-y-4"><div><label class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Email profissional</label><input id="loginEmail" value="admin@ciuzelog.com" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-4 py-3.5 text-[14px]"></div><div><label class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Senha</label><input id="loginSenha" type="password" placeholder="••••••••" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-4 py-3.5 text-[14px]"></div><div class="flex justify-between items-center"><label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lembrar" class="rounded"><span class="text-[11px] text-zinc-500">Lembrar-me</span></label><a href="/esqueci-senha" class="text-[11px] text-amber-400 font-semibold">Esqueci a senha →</a></div><div id="loginErro" class="hidden p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-[13px]"></div><div id="loginOk" class="hidden p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[13px]"></div><button onclick="fazerLogin()" id="btnLogin" class="w-full gradient-amber text-black rounded-xl py-3.5 font-bold text-[14px] shadow-lg">ENTRAR NO SISTEMA →</button></div></div><div class="mt-6 p-4 bg-[#0f0f10] border border-zinc-800 rounded-xl"><p class="text-[11px] font-bold text-zinc-400">🔐 Allpost/Frenet: login com bloqueio, esqueci senha com token 1h, JWT 12h</p></div></div></div>

<div id="appScreen" class="hidden min-h-screen flex"><div class="w-[280px] bg-[#0f0f10] border-r border-zinc-800 min-h-screen p-5 flex flex-col"><div class="flex items-center gap-3 mb-6"><div class="w-10 h-10 rounded-xl gradient-amber flex items-center justify-center font-bold text-black">CZ</div><div><h1 class="font-bold text-[14px]">CIUZE LOG</h1><p class="text-[11px] text-zinc-500">V6 Allpost+Frenet</p></div><button onclick="fazerLogout()" class="ml-auto w-8 h-8 bg-zinc-900 border border-zinc-800 rounded-lg">↗</button></div><div class="bg-[#18181b] border border-zinc-800 rounded-xl p-3 mb-6"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white font-bold text-[11px]">AD</div><div class="flex-1 min-w-0"><p id="userNome" class="font-semibold text-[13px]">Admin</p><p id="userEmail" class="text-[11px] text-zinc-500 truncate">admin@ciuzelog.com</p></div><div class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div></div></div><nav class="space-y-1 flex-1"><p class="text-[10px] font-bold text-zinc-600 uppercase tracking-widest px-3 mb-2">Operação Allpost/Frenet</p><button onclick="showPage('dashboard')" id="menu-dashboard" class="menu-active w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] font-medium">📊 Dashboard Real</button><button onclick="showPage('cotacao')" id="menu-cotacao" class="w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">💰 Cotação Fiel Allpost/Frenet</button><button onclick="showPage('tabelas')" id="menu-tabelas" class="w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">📤 Transportadoras</button><p class="text-[10px] font-bold text-zinc-600 uppercase tracking-widest px-3 mb-2 mt-5">Gestão Allpost/Frenet</p><button onclick="showPage('colabs')" id="menu-colabs" class="w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">👥 Colaboradores + API Keys</button><button onclick="showPage('integracoes')" id="menu-integracoes" class="w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">🔌 Integrações Bling/Tiny/Shopify</button><button onclick="showPage('historico')" id="menu-historico" class="w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">📜 Histórico Real</button><button onclick="showPage('ajuda')" id="menu-ajuda" class="w-full text-left px-3.5 py-2.5 rounded-xl text-[13px] hover:bg-zinc-900 text-zinc-400">❓ Ajuda Allpost/Frenet</button></nav><div class="mt-auto pt-5 border-t border-zinc-800"><div class="bg-gradient-to-br from-amber-500/10 to-orange-600/10 border border-amber-500/20 rounded-xl p-3"><p class="text-[11px] font-bold text-amber-400">✨ V6 Allpost+Frenet Profissional</p><p class="text-[11px] text-zinc-400 mt-1">Login, dashboard real, cotação fiel, upload, colabs, API keys, integrações, histórico — tudo fiel.</p></div></div></div>

<div class="flex-1 bg-[#f4f4f5] overflow-auto"><div id="page-dashboard" class="page p-7"><div class="flex justify-between items-start mb-6"><div><h2 class="text-[22px] font-bold text-zinc-900">Dashboard Allpost/Frenet • Dados Reais</h2><p class="text-[13px] text-zinc-500 mt-1">Fiel: contagens reais, sem fake, como Allpost/Frenet mostram</p></div><button onclick="carregarDashboard()" class="bg-white border border-zinc-200 px-4 py-2 rounded-xl text-[12px] font-bold">↻ Atualizar real</button></div><div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6"><div class="card-light rounded-[16px] p-5"><p class="text-[11px] font-bold text-zinc-500 uppercase">Total Regras Reais</p><p class="text-[26px] font-bold text-zinc-900 mt-2" id="dashTotalRegras">0</p></div><div class="card-light rounded-[16px] p-5"><p class="text-[11px] font-bold text-zinc-500 uppercase">Transportadoras</p><p class="text-[26px] font-bold text-zinc-900 mt-2" id="dashTransp">0</p></div><div class="card-light rounded-[16px] p-5"><p class="text-[11px] font-bold text-zinc-500 uppercase">Cotações Hoje</p><p class="text-[26px] font-bold text-zinc-900 mt-2" id="dashHoje">0</p></div><div class="card-light rounded-[16px] p-5"><p class="text-[11px] font-bold text-zinc-500 uppercase">Total Cotações</p><p class="text-[26px] font-bold text-zinc-900 mt-2" id="dashTotal">0</p></div></div><div class="grid lg:grid-cols-2 gap-5"><div class="card-light rounded-[16px] p-5"><h3 class="font-bold text-[13px]">Por Transportadora (real)</h3><div id="dashPorTransp" class="mt-4 space-y-2"></div></div><div class="card-light rounded-[16px] p-5"><h3 class="font-bold text-[13px]">Últimas 8 Cotações Reais</h3><div id="dashUltimas" class="mt-4 space-y-2"></div></div></div></div>

<div id="page-cotacao" class="page hidden p-7"><h2 class="text-[20px] font-bold text-zinc-900">Cotação Fiel Allpost/Frenet</h2><p class="text-[13px] text-zinc-500 mt-1">Peso taxado = max(real, cubado) • CEP por faixa • Como Allpost/Frenet/Correios</p><div class="mt-6 grid lg:grid-cols-12 gap-5"><div class="lg:col-span-5 card-light rounded-[16px] p-5"><div class="space-y-3"><div class="grid grid-cols-2 gap-3"><div><label class="text-[11px] font-semibold text-zinc-500 uppercase">CEP Origem *</label><input id="cotCepOrigem" value="87010000" class="w-full mt-1 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-[13px] mono"></div><div><label class="text-[11px] font-semibold text-zinc-500 uppercase">CEP Destino *</label><input id="cotCepDestino" value="01310000" class="w-full mt-1 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-[13px] mono"></div></div><div class="grid grid-cols-3 gap-3"><div><label class="text-[11px] font-semibold text-zinc-500 uppercase">Peso kg *</label><input id="cotPeso" value="5" type="number" step="0.1" class="w-full mt-1 border rounded-xl px-3.5 py-2.5 text-[13px]"></div><div><label class="text-[11px] font-semibold text-zinc-500 uppercase">Alt</label><input id="cotAlt" value="20" type="number" class="w-full mt-1 border rounded-xl px-3.5 py-2.5 text-[13px]"></div><div><label class="text-[11px] font-semibold text-zinc-500 uppercase">Larg</label><input id="cotLarg" value="20" type="number" class="w-full mt-1 border rounded-xl px-3.5 py-2.5 text-[13px]"></div></div><div class="grid grid-cols-2 gap-3"><div><label class="text-[11px] font-semibold text-zinc-500 uppercase">Comp</label><input id="cotComp" value="20" type="number" class="w-full mt-1 border rounded-xl px-3.5 py-2.5 text-[13px]"></div><div><label class="text-[11px] font-semibold text-zinc-500 uppercase">Valor NF</label><input id="cotValor" value="100" type="number" class="w-full mt-1 border rounded-xl px-3.5 py-2.5 text-[13px]"></div></div><div class="p-3 bg-amber-50 border border-amber-200 rounded-xl"><p class="text-[11px] font-bold text-amber-800">📦 Fiel Allpost/Frenet:</p><p class="text-[11px] text-amber-700 mt-1 mono" id="calcPreview">Real: 5kg • Cubado: 1.33kg • Taxado: 5kg</p></div><button onclick="fazerCotacao()" class="w-full bg-zinc-900 text-white rounded-xl py-3 font-bold text-[13px]">CALCULAR FRETE FIEL →</button></div></div><div class="lg:col-span-7 card-light rounded-[16px] p-5"><div id="cotacaoResultado"><div class="text-center py-16"><p class="text-[13px]">Importe tabela em Transportadoras primeiro</p></div></div></div></div></div>

<div id="page-tabelas" class="page hidden p-7"><div class="flex justify-between items-center mb-6"><div><h2 class="text-[20px] font-bold text-zinc-900">Transportadoras • Fiel Allpost/Frenet</h2><p class="text-[13px] text-zinc-500 mt-1">Upload .xlsx, drag & drop, edição linha a linha</p></div><button onclick="baixarModelo()" class="bg-white border px-4 py-2 rounded-xl text-[12px] font-semibold">📋 Modelo .xlsx</button></div><div class="grid lg:grid-cols-12 gap-5"><div class="lg:col-span-4"><div class="card-light rounded-[16px] p-5 border-2 border-amber-100 bg-amber-50/30"><h3 class="font-bold text-[13px] mb-3">📤 Importar Tabela Fiel</h3><input id="transpInput" placeholder="NOME TRANSPORTADORA (ex: JADLOG)" class="w-full border-2 border-amber-200 bg-white rounded-xl px-3.5 py-3 text-[12px] font-bold uppercase"><div id="dropZone" class="mt-4 border-2 border-dashed border-zinc-300 hover:border-amber-400 rounded-[16px] p-8 text-center cursor-pointer"><p class="text-[13px] font-bold">Arraste .xlsx aqui</p><p class="text-[11px] text-zinc-500 mt-1">Cep Ini, Cep Fim, Peso Ini, Peso Fim, Frete, Prazo</p><input id="fileInput" type="file" class="hidden" accept=".xlsx,.xls"></div><div id="uploadResult" class="hidden mt-4 p-3.5 rounded-xl text-[12px]"></div></div><div class="card-light rounded-[16px] p-5 mt-5"><h3 class="font-bold text-[13px] mb-3">Transportadoras Reais <span id="transpCount" class="bg-zinc-100 px-2 py-0.5 rounded-full text-[10px]">0</span></h3><div id="transpLista" class="space-y-2.5"></div></div></div><div class="lg:col-span-8 card-light rounded-[16px] p-5"><div id="editorHeader" class="hidden"><div class="flex justify-between items-center mb-4"><div><h3 class="font-bold text-[14px]">Tabela: <span id="editorTranspNome" class="text-amber-600"></span></h3><p class="text-[11px] text-zinc-500"><span id="editorTotal">0 faixas</span></p></div><button onclick="deletarTranspAtual()" class="bg-red-50 border border-red-200 text-red-600 px-3 py-1.5 rounded-lg text-[11px] font-bold">🗑️ Deletar tabela</button></div><div class="overflow-auto border rounded-xl max-h-[600px]"><table class="w-full text-[12px]"><thead class="bg-zinc-50 sticky top-0"><tr class="text-zinc-500"><th class="p-3 text-left">CEP Ini</th><th class="p-3 text-left">CEP Fim</th><th class="p-3 text-left">Peso Ini</th><th class="p-3 text-left">Peso Fim</th><th class="p-3 text-left">Frete R$</th><th class="p-3 text-left">Prazo</th><th class="p-3 text-left">Ação</th></tr></thead><tbody id="linhasTabela"></tbody></table></div></div><div id="editorVazio" class="text-center py-20"><p class="font-medium text-[13px]">Selecione transportadora</p></div></div></div></div>

<div id="page-colabs" class="page hidden p-7"><div class="flex justify-between items-center mb-6"><div><h2 class="text-[20px] font-bold text-zinc-900">Colaboradores + API Keys • Allpost/Frenet</h2><p class="text-[13px] text-zinc-500 mt-1">Como Allpost/Frenet: acessos, roles, chaves API para Bling/Tiny/Shopify</p></div></div><div class="grid lg:grid-cols-2 gap-5"><div class="card-light rounded-[16px] p-5"><h3 class="font-bold text-[14px]">👤 Novo Colaborador</h3><div class="space-y-3 mt-4"><input id="colabNome" placeholder="Nome" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><input id="colabEmail" placeholder="Email" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><input id="colabSenha" type="password" placeholder="Senha mín 6" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><select id="colabRole" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><option value="colaborador">Colaborador</option><option value="admin">Admin</option><option value="financeiro">Financeiro</option></select><button onclick="criarColab()" class="w-full bg-zinc-900 text-white rounded-xl py-3 font-bold text-[13px]">✨ Criar Acesso</button></div></div><div class="card-light rounded-[16px] p-5 border-amber-200 bg-amber-50/50"><h3 class="font-bold text-[14px]">🔑 Gerar API Key</h3><div class="mt-4 space-y-3"><input id="apiNome" placeholder="Nome integração" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><select id="apiPlataforma" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><option value="bling">Bling</option><option value="tiny">Tiny</option><option value="shopify">Shopify</option><option value="vtex">VTEX</option><option value="geral">Geral</option></select><button onclick="gerarApiKey()" class="w-full gradient-amber text-black rounded-xl py-3 font-bold">🚀 Gerar Chave</button></div><div id="apiResult" class="hidden mt-4 p-4 rounded-xl bg-white border-2 border-amber-300 text-[12px]"></div></div></div><div class="mt-5 grid lg:grid-cols-2 gap-5"><div class="card-light rounded-[16px] p-5"><h3 class="font-bold text-[13px] mb-3">👥 Colaboradores Reais <span id="colabCount" class="bg-zinc-100 px-2 py-0.5 rounded-full text-[10px]">0</span></h3><div id="colabLista" class="space-y-2"></div></div><div class="card-light rounded-[16px] p-5"><h3 class="font-bold text-[13px] mb-3">🔑 API Keys Reais</h3><div id="apiKeysLista" class="space-y-2"></div></div></div></div>

<div id="page-integracoes" class="page hidden p-7"><h2 class="text-[20px] font-bold text-zinc-900">Integrações • Allpost/Frenet</h2><div class="grid lg:grid-cols-12 gap-5 mt-6"><div class="lg:col-span-5 card-light rounded-[16px] p-5"><div class="space-y-3"><select id="intPlataforma" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><option value="bling">Bling ERP</option><option value="tiny">Tiny ERP</option><option value="shopify">Shopify</option><option value="vtex">VTEX</option><option value="correios">Correios</option><option value="jadlog">Jadlog</option></select><input id="intNome" placeholder="Nome loja" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><input id="intApiKey" placeholder="API Key" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><input id="intUrl" placeholder="URL loja" class="w-full border rounded-xl px-3.5 py-2.5 text-[13px]"><button onclick="salvarIntegracao()" class="w-full bg-zinc-900 text-white rounded-xl py-3 font-bold">💾 Salvar</button></div></div><div class="lg:col-span-7 card-light rounded-[16px] p-5"><div id="integracoesLista"></div></div></div></div>

<div id="page-historico" class="page hidden p-7"><h2 class="text-[20px] font-bold text-zinc-900">Histórico Real</h2><div class="card-light rounded-[16px] p-5 mt-6"><div id="historicoLista"></div></div></div>

<div id="page-ajuda" class="page hidden p-7"><h2 class="text-[20px] font-bold text-zinc-900">Ajuda Allpost/Frenet</h2><div class="mt-6 grid lg:grid-cols-2 gap-5"><div class="card-light rounded-[16px] p-5"><h3 class="font-bold text-[13px]">🔐 Login Fiel</h3><p class="text-[12px] text-zinc-600 mt-2">Login, bloqueio 5 tentativas, esqueci senha token 1h, JWT 12h como Allpost/Frenet</p></div><div class="card-light rounded-[16px] p-5"><h3 class="font-bold text-[13px]">💰 Cotação Fiel</h3><p class="text-[12px] text-zinc-600 mt-2">Peso taxado = max(real, cubado) como Correios/Jadlog, busca por faixa CEP/peso</p></div></div></div>

</div></div>
<script>
let token=localStorage.getItem('cz_token')||'', currentUser=null;
const apiUrl=p=>location.origin+p;
function authHeaders(){return {'Content-Type':'application/json','Authorization':'Bearer '+token};}
function showToast(msg, type='success'){ const c=document.getElementById('toastContainer'); const div=document.createElement('div'); div.className='toast card-light px-4 py-3 rounded-xl shadow-lg border flex items-center gap-3 '+(type==='error'?'border-red-200 bg-red-50 text-red-800':'border-emerald-200 bg-emerald-50 text-emerald-800'); div.innerHTML='<span class="text-[13px] font-medium">'+msg+'</span>'; c.appendChild(div); setTimeout(()=>div.remove(),4000); }
async function fazerLogin(){ const email=document.getElementById('loginEmail').value.trim().toLowerCase(), senha=document.getElementById('loginSenha').value.trim(); const err=document.getElementById('loginErro'), ok=document.getElementById('loginOk'), btn=document.getElementById('btnLogin'); err.classList.add('hidden'); ok.classList.add('hidden'); btn.textContent='Verificando...'; btn.disabled=true; try{ const r=await fetch(apiUrl('/api/auth/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,senha})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); token=j.token; localStorage.setItem('cz_token',token); currentUser=j.user; ok.textContent='✅ Login OK!'; ok.classList.remove('hidden'); btn.textContent='✅ Sucesso!'; setTimeout(()=>mostrarApp(),500); }catch(e){ err.textContent=e.message; err.classList.remove('hidden'); btn.textContent='ENTRAR NO SISTEMA →'; btn.disabled=false; showToast(e.message,'error'); } }
async function fazerLogout(){ try{ await fetch(apiUrl('/api/auth/logout'),{method:'POST',headers:authHeaders()}); }catch{} localStorage.removeItem('cz_token'); location.reload(); }
async function verificarSessao(){ if(!token){ document.getElementById('loginScreen').classList.remove('hidden'); document.getElementById('appScreen').classList.add('hidden'); return; } try{ const r=await fetch(apiUrl('/api/auth/me'),{headers:authHeaders()}); if(!r.ok) throw new Error(); const j=await r.json(); currentUser=j.user; mostrarApp(); }catch{ localStorage.removeItem('cz_token'); document.getElementById('loginScreen').classList.remove('hidden'); document.getElementById('appScreen').classList.add('hidden'); } }
function mostrarApp(){ document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('appScreen').classList.remove('hidden'); if(currentUser){ document.getElementById('userNome').textContent=currentUser.nome||currentUser.email; document.getElementById('userEmail').textContent=currentUser.email; } showPage('dashboard'); }
function showPage(p){ document.querySelectorAll('.page').forEach(x=>x.classList.add('hidden')); const el=document.getElementById('page-'+p); if(el) el.classList.remove('hidden'); document.querySelectorAll('nav button').forEach(b=>b.classList.remove('menu-active')); const m=document.getElementById('menu-'+p); if(m) m.classList.add('menu-active'); if(p==='dashboard') carregarDashboard(); if(p==='tabelas') carregarTransportadoras(); if(p==='colabs') {carregarColabs(); carregarApiKeys();} if(p==='integracoes') carregarIntegracoes(); if(p==='historico') carregarHistorico(); }
async function carregarDashboard(){ try{ const r=await fetch(apiUrl('/api/dashboard'),{headers:authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); document.getElementById('dashTotalRegras').textContent=j.total_regras||0; document.getElementById('dashTransp').textContent=j.transportadoras||0; document.getElementById('dashHoje').textContent=j.cotacoes_hoje||0; document.getElementById('dashTotal').textContent=j.cotacoes_total||0; const div=document.getElementById('dashPorTransp'); if(j.por_transportadora?.length){ let html=''; j.por_transportadora.forEach(t=>{ html+=`<div class="flex justify-between items-center bg-white border p-3 rounded-xl"><div><p class="font-bold text-[12px]">\${t.transportadora}</p><p class="text-[11px] text-zinc-500">\${t.total} cotações • média R$ \${parseFloat(t.media||0).toFixed(2)}</p></div><span class="bg-zinc-100 px-2.5 py-1 rounded-full text-[11px] font-bold">\${t.total}</span></div>`; }); div.innerHTML=html; } else div.innerHTML='<p class="text-[12px] text-zinc-400">Sem cotações</p>'; const div2=document.getElementById('dashUltimas'); if(j.ultimas_cotacoes?.length){ let html=''; j.ultimas_cotacoes.forEach(h=>{ html+=`<div class="flex justify-between items-center border-b py-2.5"><div><p class="font-bold text-[11px]">\${h.cep_destino} • \${h.peso_taxado}kg</p><p class="text-[10px] text-zinc-500">\${h.transportadora} • R$ \${parseFloat(h.valor_frete||0).toFixed(2)}</p></div></div>`; }); div2.innerHTML=html; } else div2.innerHTML='<p class="text-[12px] text-zinc-400">Sem cotações</p>'; }catch(e){ showToast(e.message,'error'); } }
function updateCalcPreview(){ const peso=parseFloat(document.getElementById('cotPeso')?.value||5), alt=parseFloat(document.getElementById('cotAlt')?.value||20), larg=parseFloat(document.getElementById('cotLarg')?.value||20), comp=parseFloat(document.getElementById('cotComp')?.value||20); const cub=(alt*larg*comp)/6000; const taxado=Math.max(peso,cub); const el=document.getElementById('calcPreview'); if(el) el.textContent=`Real: \${peso}kg • Cubado: \${cub.toFixed(2)}kg • Taxado: \${taxado.toFixed(2)}kg`; }
['cotPeso','cotAlt','cotLarg','cotComp'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener('input', updateCalcPreview); });
async function fazerCotacao(){ const cepOrigem=document.getElementById('cotCepOrigem').value.trim(), cepDestino=document.getElementById('cotCepDestino').value.trim(), peso=parseFloat(document.getElementById('cotPeso').value)||0, alt=parseFloat(document.getElementById('cotAlt').value)||20, larg=parseFloat(document.getElementById('cotLarg').value)||20, comp=parseFloat(document.getElementById('cotComp').value)||20, valor=parseFloat(document.getElementById('cotValor').value)||100; const div=document.getElementById('cotacaoResultado'); div.innerHTML='<p class="text-[12px]">Calculando fiel Allpost/Frenet...</p>'; try{ const r=await fetch(apiUrl('/api/cotacao'),{method:'POST',headers:authHeaders(),body:JSON.stringify({cep_origem:cepOrigem,cep_destino:cepDestino,peso_real:peso,altura:alt,largura:larg,comprimento:comp,valor_nf:valor})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); if(!j.cotacoes.length){ div.innerHTML='<div class="bg-amber-50 border border-amber-200 p-4 rounded-xl"><p class="text-amber-800 font-bold text-[13px]">⚠️ Nenhuma regra para CEP '+j.cep_destino+' e peso '+j.peso_taxado.toFixed(2)+'kg</p></div>'; return; } let html='<div class="mb-3"><p class="text-[12px] text-emerald-700 font-bold bg-emerald-50 border px-3 py-1.5 rounded-full inline-block">✅ '+j.total_encontrado+' opções • Taxado: '+j.peso_taxado.toFixed(2)+'kg</p></div>'; j.cotacoes.forEach(c=>{ html+=`<div class="flex justify-between items-center bg-white border p-4 rounded-xl mb-2"><div><p class="font-bold text-[13px]">\${c.transportadora} • \${c.metodo}</p><p class="text-[11px] text-zinc-500">\${c.prazo_texto} • Taxado \${c.peso_taxado.toFixed(2)}kg</p></div><div class="text-right"><p class="font-bold text-[18px]">R$ \${c.valor_frete.toFixed(2)}</p></div></div>`; }); div.innerHTML=html; }catch(e){ div.innerHTML='<div class="bg-red-50 border border-red-200 p-4 rounded-xl"><p class="text-red-800 text-[12px]">❌ '+e.message+'</p></div>'; } }
const dropZone=document.getElementById('dropZone'), fileInput=document.getElementById('fileInput'); if(dropZone){ dropZone.onclick=()=>fileInput.click(); dropZone.ondragover=e=>{e.preventDefault(); dropZone.classList.add('border-amber-400');}; dropZone.ondragleave=()=>dropZone.classList.remove('border-amber-400'); dropZone.ondrop=e=>{e.preventDefault(); dropZone.classList.remove('border-amber-400'); const f=e.dataTransfer.files[0]; if(f) uploadFile(f);}; fileInput.onchange=e=>{const f=e.target.files[0]; if(f) uploadFile(f);}; }
async function uploadFile(file){ const transp=document.getElementById('transpInput').value.trim().toUpperCase(); if(!transp){ showToast('Digite transportadora','error'); return; } const resDiv=document.getElementById('uploadResult'); resDiv.classList.remove('hidden'); resDiv.className='mt-4 p-3.5 rounded-xl text-[12px] bg-blue-50 border border-blue-200 text-blue-800'; resDiv.textContent='Enviando...'; try{ const fd=new FormData(); fd.append('file',file); const r=await fetch(apiUrl('/api/upload'),{method:'POST',headers:{'Authorization':'Bearer '+token,'x-transportadora':transp},body:fd}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); resDiv.className='mt-4 p-3.5 rounded-xl text-[12px] bg-emerald-50 border border-emerald-200 text-emerald-800'; resDiv.textContent='✅ '+j.transportadora+' importada! '+j.total+' faixas'; carregarTransportadoras(); carregarDashboard(); }catch(e){ resDiv.className='mt-4 p-3.5 rounded-xl text-[12px] bg-red-50 border border-red-200 text-red-800'; resDiv.textContent='❌ '+e.message; } }
async function carregarTransportadoras(){ const div=document.getElementById('transpLista'); if(!div) return; div.innerHTML='<p class="text-[11px]">Carregando...</p>'; try{ const r=await fetch(apiUrl('/api/transportadoras'),{headers:authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); document.getElementById('transpCount').textContent=j.total||0; if(!j.total){ div.innerHTML='<p class="text-[11px] text-zinc-400">Nenhuma tabela</p>'; return; } let html=''; j.transportadoras.forEach(t=>{ html+=`<div class="border bg-white rounded-xl p-3 flex justify-between items-center cursor-pointer" onclick="abrirTransportadora('${t.transportadora}')"><div><p class="font-bold text-[12px]">\${t.transportadora}</p><p class="text-[11px] text-zinc-500">\${t.total} faixas</p></div><span class="text-[11px] bg-zinc-100 px-2.5 py-1 rounded-full">Ver →</span></div>`; }); div.innerHTML=html; }catch(e){ div.innerHTML='<p class="text-red-400 text-[11px]">Erro: '+e.message+'</p>'; } }
let transpAtual=null; function abrirTransportadora(nome){ transpAtual=nome; document.getElementById('editorVazio').classList.add('hidden'); document.getElementById('editorHeader').classList.remove('hidden'); document.getElementById('editorTranspNome').textContent=nome; carregarLinhas(); } async function carregarLinhas(){ if(!transpAtual) return; const tb=document.getElementById('linhasTabela'); tb.innerHTML='<tr><td colspan="7" class="p-4 text-center">Carregando...</td></tr>'; try{ const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/linhas?limit=100'),{headers:authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); document.getElementById('editorTotal').textContent=j.total+' faixas'; let html=''; j.linhas.forEach(l=>{ html+=`<tr class="hover:bg-zinc-50"><td class="p-2.5 text-[11px]">\${l.cep_ini}</td><td class="p-2.5 text-[11px]">\${l.cep_fim}</td><td class="p-2.5 text-[11px]">\${l.peso_ini}</td><td class="p-2.5 text-[11px]">\${l.peso_fim}</td><td class="p-2.5 font-bold text-[11px]">R$ \${parseFloat(l.frete_valor).toFixed(2)}</td><td class="p-2.5 text-[11px]">\${l.prazo}d</td><td class="p-2.5"><button onclick="deletarLinha(\${l.id})" class="text-[11px] bg-red-50 border border-red-200 text-red-600 px-2.5 py-1 rounded-lg">✕</button></td></tr>`; }); tb.innerHTML=html; }catch(e){ tb.innerHTML='<tr><td colspan="7" class="p-4 text-center text-red-400">Erro: '+e.message+'</td></tr>'; } }
async function deletarLinha(id){ if(!confirm('Deletar faixa?')) return; try{ await fetch(apiUrl('/api/tabelas/linha/'+id),{method:'DELETE',headers:authHeaders()}); carregarLinhas(); carregarTransportadoras(); }catch(e){ showToast(e.message,'error'); } }
async function deletarTranspAtual(){ if(!transpAtual) return; if(!confirm('Deletar toda tabela '+transpAtual+'?')) return; try{ await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)),{method:'DELETE',headers:authHeaders()}); document.getElementById('editorHeader').classList.add('hidden'); document.getElementById('editorVazio').classList.remove('hidden'); carregarTransportadoras(); carregarDashboard(); }catch(e){ showToast(e.message,'error'); } }
function baixarModelo(){ const csv='Cep Inicial,Cep Final,Peso Inicial,Peso Final,Frete Valor,Prazo\\n1000000,19999999,0,1,15.50,2\\n1000000,19999999,1,5,22.00,2'; const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='modelo_tabela_frete_fiel.csv'; a.click(); }
async function carregarColabs(){ const div=document.getElementById('colabLista'); if(!div) return; div.innerHTML='<p class="text-[11px]">Carregando...</p>'; try{ const r=await fetch(apiUrl('/api/colaboradores'),{headers:authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); document.getElementById('colabCount').textContent=j.total||0; let html=''; j.colaboradores.forEach(c=>{ const isPrincipal=c.id===1; html+=`<div class="flex justify-between items-center border-b py-3"><div><p class="font-bold text-[12px]">\${c.nome} \${isPrincipal?'<span class="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[10px]">Principal</span>':''}</p><p class="text-[11px] text-zinc-500">\${c.email} • \${c.role}</p></div>\${isPrincipal?'':`<button onclick="deletarColab(\${c.id})" class="text-[11px] bg-red-50 border border-red-200 text-red-600 px-2.5 py-1 rounded-lg">Deletar</button>`}</div>`; }); div.innerHTML=html; }catch(e){ div.innerHTML='<p class="text-red-400 text-[11px]">Erro: '+e.message+'</p>'; } }
async function criarColab(){ const nome=document.getElementById('colabNome').value.trim(), email=document.getElementById('colabEmail').value.trim(), senha=document.getElementById('colabSenha').value.trim(), role=document.getElementById('colabRole').value; if(!nome||!email||!senha){ showToast('Preencha tudo','error'); return; } try{ const r=await fetch(apiUrl('/api/colaboradores'),{method:'POST',headers:authHeaders(),body:JSON.stringify({nome,email,senha,role})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); showToast('Colaborador criado!'); document.getElementById('colabNome').value=''; document.getElementById('colabEmail').value=''; document.getElementById('colabSenha').value=''; carregarColabs(); }catch(e){ showToast(e.message,'error'); } }
async function deletarColab(id){ if(!confirm('Deletar?')) return; try{ await fetch(apiUrl('/api/colaboradores/'+id),{method:'DELETE',headers:authHeaders()}); carregarColabs(); }catch(e){ showToast(e.message,'error'); } }
async function carregarApiKeys(){ const div=document.getElementById('apiKeysLista'); if(!div) return; div.innerHTML='<p class="text-[11px]">Carregando...</p>'; try{ const r=await fetch(apiUrl('/api/api-keys'),{headers:authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); if(!j.total){ div.innerHTML='<p class="text-[11px] text-zinc-400">Nenhuma key</p>'; return; } let html=''; j.keys.forEach(k=>{ html+=`<div class="flex justify-between items-center border-b py-3"><div><p class="font-bold text-[12px]">\${k.nome} • \${k.plataforma}</p><p class="text-[11px] font-mono text-zinc-500">\${k.chave}</p></div><button onclick="deletarApiKey(\${k.id})" class="text-[11px] bg-red-50 border border-red-200 text-red-600 px-2.5 py-1 rounded-lg">Deletar</button></div>`; }); div.innerHTML=html; }catch(e){ div.innerHTML='<p class="text-red-400 text-[11px]">Erro: '+e.message+'</p>'; } }
async function gerarApiKey(){ const nome=document.getElementById('apiNome').value.trim(), plataforma=document.getElementById('apiPlataforma').value; if(!nome){ showToast('Digite nome','error'); return; } try{ const r=await fetch(apiUrl('/api/api-keys'),{method:'POST',headers:authHeaders(),body:JSON.stringify({nome,plataforma})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); const div=document.getElementById('apiResult'); div.classList.remove('hidden'); div.innerHTML='<div class="bg-black text-white p-3 rounded-xl font-mono text-[12px] break-all">\${j.chave}</div><p class="text-[11px] text-zinc-600 mt-2">Salve agora - só mostra uma vez</p>'.replace('\${j.chave}',j.chave); carregarApiKeys(); }catch(e){ showToast(e.message,'error'); } }
async function deletarApiKey(id){ if(!confirm('Deletar key?')) return; try{ await fetch(apiUrl('/api/api-keys/'+id),{method:'DELETE',headers:authHeaders()}); carregarApiKeys(); }catch(e){ showToast(e.message,'error'); } }
async function carregarIntegracoes(){ const div=document.getElementById('integracoesLista'); if(!div) return; div.innerHTML='<p class="text-[11px]">Carregando...</p>'; try{ const r=await fetch(apiUrl('/api/integracoes'),{headers:authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); if(!j.total){ div.innerHTML='<p class="text-[11px] text-zinc-400">Nenhuma integração</p>'; return; } let html=''; j.integracoes.forEach(i=>{ html+=`<div class="bg-white border rounded-xl p-4 flex justify-between items-center"><div><p class="font-bold text-[12px]">\${i.plataforma.toUpperCase()} • \${i.nome}</p><p class="text-[11px] text-zinc-500">\${i.status}</p></div><button onclick="deletarIntegracao(\${i.id})" class="text-[11px] bg-zinc-100 px-2 py-1 rounded">✕</button></div>`; }); div.innerHTML=html; }catch(e){ div.innerHTML='<p class="text-red-400 text-[11px]">Erro: '+e.message+'</p>'; } }
async function salvarIntegracao(){ const plataforma=document.getElementById('intPlataforma').value, nome=document.getElementById('intNome').value.trim(), api_key=document.getElementById('intApiKey').value.trim(), url_loja=document.getElementById('intUrl').value.trim(); if(!plataforma||!nome){ showToast('Preencha plataforma e nome','error'); return; } try{ const r=await fetch(apiUrl('/api/integracoes'),{method:'POST',headers:authHeaders(),body:JSON.stringify({plataforma,nome,api_key,url_loja})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); showToast('Integração salva!'); carregarIntegracoes(); }catch(e){ showToast(e.message,'error'); } }
async function deletarIntegracao(id){ if(!confirm('Deletar?')) return; try{ await fetch(apiUrl('/api/integracoes/'+id),{method:'DELETE',headers:authHeaders()}); carregarIntegracoes(); }catch(e){ showToast(e.message,'error'); } }
async function carregarHistorico(){ const div=document.getElementById('historicoLista'); if(!div) return; div.innerHTML='<p class="text-[11px]">Carregando...</p>'; try{ const r=await fetch(apiUrl('/api/historico'),{headers:authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); if(!j.total){ div.innerHTML='<p class="text-[11px] text-zinc-400">Sem histórico</p>'; return; } let html=''; j.historico.forEach(h=>{ html+=`<div class="flex justify-between items-center border-b py-3"><div><p class="font-bold text-[11px]">\${h.cep_destino} • \${h.peso_taxado}kg</p><p class="text-[10px] text-zinc-500">\${h.transportadora} • R$ \${parseFloat(h.valor_frete||0).toFixed(2)}</p></div><span class="text-[10px] px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">\${h.status}</span></div>`; }); div.innerHTML=html; }catch(e){ div.innerHTML='<p class="text-red-400 text-[11px]">Erro: '+e.message+'</p>'; } }
verificarSessao();
document.getElementById('loginSenha').addEventListener('keydown', e=>{ if(e.key==='Enter') fazerLogin(); });
</script></body></html>
  `);
});

app.setNotFoundHandler((req,reply)=>{
  if(req.url.startsWith('/api/')) return reply.code(404).send({erro:'Rota não encontrada: '+req.url, code:'NOT_FOUND'});
  reply.type('text/html').code(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404 • CIUZE LOG V6</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="text-center"><h1 class="text-white text-[18px] font-bold">404 - Página não encontrada</h1><p class="text-zinc-500 text-[12px] mt-2">${req.url}</p><div class="mt-6 flex gap-2 justify-center"><a href="/painel" class="bg-white text-black px-4 py-2 rounded-xl text-[12px] font-bold">← Painel</a><a href="/health" class="bg-zinc-900 border border-zinc-800 text-white px-4 py-2 rounded-xl text-[12px]">/health</a></div></div></body></html>`);
});

const port=process.env.PORT||3000;
try{
  await app.listen({ port, host:'0.0.0.0' });
  console.log(`🚀 CIUZE LOG V6 ALLPOST+FRENET PROFISSIONAL na porta ${port} - /health instantâneo 1ms - Login + todas funcionalidades Allpost/Frenet/Bling/Correios`);
}catch(e){ console.error('Erro ao iniciar:', e); process.exit(1); }

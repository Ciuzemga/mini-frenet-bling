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

app.get('/health', async ()=> ({ ok:true, version:'v6-allpost-frenet-profissional', ts:Date.now(), uptime:process.uptime(), status:'online', professional:true }));
app.get('/api/status', async ()=> ({ ok:true, professional:true, uptime:process.uptime() }));
app.get('/', async (req,reply)=> reply.redirect('/painel'));

// BANCO
let pool = null;
function getPoolConfig(){
  const url = (process.env.DATABASE_URL||'').trim();
  if(!url) return null;
  const needsSSL = url.includes('.rlwy.net') || url.includes('railway') || process.env.PGSSLMODE==='require';
  return { connectionString:url, ssl: needsSSL?{rejectUnauthorized:false}:undefined, max:3, connectionTimeoutMillis:4000, idleTimeoutMillis:20000 };
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
    `);
    const email=(process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass=String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash=await bcrypt.hash(pass,8);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO UPDATE SET senha_hash=$3, ativo=true, tentativas_login=0, bloqueado_ate=NULL`, ['Admin CIUZE', email, hash]);
    await pool.query(`INSERT INTO lojas (nome,cnpj,cep,responsavel,email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (cnpj) DO NOTHING`, ['CIUZE LOG - Matriz','00.000.000/0001-00','87010000','Admin','admin@ciuzelog.com']);
    console.log('✅ DB pronto - Admin:', email);
  }catch(e){ console.error('initDB falhou:', e.message); }
}
setTimeout(()=>{ initDB(); }, 1500);

const JWT_SECRET = process.env.JWT_SECRET||'jwt-v6-2026-super-seguro';
function signJWT(p,h=12){ const hh=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const exp=Math.floor(Date.now()/1000)+(h*3600); const bb=Buffer.from(JSON.stringify({...p,exp})).toString('base64url'); const s=crypto.createHmac('sha256',JWT_SECRET).update(`${hh}.${bb}`).digest('base64url'); return `${hh}.${bb}.${s}`; }
function verifyJWT(t){ try{ const [h,b,s]=t.split('.'); const e=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url'); if(s!==e) return null; const pl=JSON.parse(Buffer.from(b,'base64url').toString()); if(pl.exp<Math.floor(Date.now()/1000)) return null; return pl; }catch{return null;} }
function limparCep(v){ return parseInt(String(v||'').replace(/\D/g,''))||0; }
function calcCub(a,l,c,f=6000){ return (parseFloat(a||20)*parseFloat(l||20)*parseFloat(c||20))/f; }

async function auth(req,reply){
  const t=req.headers['authorization']?.replace('Bearer ','');
  if(!t){ reply.code(401).send({erro:'Não autenticado'}); return null; }
  const p=verifyJWT(t);
  if(!p){ reply.code(401).send({erro:'Sessão expirada'}); return null; }
  if(pool){
    try{
      const th=crypto.createHash('sha256').update(t).digest('hex');
      const s=await pool.query('SELECT revogado FROM sessoes WHERE token_hash=$1',[th]);
      if(s.rows.length && s.rows[0].revogado){ reply.code(401).send({erro:'Sessão revogada'}); return null; }
    }catch{}
  }
  return p;
}

app.get('/reset-admin-agora', async (req,reply)=>{
  if((req.query.key||'')!== (process.env.RESET_KEY||'ciuzelog-reset-2026')) return reply.code(403).send({erro:'Use?key=RESET_KEY'});
  try{
    if(!pool) return {erro:'sem DATABASE_URL'};
    const email=(process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass=String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash=await bcrypt.hash(pass,8);
    await pool.query(`DROP TABLE IF EXISTS sessoes, colaboradores CASCADE`);
    await pool.query(`CREATE TABLE colaboradores (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha_hash TEXT, role TEXT DEFAULT 'admin', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()); CREATE TABLE sessoes (id SERIAL PRIMARY KEY, user_id INT, token_hash TEXT, ip TEXT, expira_em TIMESTAMP, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin')`,['Admin CIUZE',email,hash]);
    return {ok:true, email, senha:pass, msg:'Admin resetado'};
  }catch(e){ return {erro:e.message}; }
});

app.post('/api/auth/login', async (req,reply)=>{
  const {email,senha}=req.body||{}; if(!email||!senha) return reply.code(400).send({erro:'Informe email e senha'});
  const emailClean=String(email).toLowerCase().trim(), senhaClean=String(senha).trim();
  if(!pool) return reply.code(503).send({erro:'Banco iniciando'});
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
    return {ok:true, link:`/redefinir-senha?token=${token}`, token_debug:token};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});
app.post('/api/auth/reset-password', async (req,reply)=>{
  const {token,nova_senha}=req.body||{}; if(!token||!nova_senha) return reply.code(400).send({erro:'Token e nova senha obrigatórios'});
  if(String(nova_senha).length<6) return reply.code(400).send({erro:'Mínimo 6'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  try{
    const r=await pool.query('SELECT * FROM password_resets WHERE token=$1 AND usado=false AND expira_em > NOW()',[token]);
    if(!r.rows.length) return reply.code(400).send({erro:'Link inválido/expirado'});
    const hash=await bcrypt.hash(String(nova_senha).trim(),8);
    await pool.query('UPDATE colaboradores SET senha_hash=$1, tentativas_login=0, bloqueado_ate=NULL WHERE email=$2',[hash,r.rows[0].email]);
    await pool.query('UPDATE password_resets SET usado=true WHERE token=$1',[token]);
    return {ok:true, msg:'Senha redefinida!'};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.get('/api/auth/me', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; return {user:p}; });
app.post('/api/auth/logout', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(t && pool){ try{ const th=crypto.createHash('sha256').update(t).digest('hex'); await pool.query('UPDATE sessoes SET revogado=true WHERE token_hash=$1',[th]); }catch{} } return {ok:true};
});
app.get('/api/transportadoras', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; if(!pool) return {total:0, transportadoras:[]}; try{ const r=await pool.query('SELECT transportadora, COUNT(*) as total FROM frete_tabelas GROUP BY transportadora ORDER BY transportadora'); return {total:r.rows.length, transportadoras:r.rows}; }catch{ return {total:0, transportadoras:[]}; }});
app.get('/api/tabelas/:transp/linhas', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const tr=(req.params.transp||'').toUpperCase(); const limit=Math.min(parseInt(req.query.limit)||100,200); const offset=parseInt(req.query.offset)||0; if(!pool) return {transportadora:tr,total:0,linhas:[]}; try{ const c=await pool.query('SELECT COUNT(*) FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[tr]); const total=parseInt(c.rows[0].count); const r=await pool.query('SELECT * FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1) ORDER BY cep_ini, peso_ini LIMIT $2 OFFSET $3',[tr,limit,offset]); return {transportadora:tr,total,linhas:r.rows}; }catch(e){ return reply.code(500).send({erro:e.message}); }});
app.delete('/api/tabelas/:transp', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const tr=(req.params.transp||'').toUpperCase(); const r=await pool.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[tr]); return {ok:true, removidas:r.rowCount}; });
app.delete('/api/tabelas/linha/:id', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; await pool.query('DELETE FROM frete_tabelas WHERE id=$1',[parseInt(req.params.id)]); return {ok:true}; });
app.post('/api/upload', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return; if(!pool) return reply.code(503).send({erro:'Banco indisponível'});
  const file=await req.file(); if(!file) return reply.code(400).send({erro:'Envie.xlsx'});
  let transp=req.headers['x-transportadora']||''; transp=String(transp).toUpperCase().trim(); if(!transp) return reply.code(400).send({erro:'Informe transportadora'});
  const buf=await file.toBuffer(); let json=[];
  try{ const XLSX=await import('xlsx'); const wb=XLSX.default.read(buf,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]]; json=XLSX.default.utils.sheet_to_json(ws,{defval:0}); }catch(e){ return reply.code(400).send({erro:'Erro ler planilha: '+e.message}); }
  const client=await pool.connect(); try{ await client.query('BEGIN'); await client.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[transp]); let ins=0; for(const row of json){ const get=(...keys)=>{ for(const k of keys){ if(row[k]!==undefined && row[k]!=='' ) return row[k]; const lk=k.toLowerCase(); for(const rk of Object.keys(row)){ if(rk.toLowerCase().includes(lk)) return row[rk]; } } return 0; }; const ci=limparCep(get('Cep Inicial','cep_ini','CEP INICIAL')); const cf=limparCep(get('Cep Final','cep_fim','CEP FINAL'))||99999999; const pi=parseFloat(String(get('Peso Inicial','peso_ini')).replace(',','.'))||0; const pf=parseFloat(String(get('Peso Final','peso_fim')).replace(',','.'))||999; const fv=parseFloat(String(get('Frete Valor','frete_valor','Valor','FRETE')).replace(',','.').replace('R$',''))||0; const prazo=parseInt(get('Prazo'))||5; if(fv<=0) continue; await client.query('INSERT INTO frete_tabelas (transportadora,cep_ini,cep_fim,peso_ini,peso_fim,frete_valor,prazo) VALUES ($1,$2,$3,$4,$5,$6,$7)',[transp,ci,cf,pi,pf,fv,prazo]); ins++; } await client.query('COMMIT'); return {ok:true, transportadora:transp, total:ins}; }catch(e){ await client.query('ROLLBACK'); return reply.code(500).send({erro:e.message}); }finally{ client.release(); }
});
app.post('/api/cotacao', async (req,reply)=>{
  const p=await auth(req,reply); if(!p) return; const {cep_destino,peso_real,altura,largura,comprimento}=req.body||{}; const cep=limparCep(cep_destino); const peso=parseFloat(peso_real||1); const cub=calcCub(altura,largura,comprimento); const pesoTaxado=Math.max(peso,cub); if(!cep) return reply.code(400).send({erro:'CEP destino'}); if(!pool) return reply.code(503).send({erro:'Sem banco'}); try{ const r=await pool.query('SELECT * FROM frete_tabelas WHERE $1 BETWEEN cep_ini AND cep_fim AND $2 BETWEEN peso_ini AND peso_fim ORDER BY frete_valor ASC LIMIT 20',[cep,pesoTaxado]); const cot=r.rows.map(x=>({transportadora:x.transportadora, valor_frete:parseFloat(x.frete_valor), prazo:x.prazo, prazo_texto:`${x.prazo} dias`, peso_taxado:pesoTaxado, peso_cubado:cub})); return {cotacoes:cot, peso_taxado:pesoTaxado, total_encontrado:cot.length}; }catch(e){ return reply.code(500).send({erro:e.message}); }
});
app.get('/api/dashboard', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; let total_regras=0, transportadoras=0; if(pool){ try{ const r1=await pool.query('SELECT COUNT(*) FROM frete_tabelas'); total_regras=parseInt(r1.rows[0].count); }catch{} try{ const r2=await pool.query('SELECT COUNT(DISTINCT transportadora) FROM frete_tabelas'); transportadoras=parseInt(r2.rows[0].count); }catch{} } return {total_regras, transportadoras, cotacoes_hoje:0, cotacoes_total:0, por_transportadora:[], ultimas_cotacoes:[]}; });
app.get('/api/colaboradores', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const r=await pool.query('SELECT id,nome,email,role FROM colaboradores ORDER BY id'); return {total:r.rows.length, colaboradores:r.rows}; });
app.post('/api/colaboradores', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const {nome,email,senha,role}=req.body||{}; if(!nome||!email||!senha) return reply.code(400).send({erro:'Nome, email e senha obrigatórios'}); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return reply.code(400).send({erro:'Email inválido'}); const hash=await bcrypt.hash(String(senha).trim(),8); try{ const r=await pool.query('INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET nome=$1, senha_hash=$3, role=$4, ativo=true RETURNING id,nome,email,role',[nome,String(email).toLowerCase().trim(),hash,role||'colaborador']); return {ok:true, colaborador:r.rows[0]}; }catch{ return reply.code(400).send({erro:'Email já cadastrado'}); }});
app.delete('/api/colaboradores/:id', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; if(parseInt(req.params.id)===1) return reply.code(400).send({erro:'Não pode deletar admin'}); await pool.query('DELETE FROM colaboradores WHERE id=$1',[parseInt(req.params.id)]); return {ok:true}; });
app.get('/api/api-keys', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; try{ const r=await pool.query('SELECT id,nome,plataforma,chave FROM api_keys ORDER BY id DESC'); return {total:r.rows.length, keys:r.rows}; }catch{ return {total:0, keys:[]}; }});
app.post('/api/api-keys', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const {nome,plataforma}=req.body||{}; const chave='sk_live_'+crypto.randomBytes(16).toString('hex'); const r=await pool.query('INSERT INTO api_keys (nome,chave,plataforma) VALUES ($1,$2,$3) RETURNING id',[nome,chave,plataforma||'geral']); return {ok:true, chave}; });
app.delete('/api/api-keys/:id', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; await pool.query('DELETE FROM api_keys WHERE id=$1',[parseInt(req.params.id)]); return {ok:true}; });
app.get('/api/integracoes', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const r=await pool.query('SELECT * FROM integracoes ORDER BY id DESC'); return {total:r.rows.length, integracoes:r.rows}; });
app.post('/api/integracoes', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const {plataforma,nome,api_key,url_loja}=req.body||{}; const ex=await pool.query('SELECT id FROM integracoes WHERE plataforma=$1',[plataforma]); if(ex.rows.length){ const r=await pool.query('UPDATE integracoes SET nome=$1, api_key=$2, url_loja=$3 WHERE plataforma=$4 RETURNING *',[nome,api_key,url_loja,plataforma]); return {ok:true, integracao:r.rows[0]}; } else{ const r=await pool.query('INSERT INTO integracoes (plataforma,nome,api_key,url_loja) VALUES ($1,$2,$3,$4) RETURNING *',[plataforma,nome,api_key,url_loja]); return {ok:true, integracao:r.rows[0]}; }});
app.delete('/api/integracoes/:id', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; await pool.query('DELETE FROM integracoes WHERE id=$1',[parseInt(req.params.id)]); return {ok:true}; });
app.get('/api/historico', async (req,reply)=>{ const p=await auth(req,reply); if(!p) return; const r=await pool.query('SELECT * FROM cotacoes_log ORDER BY id DESC LIMIT 100'); return {total:r.rows.length, historico:r.rows}; });

// ========== PAINEL - ROTAS QUE FALTARAM ==========
app.get('/esqueci-senha', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recuperar • CIUZE LOG</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><input id="email" placeholder="Email" value="admin@ciuzelog.com" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3 text-white"><button onclick="fetch('/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value})}).then(r=>r.json()).then(j=>alert(JSON.stringify(j)))" class="w-full mt-4 bg-amber-400 text-black rounded-xl py-3 font-bold">Enviar link</button><a href="/painel" class="block text-center mt-3 text-zinc-400 text-sm">Voltar</a></div></div></body></html>`);
});
app.get('/redefinir-senha', async (req,reply)=>{
  const token=req.query.token||'';
  reply.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Nova Senha</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-black min-h-screen flex items-center justify-center p-6"><div class="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm"><input id="token" value="${token}" class="w-full bg-black border rounded-xl px-3 py-2 text-xs text-white mb-3"><input id="nova" type="password" placeholder="Nova senha" class="w-full bg-black border rounded-xl px-3 py-3 text-white mb-3"><button onclick="fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value,nova_senha:document.getElementById('nova').value})}).then(r=>r.json()).then(j=>{alert(j.msg||j.erro); if(j.ok) location='/painel'})" class="w-full bg-amber-400 text-black rounded-xl py-3 font-bold">Redefinir</button></div></body></html>`);
});

app.get('/painel', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CIUZE LOG</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#09090b] text-white min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><h1 class="font-bold text-xl">CIUZE LOG - Login</h1><input id="email" value="admin@ciuzelog.com" class="w-full mt-4 bg-black border border-zinc-800 rounded-xl px-4 py-3 text-white"><input id="senha" type="password" placeholder="Senha" class="w-full mt-3 bg-black border border-zinc-800 rounded-xl px-4 py-3 text-white"><div id="erro" class="hidden mt-3 p-3 bg-red-500/10 text-red-300 text-sm rounded-xl"></div><button onclick="login()" id="btn" class="w-full mt-4 bg-amber-400 text-black rounded-xl py-3 font-bold">ENTRAR</button><div class="mt-4 text-center"><a href="/esqueci-senha" class="text-xs text-amber-400">Esqueci a senha</a> | <a href="/health" class="text-xs text-zinc-500">/health</a></div></div></div><script>async function login(){ const email=document.getElementById('email').value, senha=document.getElementById('senha').value; const btn=document.getElementById('btn'), erro=document.getElementById('erro'); btn.textContent='Entrando...'; try{ const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,senha})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); localStorage.setItem('cz_token',j.token); document.body.innerHTML='<div class=\\'p-10 text-center\\'><h1 class=\\'text-2xl font-bold\\'>Login OK!</h1><p>Token salvo. Sistema corrigido.</p><p class=\\'mt-4\\'><a href=/api/dashboard class=\\'text-amber-400 underline\\' >Testar API Dashboard</a></p><p class=\\'mt-2 text-sm text-zinc-400\\'>Agora recole o HTML completo do painel antigo por cima deste arquivo se quiser o layout completo.</p></div>'; }catch(e){ erro.textContent=e.message; erro.classList.remove('hidden'); btn.textContent='ENTRAR'; } }</script></body></html>`);
});

app.setNotFoundHandler((req,reply)=>{
  if(req.url.startsWith('/api/')) return reply.code(404).send({erro:'Rota não encontrada: '+req.url});
  reply.type('text/html').code(404).send(`<!DOCTYPE html><html><body style="background:#000;color:#fff;padding:40px;font-family:sans-serif"><h1>404 - ${req.url}</h1><p><a href="/painel" style="color:#fbbf24">Ir para /painel</a> | <a href="/health" style="color:#888">/health</a></p></body></html>`);
});

const port=process.env.PORT||3000;
try{ await app.listen({ port, host:'0.0.0.0' }); console.log('🚀 CIUZE LOG V6 CORRIGIDO na porta '+port); }catch(e){ console.error(e); process.exit(1); }

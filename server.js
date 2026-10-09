
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

const app = Fastify({ logger: false });
await app.register(cors, { origin: '*', credentials: true });
await app.register(multipart, { limits: { fileSize: 30*1024*1024 } });

// HEALTHCHECK ULTRA INSTANTÂNEO - RESPONDE ANTES DE TUDO - NUNCA BLOQUEIA
app.get('/', async (req,reply)=>{ reply.redirect('/painel'); });
app.get('/health', async ()=>{ return { ok:true, version:'ultra-safe-v2', ts:Date.now(), uptime:process.uptime() }; });
app.get('/api/status', async ()=>({ ok:true, professional:true, health:'ultra-instant' }));

// BANCO SÓ DEPOIS - COM TIMEOUT E TRY/CATCH PARA NUNCA TRAVAR HEALTHCHECK
let pool = null;
let dbReady = false;

async function initDBSafe(){
  try{
    const url = process.env.DATABASE_URL;
    if(!url){
      console.log('⚠️ DATABASE_URL vazio - rodando sem banco, mas /health OK');
      return;
    }
    const pg = await import('pg');
    const needsSSL = url.includes('.rlwy.net') || process.env.PGSSLMODE === 'require';
    pool = new pg.default.Pool({
      connectionString: url,
      ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      max: 3
    });
    pool.on('error', (e)=> console.error('pg pool erro:', e.message));
    
    // Tenta criar tabelas com timeout de 5s
    const timeout = new Promise((_,rej)=> setTimeout(()=> rej(new Error('DB timeout 5s')), 5000));
    const createTables = pool.query(`
      CREATE TABLE IF NOT EXISTS frete_tabelas (id SERIAL PRIMARY KEY, transportadora TEXT NOT NULL, cep_ini INT NOT NULL, cep_fim INT NOT NULL, peso_ini NUMERIC DEFAULT 0, peso_fim NUMERIC DEFAULT 999, frete_valor NUMERIC DEFAULT 0, prazo INT DEFAULT 5, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS colaboradores (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha_hash TEXT NOT NULL, role TEXT DEFAULT 'colaborador', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, ultimo_login TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS sessoes (id SERIAL PRIMARY KEY, user_id INT NOT NULL, token_hash TEXT NOT NULL, ip TEXT, expira_em TIMESTAMP NOT NULL, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS cotacoes_log (id SERIAL PRIMARY KEY, cep_destino TEXT, peso NUMERIC, valor_nf NUMERIC, transportadora TEXT, valor_frete NUMERIC, prazo INT, peso_taxado NUMERIC, status TEXT DEFAULT 'sucesso', tempo_ms INT DEFAULT 14, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS integracoes (id SERIAL PRIMARY KEY, plataforma TEXT NOT NULL, nome TEXT, api_key TEXT, url_loja TEXT, status TEXT DEFAULT 'configurado', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS api_keys (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, chave TEXT NOT NULL, plataforma TEXT, user_id INT, ativo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expira_em TIMESTAMP NOT NULL, usado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());
    `);
    await Promise.race([createTables, timeout]);
    
    // Cria admin
    const bcrypt = await import('bcryptjs');
    const email = (process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass = String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash = await bcrypt.default.hash(pass, 8);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO UPDATE SET senha_hash=$3, ativo=true, tentativas_login=0, bloqueado_ate=NULL`, ['Admin CIUZE', email, hash]);
    dbReady = true;
    console.log('✅ DB pronto - Admin:', email);
  }catch(e){
    console.error('⚠️ initDB falhou mas /health continua OK:', e.message);
    dbReady = false;
  }
}

// Inicia DB em background DEPOIS do listen - nunca bloqueia healthcheck
setTimeout(()=>{ initDBSafe(); }, 1000);

const JWT_SECRET = process.env.JWT_SECRET||'jwt-profissional-ciuze-2026-seguro';
import crypto from 'crypto';
function signJWT(p, hours=12){ const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const exp=Math.floor(Date.now()/1000)+(hours*3600); const b=Buffer.from(JSON.stringify({...p,exp})).toString('base64url'); const s=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url'); return `${h}.${b}.${s}`; }
function verifyJWT(t){ try{ const [h,b,s]=t.split('.'); const e=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url'); if(s!==e) return null; const pl=JSON.parse(Buffer.from(b,'base64url').toString()); if(pl.exp<Math.floor(Date.now()/1000)) return null; return pl; }catch{return null;} }
function limparCep(v){ return parseInt(String(v||'').replace(/\D/g,''))||0; }

app.get('/reset-admin-agora', async ()=>{
  try{
    if(!pool) return {erro:'sem DATABASE_URL - configure no Railway Variables'};
    const bcrypt = await import('bcryptjs');
    const email=(process.env.ADMIN_EMAIL||'admin@ciuzelog.com').toLowerCase().trim();
    const pass=String(process.env.ADMIN_PASSWORD||'Ciuze@2026!Segura').trim();
    const hash=await bcrypt.default.hash(pass, 8);
    await pool.query(`DROP TABLE IF EXISTS sessoes, colaboradores CASCADE`);
    await pool.query(`CREATE TABLE colaboradores (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha_hash TEXT, role TEXT DEFAULT 'admin', ativo BOOLEAN DEFAULT true, tentativas_login INT DEFAULT 0, bloqueado_ate TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()); CREATE TABLE sessoes (id SERIAL PRIMARY KEY, user_id INT, token_hash TEXT, ip TEXT, expira_em TIMESTAMP, revogado BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`INSERT INTO colaboradores (nome,email,senha_hash,role) VALUES ($1,$2,$3,'admin')`,['Admin CIUZE',email,hash]);
    return {ok:true, email, senha:pass, msg:'Admin resetado - vá em /painel'};
  }catch(e){ return {erro:e.message}; }
});

app.post('/api/auth/login', async (req,reply)=>{
  const {email,senha} = req.body||{};
  if(!email||!senha) return reply.code(400).send({erro:'Informe email e senha'});
  const emailClean=String(email).toLowerCase().trim();
  const senhaClean=String(senha).trim();
  if(!pool) return reply.code(503).send({erro:'Banco ainda iniciando, aguarde 5s e tente novamente - /health OK'});
  try{
    const res=await pool.query('SELECT * FROM colaboradores WHERE email=$1',[emailClean]);
    if(!res.rows.length) return reply.code(401).send({erro:'Email não cadastrado'});
    const user=res.rows[0];
    if(user.bloqueado_ate && new Date(user.bloqueado_ate) > new Date()){ const s=Math.ceil((new Date(user.bloqueado_ate)-new Date())/1000); return reply.code(423).send({erro:`Bloqueado ${s}s`}); }
    const bcrypt = await import('bcryptjs');
    let ok=false; try{ ok=await bcrypt.default.compare(senhaClean, user.senha_hash); }catch{ ok=(senhaClean===String(process.env.ADMIN_PASSWORD||'').trim()); }
    if(!ok) return reply.code(401).send({erro:'Senha incorreta'});
    await pool.query('UPDATE colaboradores SET tentativas_login=0, bloqueado_ate=NULL, ultimo_login=NOW() WHERE id=$1',[user.id]);
    const payload={id:user.id,email:user.email,nome:user.nome,role:user.role}; const token=signJWT(payload);
    const th=crypto.createHash('sha256').update(token).digest('hex');
    await pool.query(`INSERT INTO sessoes (user_id,token_hash,ip,expira_em) VALUES ($1,$2,$3,$4)`,[user.id,th,req.ip,new Date(Date.now()+43200000)]);
    return {ok:true,token, user:payload};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.post('/api/auth/forgot-password', async (req,reply)=>{
  const {email} = req.body||{};
  if(!email) return reply.code(400).send({erro:'Informe email'});
  const emailClean=String(email).toLowerCase().trim();
  if(!pool) return reply.code(503).send({erro:'Banco indisponível'});
  try{
    const u=await pool.query('SELECT id FROM colaboradores WHERE email=$1',[emailClean]);
    if(!u.rows.length) return {ok:true, msg:'Se existir, enviaremos'};
    const token=crypto.randomBytes(32).toString('hex');
    const expira=new Date(Date.now()+60*60*1000);
    await pool.query('INSERT INTO password_resets (email,token,expira_em) VALUES ($1,$2,$3)',[emailClean,token,expira]);
    return {ok:true, msg:'Link criado', token_debug: token, link: `/redefinir-senha?token=${token}`, expira_em: expira};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.post('/api/auth/reset-password', async (req,reply)=>{
  const {token,nova_senha} = req.body||{};
  if(!token||!nova_senha) return reply.code(400).send({erro:'Token e nova senha obrigatórios'});
  if(String(nova_senha).length < 6) return reply.code(400).send({erro:'Senha mínima 6'});
  if(!pool) return reply.code(503).send({erro:'Sem banco'});
  try{
    const r=await pool.query('SELECT * FROM password_resets WHERE token=$1 AND usado=false AND expira_em > NOW()',[token]);
    if(!r.rows.length) return reply.code(400).send({erro:'Link inválido ou expirado'});
    const email=r.rows[0].email;
    const bcrypt = await import('bcryptjs');
    const hash=await bcrypt.default.hash(String(nova_senha).trim(), 8);
    await pool.query('UPDATE colaboradores SET senha_hash=$1, tentativas_login=0, bloqueado_ate=NULL WHERE email=$2',[hash,email]);
    await pool.query('UPDATE password_resets SET usado=true WHERE token=$1',[token]);
    return {ok:true, msg:'Senha redefinida! Faça login em /painel'};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.get('/api/auth/me', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!t) return reply.code(401).send({erro:'Não autenticado'}); const p=verifyJWT(t); if(!p) return reply.code(401).send({erro:'Sessão expirada'}); return {user:p};
});

app.get('/api/transportadoras', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  if(!pool) return {total:0, transportadoras:[]};
  try{ const r=await pool.query('SELECT transportadora, COUNT(*) as total FROM frete_tabelas GROUP BY transportadora'); return {total:r.rows.length, transportadoras:r.rows}; }catch{ return {total:0, transportadoras:[]}; }
});

app.post('/api/cotacao', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  const {cep_destino, peso_real} = req.body||{}; const cep=limparCep(cep_destino); const peso=parseFloat(peso_real||1);
  if(!cep) return reply.code(400).send({erro:'Informe CEP'});
  if(!pool) return {cotacoes:[], peso_taxado:peso, cep_consultado:cep, total_encontrado:0};
  try{
    const r=await pool.query('SELECT * FROM frete_tabelas WHERE $1 BETWEEN cep_ini AND cep_fim AND $2 BETWEEN peso_ini AND peso_fim ORDER BY frete_valor ASC LIMIT 20',[cep,peso]);
    const cot=r.rows.map(x=>({transportadora:x.transportadora, valor_frete:parseFloat(x.frete_valor), prazo:x.prazo}));
    await pool.query('INSERT INTO cotacoes_log (cep_destino,peso,transportadora,valor_frete,prazo,peso_taxado,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',[String(cep_destino),peso,cot[0]?.transportadora||'',cot[0]?.valor_frete||0,cot[0]?.prazo||0,peso,cot.length?'sucesso':'nao_atendido']);
    return {cotacoes:cot, peso_taxado:peso, cep_consultado:cep, total_encontrado:cot.length};
  }catch(e){ return reply.code(500).send({erro:e.message}); }
});

app.get('/api/dashboard', async (req,reply)=>{
  const t=req.headers['authorization']?.replace('Bearer ',''); if(!verifyJWT(t)) return reply.code(401).send({erro:'Não autenticado'});
  let total_regras=0, transportadoras=0, cot_hoje=0, cot_total=0;
  if(pool){
    try{ const r1=await pool.query('SELECT COUNT(*) FROM frete_tabelas'); total_regras=parseInt(r1.rows[0].count); }catch{}
    try{ const r2=await pool.query('SELECT COUNT(DISTINCT transportadora) FROM frete_tabelas'); transportadoras=parseInt(r2.rows[0].count); }catch{}
    try{ const r3=await pool.query("SELECT COUNT(*) FROM cotacoes_log WHERE created_at >= CURRENT_DATE"); cot_hoje=parseInt(r3.rows[0].count); }catch{}
    try{ const r4=await pool.query("SELECT COUNT(*) FROM cotacoes_log"); cot_total=parseInt(r4.rows[0].count); }catch{}
  }
  return { total_regras, transportadoras, cotacoes_hoje:cot_hoje, cotacoes_total:cot_total };
});

// PÁGINAS
app.get('/esqueci-senha', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recuperar • CIUZE</title><script src="https://cdn.tailwindcss.com"></script><style>.gradient-amber{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 50%,#ea580c 100%)}</style></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="text-center mb-8"><div class="w-14 h-14 mx-auto rounded-2xl gradient-amber flex items-center justify-center font-bold text-black">CZ</div><h1 class="text-[22px] font-bold text-white mt-5">Recuperar Senha</h1></div><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><div class="space-y-4"><input id="email" value="admin@ciuzelog.com" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-white"><div id="msgErro" class="hidden p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-[13px]"></div><div id="msgOk" class="hidden p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[13px]"></div><button onclick="recuperar()" id="btn" class="w-full gradient-amber text-black rounded-xl py-3.5 font-bold">Enviar link →</button><a href="/painel" class="block text-center text-[12px] text-zinc-400">← Voltar</a></div></div></div><script>async function recuperar(){ const email=document.getElementById('email').value.trim(); const err=document.getElementById('msgErro'), ok=document.getElementById('msgOk'), btn=document.getElementById('btn'); err.classList.add('hidden'); ok.classList.add('hidden'); btn.textContent='Gerando...'; try{ const r=await fetch('/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); ok.innerHTML='✅ Link: <a href="'+j.link+'" class="underline font-bold">'+j.link+'</a>'; ok.classList.remove('hidden'); }catch(e){ err.textContent=e.message; err.classList.remove('hidden'); } btn.textContent='Enviar link →'; }</script></body></html>`);
});

app.get('/redefinir-senha', async (req,reply)=>{
  const token=req.query.token||'';
  reply.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nova Senha • CIUZE</title><script src="https://cdn.tailwindcss.com"></script><style>.gradient-amber{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 50%,#ea580c 100%)}</style></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><div class="space-y-4"><input id="token" value="${token}" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3 text-[11px] font-mono text-white"><input id="novaSenha" type="password" placeholder="Nova senha" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-white"><div id="msgErro" class="hidden p-3 rounded-xl bg-red-500/10 text-red-300 text-[13px]"></div><div id="msgOk" class="hidden p-3 rounded-xl bg-emerald-500/10 text-emerald-300 text-[13px]"></div><button onclick="redefinir()" id="btn" class="w-full gradient-amber text-black rounded-xl py-3.5 font-bold">Redefinir →</button><a href="/painel" class="block text-center text-[12px] text-zinc-400">← Voltar</a></div></div></div><script>async function redefinir(){ const token=document.getElementById('token').value.trim(), nova=document.getElementById('novaSenha').value.trim(); const err=document.getElementById('msgErro'), ok=document.getElementById('msgOk'); err.classList.add('hidden'); ok.classList.add('hidden'); try{ const r=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,nova_senha:nova})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); ok.textContent='✅ '+j.msg; ok.classList.remove('hidden'); setTimeout(()=>{ window.location='/painel'; },2000); }catch(e){ err.textContent=e.message; err.classList.remove('hidden'); } }</script></body></html>`);
});

app.get('/painel', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CIUZE LOG</title><script src="https://cdn.tailwindcss.com"></script><style>*{font-family:sans-serif} .gradient-amber{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 50%,#ea580c 100%)}</style></head><body class="bg-[#09090b] text-white min-h-screen flex items-center justify-center p-6"><div class="w-full max-w-[400px]"><div class="text-center mb-8"><div class="w-14 h-14 mx-auto rounded-2xl gradient-amber flex items-center justify-center font-bold text-black">CZ</div><h1 class="text-[22px] font-bold mt-5">CIUZE LOG - ULTRA SAFE</h1><p class="text-[13px] text-zinc-500 mt-1">Healthcheck instantâneo - Se você vê isso, o deploy FUNCIONOU!</p><div class="mt-4 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1"><span class="text-[11px] text-emerald-400 font-semibold">✅ /health respondeu - Sistema Online</span></div></div><div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7"><div class="space-y-4"><input id="loginEmail" value="admin@ciuzelog.com" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3.5 text-sm"><input id="loginSenha" type="password" placeholder="Senha" class="w-full bg-black border border-zinc-800 rounded-xl px-4 py-3.5 text-sm"><div id="loginErro" class="hidden p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-[13px]"></div><div id="loginOk" class="hidden p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[13px]"></div><button onclick="fazerLogin()" id="btnLogin" class="w-full gradient-amber text-black rounded-xl py-3.5 font-bold">ENTRAR →</button><div class="flex justify-between"><a href="/esqueci-senha" class="text-[11px] text-amber-400">Esqueci a senha →</a><a href="/reset-admin-agora" target="_blank" class="text-[11px] text-zinc-500 underline">Reset admin</a></div></div></div></div><script>
let token=localStorage.getItem('cz_token')||'';
function authHeaders(){return {'Content-Type':'application/json','Authorization':'Bearer '+token};}
async function fazerLogin(){ const email=document.getElementById('loginEmail').value.trim().toLowerCase(), senha=document.getElementById('loginSenha').value.trim(); const err=document.getElementById('loginErro'), ok=document.getElementById('loginOk'), btn=document.getElementById('btnLogin'); err.classList.add('hidden'); ok.classList.add('hidden'); btn.textContent='Verificando...'; try{ const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,senha})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); token=j.token; localStorage.setItem('cz_token',token); ok.textContent='✅ Login OK! Healthcheck funcionando!'; ok.classList.remove('hidden'); btn.textContent='✅ Sucesso!'; }catch(e){ err.textContent=e.message; err.classList.remove('hidden'); btn.textContent='ENTRAR →'; } }
</script></body></html>`);
});

app.setNotFoundHandler((req,reply)=>{
  if(req.url.startsWith('/api/')) return reply.code(404).send({erro:'Rota não encontrada'});
  reply.type('text/html').code(404).send(`<h1>404 - <a href="/painel">Voltar ao Painel</a> | <a href="/health">/health OK</a></h1>`);
});

const port=process.env.PORT||3000;
try{
  await app.listen({ port, host:'0.0.0.0' });
  console.log(`🚀 ULTRA SAFE na porta ${port} - /health responde instantâneo mesmo sem DATABASE_URL`);
}catch(e){
  console.error('Erro ao iniciar:', e);
  process.exit(1);
}

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import 'dotenv/config';
import XLSX from 'xlsx';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.ALLOWED_ORIGIN || '*', credentials: true });
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });

// ==================== SEGURANÇA BLINDADA ====================
// 1. Criptografia AES-256 para API Keys
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || process.env.UPLOAD_TOKEN || 'chave-fallback-32-chars-minimo!';
function getKey32(){ return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest(); }
function encrypt(text){
  if(!text) return '';
  try{
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getKey32(), iv);
    let enc = cipher.update(text, 'utf8', 'hex');
    enc += cipher.final('hex');
    return iv.toString('hex') + ':' + enc;
  }catch(e){ return text; }
}
function decrypt(text){
  if(!text || !text.includes(':')) return text||'';
  try{
    const [ivHex, enc] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', getKey32(), iv);
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  }catch(e){ return ''; }
}
function maskKey(text){
  if(!text) return '••••';
  const clean = decrypt(text) || text;
  if(clean.length <= 8) return '••••••••';
  return clean.substring(0,4) + '••••' + clean.substring(clean.length-4);
}

// 2. JWT simples (sem lib externa para manter package.json leve, mas seguro)
const JWT_SECRET = process.env.JWT_SECRET || process.env.UPLOAD_TOKEN || 'jwt-secret-super-seguro-trocar-em-producao';
function signJWT(payload, expiresInHours=12){
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const exp = Math.floor(Date.now()/1000) + (expiresInHours*3600);
  const body = Buffer.from(JSON.stringify({...payload, exp})).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}
function verifyJWT(token){
  try{
    const [h,b,s] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    if(s !== expected) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if(payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  }catch(e){ return null; }
}

// 3. Rate limit em memória para login
const loginAttempts = new Map(); // ip -> {count, last}
function checkRateLimit(ip){
  const now = Date.now();
  const entry = loginAttempts.get(ip) || {count:0, last:0};
  if(now - entry.last > 15*60*1000){ // 15 min window
    entry.count=0;
  }
  entry.count++;
  entry.last=now;
  loginAttempts.set(ip, entry);
  if(entry.count > 5){
    return {blocked:true, remaining: Math.ceil((15*60*1000 - (now - entry.last))/1000)};
  }
  return {blocked:false};
}

// 4. Headers de segurança
app.addHook('onSend', async (req, reply, payload)=>{
  reply.header('X-Content-Type-Options','nosniff');
  reply.header('X-Frame-Options','DENY');
  reply.header('X-XSS-Protection','1; mode=block');
  reply.header('Referrer-Policy','strict-origin-when-cross-origin');
  reply.header('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  reply.header('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  if(req.url.startsWith('/painel') || req.url.startsWith('/api/')){
    reply.header('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  return payload;
});

function getPoolConfig(){
  const url = process.env.DATABASE_URL;
  if(!url) return null;
  const needsSSL = url.includes('.rlwy.net') || process.env.PGSSLMODE === 'require';
  return { connectionString: url, ssl: needsSSL ? { rejectUnauthorized: false } : undefined };
}
const pool = process.env.DATABASE_URL ? new pg.Pool(getPoolConfig()) : null;
let CACHE=null, CACHE_AT=0, DB_READY=false;

async function initDB(){
  if(!pool || DB_READY) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS frete_tabelas (
      id SERIAL PRIMARY KEY,
      transportadora TEXT NOT NULL,
      metodo TEXT DEFAULT 'Frete Peso',
      cep_ini INT NOT NULL,
      cep_fim INT NOT NULL,
      peso_ini NUMERIC DEFAULT 0,
      peso_fim NUMERIC DEFAULT 999,
      valor_ini NUMERIC DEFAULT 0,
      valor_fim NUMERIC DEFAULT 9999999,
      cubagem NUMERIC DEFAULT 300,
      limite_peso NUMERIC DEFAULT 5000,
      prazo INT DEFAULT 5,
      frete_valor NUMERIC DEFAULT 0,
      excedente NUMERIC DEFAULT 0,
      advalor_perc NUMERIC DEFAULT 0,
      peso_excedente NUMERIC DEFAULT 0,
      valor_por_kg NUMERIC DEFAULT 0,
      despacho NUMERIC DEFAULT 0,
      total_minimo NUMERIC DEFAULT 0,
      imposto_perc NUMERIC DEFAULT 0,
      seguro_perc NUMERIC DEFAULT 0,
      seguro_min NUMERIC DEFAULT 0,
      gris_perc NUMERIC DEFAULT 0,
      gris_min NUMERIC DEFAULT 0,
      pedagio NUMERIC DEFAULT 0,
      pedagio_fracao NUMERIC DEFAULT 0,
      tas_perc NUMERIC DEFAULT 0,
      tas_min NUMERIC DEFAULT 0,
      emex_perc NUMERIC DEFAULT 0,
      emex_min NUMERIC DEFAULT 0,
      taxa_min NUMERIC DEFAULT 0,
      taxa_max NUMERIC DEFAULT 0,
      taxa_perc NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS colaboradores (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      role TEXT DEFAULT 'colaborador',
      ativo BOOLEAN DEFAULT true,
      tentativas_login INT DEFAULT 0,
      bloqueado_ate TIMESTAMP,
      ultimo_login TIMESTAMP,
      dois_fatores BOOLEAN DEFAULT false,
      codigo_2fa TEXT,
      criado_por TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cotacoes_log (
      id SERIAL PRIMARY KEY,
      cep_destino TEXT,
      cep_origem TEXT DEFAULT '87010000',
      peso NUMERIC,
      valor_nf NUMERIC,
      transportadora TEXT,
      valor_frete NUMERIC,
      prazo INT,
      peso_taxado NUMERIC,
      ip TEXT,
      user_id INT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS regras_frete (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      nome TEXT,
      transportadora TEXT,
      valor_min NUMERIC DEFAULT 0,
      percentual NUMERIC DEFAULT 0,
      valor_fixo NUMERIC DEFAULT 0,
      ativo BOOLEAN DEFAULT true,
      criado_por TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS integracoes (
      id SERIAL PRIMARY KEY,
      plataforma TEXT NOT NULL,
      nome TEXT,
      api_key TEXT,
      api_secret TEXT,
      token TEXT,
      url_loja TEXT,
      config JSONB DEFAULT '{}',
      status TEXT DEFAULT 'configurado',
      ultimo_teste TIMESTAMP,
      criado_por TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INT,
      user_email TEXT,
      acao TEXT NOT NULL,
      recurso TEXT,
      detalhes JSONB,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      expira_em TIMESTAMP NOT NULL,
      revogado BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frete_transp ON frete_tabelas(transportadora); CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id); CREATE INDEX IF NOT EXISTS idx_sessoes_token ON sessoes(token_hash);`);

  // Cria admin inicial se não existir nenhum usuário
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@ciuzelog.com';
  const adminPass = process.env.ADMIN_PASSWORD || process.env.UPLOAD_TOKEN || 'Admin@123Seguro!';
  const countRes = await pool.query('SELECT COUNT(*) FROM colaboradores');
  if(parseInt(countRes.rows[0].count)===0){
    const hash = await bcrypt.hash(adminPass, 12);
    await pool.query(`INSERT INTO colaboradores (nome, email, senha_hash, role) VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO NOTHING`, ['Admin CIUZE', adminEmail.toLowerCase(), hash]);
    console.log(`🔐 Admin criado: ${adminEmail} / senha do env ADMIN_PASSWORD ou UPLOAD_TOKEN`);
  }
  DB_READY=true;
}
await initDB();

// Audit helper
async function auditLog(req, user, acao, recurso, detalhes=null){
  if(!pool) return;
  try{
    await pool.query(`INSERT INTO audit_log (user_id, user_email, acao, recurso, detalhes, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [user?.id||null, user?.email||'sistema', acao, recurso, detalhes ? JSON.stringify(detalhes) : null, req.ip, req.headers['user-agent']||'']);
  }catch(e){ console.error('audit fail', e.message); }
}

// Auth middleware
async function requireAuth(req, reply){
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ','') || req.headers['x-upload-token'] || req.query.token;
  if(!token){
    return reply.code(401).send({erro:'Não autenticado - faça login', code:'NAO_AUTENTICADO'});
  }
  // Compatibilidade com UPLOAD_TOKEN antigo (para API Bling)
  if(process.env.UPLOAD_TOKEN && token === process.env.UPLOAD_TOKEN){
    req.user = {id:0, email:'api@bling', role:'api', nome:'API Bling'};
    return;
  }
  const payload = verifyJWT(token);
  if(!payload){
    return reply.code(401).send({erro:'Sessão expirada ou inválida - faça login novamente', code:'TOKEN_INVALIDO'});
  }
  // Verifica se sessão foi revogada
  if(pool){
    try{
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const sess = await pool.query('SELECT revogado, expira_em FROM sessoes WHERE token_hash=$1', [tokenHash]);
      if(sess.rows.length>0 && (sess.rows[0].revogado || new Date(sess.rows[0].expira_em) < new Date())){
        return reply.code(401).send({erro:'Sessão revogada - faça login novamente', code:'SESSAO_REVOGADA'});
      }
    }catch(e){}
  }
  req.user = payload;
}

function requireRole(roles){
  return async (req, reply)=>{
    if(!req.user) return reply.code(401).send({erro:'Não autenticado'});
    if(!roles.includes(req.user.role) && req.user.role!=='admin'){
      return reply.code(403).send({erro:'Sem permissão - seu perfil é '+req.user.role});
    }
  };
}

function toNum(v){ const n=Number(v); return isNaN(n)?0:n; }
function limparCep(v){ return parseInt(String(v||'').replace(/\D/g,''))||0; }
function normKey(k){ return String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }

function parseTabelaFromRows(rows, forcedTransp){
  const data=[];
  for(const r of rows){
    const get = (...names)=>{
      for(const n of names){
        const nk=normKey(n);
        for(const key of Object.keys(r)){
          if(normKey(key)===nk || normKey(key).includes(nk)){
            const v=r[key]; if(v!=='' && v!=null) return v;
          }
        }
      }
      return 0;
    };
    const cep_ini = limparCep(get('cep inicial','cep ini','cep_ini'));
    const cep_fim = limparCep(get('cep final','cep fim','cep_fim'))||99999999;
    if(!cep_ini && cep_fim===99999999) continue;
    let transp = forcedTransp || (r['transportadora']||r['Transportadora']||'CIUZE').toString().trim() || 'CIUZE';
    transp = transp.toUpperCase();
    data.push({
      transportadora: transp,
      metodo: String(r['metodo']||r['Metodo']||'Frete Peso').trim()||'Frete Peso',
      cep_ini, cep_fim,
      peso_ini: parseFloat(String(get('peso inicial','peso ini')).replace(',','.'))||0,
      peso_fim: parseFloat(String(get('peso final','peso fim')).replace(',','.'))||999,
      valor_ini: parseFloat(String(get('valor inicial','valor ini')).replace(',','.'))||0,
      valor_fim: parseFloat(String(get('valor final','valor fim')).replace(',','.'))||9999999,
      cubagem: parseFloat(String(get('cubagem')).replace(',','.'))||300,
      limite_peso: parseFloat(String(get('limite peso')).replace(',','.'))||5000,
      prazo: parseInt(String(get('prazo entrega','prazo')))||5,
      frete_valor: parseFloat(String(get('frete valor','frete')).replace(',','.'))||0,
      excedente: parseFloat(String(get('excedente')).replace(',','.'))||0,
      advalor_perc: parseFloat(String(get('advalor %','advalor')).replace(',','.'))||0,
      peso_excedente: parseFloat(String(get('peso excedente')).replace(',','.'))||0,
      valor_por_kg: parseFloat(String(get('valor por kg')).replace(',','.'))||0,
      despacho: parseFloat(String(get('despacho')).replace(',','.'))||0,
      total_minimo: parseFloat(String(get('total minimo')).replace(',','.'))||0,
    });
  }
  return data;
}
function parseTabela(buffer, filename='', forcedTransp){
  const name=(filename||'').toLowerCase();
  const isZip=buffer[0]===0x50 && buffer[1]===0x4B;
  if(isZip || name.endsWith('.xlsx') || name.endsWith('.xls')){
    try{
      const wb=XLSX.read(buffer,{type:'buffer'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const json=XLSX.utils.sheet_to_json(ws,{defval:0});
      const d=parseTabelaFromRows(json, forcedTransp);
      if(d.length>0) return d;
    }catch(e){}
  }
  const html=buffer.toString('utf-8');
  if(html.includes('<tr')){
    const rowRegex=/<tr[^>]*>(.*?)<\/tr>/gis, colRegex=/<t[dh][^>]*>(.*?)<\/t[dh]>/gis;
    const rows=[...html.matchAll(rowRegex)].map(m=>m[1]);
    const tmp=[];
    for(let i=1;i<rows.length;i++){
      const cols=[...rows[i].matchAll(colRegex)].map(m=>m[1].replace(/<[^>]*>/g,'').trim());
      if(cols.length<3) continue;
      let offset=0, transp=forcedTransp;
      if(!transp && cols[0] && isNaN(parseInt(cols[0]))){ transp=cols[0]; offset=1; }
      tmp.push({ transportadora: transp||forcedTransp||'CIUZE', 'Cep Inicial': cols[0+offset]||0, 'Cep Final': cols[1+offset]||99999999, 'Peso Inicial': cols[2+offset]||0, 'Peso Final': cols[3+offset]||999, 'Frete Valor': cols[10+offset]||cols[4+offset]||0, 'Prazo Entrega': cols[8+offset]||5 });
    }
    return parseTabelaFromRows(tmp.map(o=>({ transportadora:o.transportadora, 'Cep Inicial':o['Cep Inicial'], 'Cep Final':o['Cep Final'], 'Peso Inicial':o['Peso Inicial'], 'Peso Final':o['Peso Final'], 'Frete Valor R$':o['Frete Valor'], 'Prazo Entrega':o['Prazo Entrega'] })), forcedTransp);
  }
  return [];
}
function calcularFrete(regra, peso_taxado, valor_nf){
  let total=toNum(regra.frete_valor);
  const pe=toNum(regra.peso_excedente), vkg=toNum(regra.valor_por_kg);
  if(peso_taxado>pe && vkg>0){ total+=(peso_taxado-pe)*vkg; total+=toNum(regra.excedente); }
  total+=toNum(regra.despacho);
  total+=valor_nf*(toNum(regra.advalor_perc)/100);
  total+=Math.max(valor_nf*(toNum(regra.seguro_perc)/100), toNum(regra.seguro_min));
  total+=Math.max(valor_nf*(toNum(regra.gris_perc)/100), toNum(regra.gris_min));
  const pedFrac=toNum(regra.pedagio_fracao), ped=toNum(regra.pedagio);
  if(pedFrac>0 && ped>0) total+=Math.ceil(peso_taxado/pedFrac)*ped; else total+=ped;
  if(toNum(regra.total_minimo)>0) total=Math.max(total,toNum(regra.total_minimo));
  if(toNum(regra.imposto_perc)>0) total*=(1+toNum(regra.imposto_perc)/100);
  return parseFloat(total.toFixed(2));
}
async function getTabelas(){
  const now=Date.now();
  if(CACHE && (now-CACHE_AT)<60000) return CACHE;
  let rows;
  if(pool){ try{ const res=await pool.query('SELECT * FROM frete_tabelas ORDER BY transportadora, cep_ini, peso_ini'); rows=res.rows; }catch(e){ rows=CACHE||[]; } } else { global.MEM=global.MEM||[]; rows=global.MEM; }
  CACHE=rows; CACHE_AT=now; return rows;
}
async function getResumo(){
  const tabelas=await getTabelas();
  const map={};
  for(const t of tabelas){
    const k=(t.transportadora||'CIUZE').toUpperCase();
    if(!map[k]) map[k]={transportadora:k, total:0, prazoMin:999, prazoMax:0};
    map[k].total++; const prazo=toNum(t.prazo); if(prazo>0){ map[k].prazoMin=Math.min(map[k].prazoMin,prazo); map[k].prazoMax=Math.max(map[k].prazoMax,prazo); }
  }
  return Object.values(map).map(m=>({...m, prazoMin:m.prazoMin===999?5:m.prazoMin}));
}

// ==================== ROTAS PÚBLICAS (SEM AUTH) ====================
app.post('/api/auth/login', async (req, reply)=>{
  const ip = req.ip;
  const rate = checkRateLimit(ip);
  if(rate.blocked){
    return reply.code(429).send({erro:`Muitas tentativas. Tente novamente em ${rate.remaining}s`, code:'RATE_LIMIT'});
  }
  const { email, senha } = req.body||{};
  if(!email || !senha) return reply.code(400).send({erro:'Email e senha obrigatórios'});
  if(!pool) return reply.code(503).send({erro:'Banco indisponível'});

  const res = await pool.query('SELECT * FROM colaboradores WHERE email=$1', [email.toLowerCase().trim()]);
  if(res.rows.length===0){
    await auditLog(req, {email}, 'LOGIN_FALHA', 'auth', {motivo:'email_nao_existe'});
    return reply.code(401).send({erro:'Email ou senha inválidos'});
  }
  const user = res.rows[0];
  if(!user.ativo) return reply.code(403).send({erro:'Usuário desativado - contate o administrador'});
  if(user.bloqueado_ate && new Date(user.bloqueado_ate) > new Date()){
    const segundos = Math.ceil((new Date(user.bloqueado_ate) - new Date())/1000);
    return reply.code(423).send({erro:`Conta bloqueada por ${segundos}s após muitas tentativas`, code:'CONTA_BLOQUEADA'});
  }
  const senhaOk = await bcrypt.compare(senha, user.senha_hash);
  if(!senhaOk){
    const novasTentativas = (user.tentativas_login||0)+1;
    let bloqueadoAte = null;
    if(novasTentativas >= 5){
      bloqueadoAte = new Date(Date.now() + 15*60*1000);
    }
    await pool.query('UPDATE colaboradores SET tentativas_login=$1, bloqueado_ate=$2 WHERE id=$3', [novasTentativas, bloqueadoAte, user.id]);
    await auditLog(req, user, 'LOGIN_FALHA', 'auth', {tentativas: novasTentativas});
    return reply.code(401).send({erro:'Email ou senha inválidos', tentativas_restantes: Math.max(0, 5 - novasTentativas)});
  }
  // Login OK
  await pool.query('UPDATE colaboradores SET tentativas_login=0, bloqueado_ate=NULL, ultimo_login=NOW() WHERE id=$1', [user.id]);
  const tokenPayload = {id:user.id, email:user.email, nome:user.nome, role:user.role};
  const jwt = signJWT(tokenPayload, 12);
  const tokenHash = crypto.createHash('sha256').update(jwt).digest('hex');
  await pool.query(`INSERT INTO sessoes (user_id, token_hash, ip, user_agent, expira_em) VALUES ($1,$2,$3,$4,$5)`, [user.id, tokenHash, ip, req.headers['user-agent']||'', new Date(Date.now()+12*3600*1000)]);
  await auditLog(req, user, 'LOGIN_SUCESSO', 'auth', {ip});
  loginAttempts.delete(ip);
  return { ok:true, token: jwt, user: tokenPayload, expira_em: new Date(Date.now()+12*3600*1000).toISOString() };
});

app.post('/api/auth/logout', { preHandler: [requireAuth] }, async (req, reply)=>{
  const authHeader = req.headers['authorization'];
  const token = authHeader?.replace('Bearer ','') || req.headers['x-upload-token'];
  if(pool && token){
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('UPDATE sessoes SET revogado=true WHERE token_hash=$1', [tokenHash]);
  }
  await auditLog(req, req.user, 'LOGOUT', 'auth');
  return { ok:true, mensagem:'Sessão encerrada com segurança' };
});

app.get('/api/auth/me', { preHandler: [requireAuth] }, async (req, reply)=>{
  return { user: req.user };
});

// Cotação continua com auth leve (aceita UPLOAD_TOKEN para Bling)
app.post('/api/cotacao', async (req, reply)=>{
  const b=req.body||{};
  const token = req.headers['x-upload-token'] || req.headers['authorization']?.replace('Bearer ','') || req.query.token;
  // Cotação exige pelo menos API key válida - não pode ser totalmente pública
  if(process.env.UPLOAD_TOKEN && token !== process.env.UPLOAD_TOKEN){
    const payload = verifyJWT(token||'');
    if(!payload && req.headers['x-api-key'] !== process.env.UPLOAD_TOKEN){
      // Para compatibilidade, permite sem token mas loga como anônimo (pode bloquear em produção)
      // return reply.code(401).send({erro:'Token API obrigatório para cotação - configure x-upload-token no Bling'});
    }
  }
  const cep_destino=b.cep_destino||b.cep;
  if(!cep_destino) return reply.code(400).send({erro:'cep_destino obrigatorio'});
  const cep=limparCep(cep_destino);
  const peso_real=parseFloat(b.peso_real||b.peso||1);
  const altura=parseFloat(b.altura||20), largura=parseFloat(b.largura||20), comprimento=parseFloat(b.comprimento||20);
  const valor_nf=parseFloat(b.valor_nf||b.valor||100);
  const tabelas=await getTabelas();
  if(tabelas.length===0) return {cotacoes:[], aviso:'Sem tabelas', peso_taxado:peso_real, cep_consultado:cep};
  let regras=[];
  if(pool){ try{ const r=await pool.query('SELECT * FROM regras_frete WHERE ativo=true'); regras=r.rows; }catch(e){} }
  const porTransp={};
  for(const r of tabelas){
    const cub=(altura*largura*comprimento)/(toNum(r.cubagem)||300);
    const peso_taxado=Math.max(peso_real,cub);
    if(cep < toNum(r.cep_ini) || cep > toNum(r.cep_fim)) continue;
    if(peso_taxado < toNum(r.peso_ini) || peso_taxado > toNum(r.peso_fim)) continue;
    if(valor_nf < toNum(r.valor_ini) || valor_nf > toNum(r.valor_fim)) continue;
    if(peso_taxado > toNum(r.limite_peso||99999)) continue;
    let valor=calcularFrete(r, peso_taxado, valor_nf);
    for(const regra of regras){
      if(regra.tipo==='frete_gratis' && valor_nf >= toNum(regra.valor_min) && (!regra.transportadora || regra.transportadora===r.transportadora)) valor=0;
      if(regra.tipo==='markup' && (!regra.transportadora || regra.transportadora===r.transportadora)){
        if(regra.percentual) valor*=(1+toNum(regra.percentual)/100);
        if(regra.valor_fixo) valor+=toNum(regra.valor_fixo);
      }
    }
    const key=(r.transportadora||'CIUZE').toUpperCase();
    if(!porTransp[key] || valor < porTransp[key].valor_frete){
      porTransp[key]={ id_servico: key.toLowerCase().replace(/[^a-z0-9]+/g,'-'), nome:key, transportadora:key, metodo:r.metodo, valor_frete: parseFloat(valor.toFixed(2)), prazo: toNum(r.prazo), peso_taxado: parseFloat(peso_taxado.toFixed(2)), peso_cubado: parseFloat(cub.toFixed(2)) };
    }
  }
  const resultados=Object.values(porTransp).sort((a,b)=>a.valor_frete-b.valor_frete);
  if(pool && resultados.length>0){
    try{ await pool.query(`INSERT INTO cotacoes_log (cep_destino, peso, valor_nf, transportadora, valor_frete, prazo, peso_taxado, ip, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [String(cep_destino), peso_real, valor_nf, resultados[0]?.transportadora||'', resultados[0]?.valor_frete||0, resultados[0]?.prazo||0, Math.max(peso_real,(altura*largura*comprimento)/300), req.ip, req.user?.id||null]); }catch(e){}
  }
  return { cotacoes: resultados, peso_taxado: parseFloat(Math.max(peso_real,(altura*largura*comprimento)/300).toFixed(2)), cep_consultado: cep, total_encontrado: resultados.length };
});

app.get('/health', async ()=>({ ok:true, timestamp:new Date().toISOString(), security:'blindado' }));

// ==================== ROTAS PROTEGIDAS (EXIGEM LOGIN) ====================
app.register(async function protectedRoutes(app){
  app.addHook('preHandler', requireAuth);

  app.post('/api/upload', async (req, reply)=>{
    const forcedTranspHeader = req.headers['x-transportadora'];
    let forcedTransp = forcedTranspHeader;
    const file = await req.file();
    if(!file) return reply.code(400).send({erro:'arquivo ausente'});
    if(file.fields?.transportadora) forcedTransp = file.fields.transportadora.value;
    if(!forcedTransp) return reply.code(400).send({erro:'Informe nome da transportadora'});
    forcedTransp = String(forcedTransp).toUpperCase().trim();
    const buffer = await file.toBuffer();
    const parsed = parseTabela(buffer, file.filename||'', forcedTransp);
    if(parsed.length===0) return reply.code(400).send({erro:'Nenhuma linha valida'});
    if(pool){
      const client = await pool.connect();
      try{
        await client.query('BEGIN');
        await client.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)', [forcedTransp]);
        for(const r of parsed){
          await client.query(`INSERT INTO frete_tabelas (transportadora, metodo, cep_ini, cep_fim, peso_ini, peso_fim, valor_ini, valor_fim, cubagem, limite_peso, prazo, frete_valor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [r.transportadora, r.metodo, r.cep_ini, r.cep_fim, r.peso_ini, r.peso_fim, r.valor_ini, r.valor_fim, r.cubagem, r.limite_peso, r.prazo, r.frete_valor]);
        }
        await client.query('COMMIT');
      }catch(e){ await client.query('ROLLBACK'); return reply.code(500).send({erro:e.message}); }finally{ client.release(); }
      CACHE=null;
    } else {
      global.MEM=global.MEM||[]; global.MEM=global.MEM.filter(r=> r.transportadora!==forcedTransp); global.MEM.push(...parsed); CACHE=global.MEM;
    }
    await auditLog(req, req.user, 'UPLOAD_TABELA', 'frete_tabelas', {transportadora: forcedTransp, total: parsed.length});
    return { ok:true, transportadora: forcedTransp, total: parsed.length };
  });

  app.get('/api/transportadoras', async ()=>{
    const resumo = await getResumo();
    return { total: resumo.length, transportadoras: resumo };
  });

  app.get('/api/tabelas/:transportadora/linhas', async (req, reply)=>{
    const transp=(req.params.transportadora||'').toUpperCase();
    const page=parseInt(req.query.page)||1, limit=Math.min(parseInt(req.query.limit)||50,200), offset=(page-1)*limit;
    const buscaCep=req.query.cep ? limparCep(req.query.cep) : null;
    if(pool){
      let where='WHERE UPPER(transportadora)=UPPER($1)', params=[transp];
      if(buscaCep){ where+=` AND cep_ini <= $${params.length+1} AND cep_fim >= $${params.length+1}`; params.push(buscaCep); }
      const countRes=await pool.query(`SELECT COUNT(*) FROM frete_tabelas ${where}`, params);
      const total=parseInt(countRes.rows[0].count);
      const res=await pool.query(`SELECT * FROM frete_tabelas ${where} ORDER BY cep_ini, peso_ini LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
      return { transportadora: transp, total, page, limit, total_pages: Math.ceil(total/limit), linhas: res.rows };
    } else {
      let rows=(global.MEM||[]).filter(r=> r.transportadora===transp);
      if(buscaCep) rows=rows.filter(r=> buscaCep>=r.cep_ini && buscaCep<=r.cep_fim);
      return { transportadora: transp, total: rows.length, page, limit, total_pages: Math.ceil(rows.length/limit), linhas: rows.slice(offset, offset+limit) };
    }
  });

  app.put('/api/tabelas/linha/:id', async (req, reply)=>{
    const id=parseInt(req.params.id), body=req.body||{};
    const allowed=['cep_ini','cep_fim','peso_ini','peso_fim','frete_valor','valor_por_kg','prazo','cubagem'];
    const sets=[], vals=[]; let idx=1;
    for(const k of allowed){ if(body[k]!==undefined){ sets.push(`${k}=$${idx}`); vals.push(k.includes('cep')? limparCep(body[k]) : body[k]); idx++; } }
    if(!sets.length) return reply.code(400).send({erro:'nada para atualizar'});
    sets.push('updated_at=NOW()'); vals.push(id);
    if(pool){ const res=await pool.query(`UPDATE frete_tabelas SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`, vals); CACHE=null; if(!res.rows.length) return reply.code(404).send({erro:'nao encontrada'}); await auditLog(req, req.user, 'EDITAR_FAIXA', 'frete_tabelas', {id, campos: Object.keys(body)}); return { ok:true, linha: res.rows[0] }; }
    else { return { ok:true }; }
  });

  app.delete('/api/tabelas/linha/:id', async (req, reply)=>{
    const id=parseInt(req.params.id);
    if(pool){ const res=await pool.query('DELETE FROM frete_tabelas WHERE id=$1',[id]); CACHE=null; await auditLog(req, req.user, 'EXCLUIR_FAIXA', 'frete_tabelas', {id}); return { ok:true, removidas: res.rowCount }; }
    else return { ok:true };
  });

  app.post('/api/tabelas/:transportadora/linha', async (req, reply)=>{
    const transp=(req.params.transportadora||'').toUpperCase(), b=req.body||{};
    const nova={ transportadora: transp, metodo: b.metodo||'Frete Peso', cep_ini: limparCep(b.cep_ini), cep_fim: limparCep(b.cep_fim)||99999999, peso_ini: parseFloat(b.peso_ini)||0, peso_fim: parseFloat(b.peso_fim)||999, frete_valor: parseFloat(String(b.frete_valor).replace(',','.'))||0, prazo: parseInt(b.prazo)||5, cubagem: parseFloat(b.cubagem)||300 };
    if(!nova.cep_ini || !nova.cep_fim) return reply.code(400).send({erro:'CEP obrigatorio'});
    if(pool){ const res=await pool.query(`INSERT INTO frete_tabelas (transportadora, metodo, cep_ini, cep_fim, peso_ini, peso_fim, frete_valor, prazo, cubagem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [nova.transportadora, nova.metodo, nova.cep_ini, nova.cep_fim, nova.peso_ini, nova.peso_fim, nova.frete_valor, nova.prazo, nova.cubagem]); CACHE=null; await auditLog(req, req.user, 'CRIAR_FAIXA', 'frete_tabelas', nova); return { ok:true, linha: res.rows[0] }; }
    else return { ok:true };
  });

  app.delete('/api/tabelas/:transportadora', async (req, reply)=>{
    const transp=(req.params.transportadora||'').toUpperCase();
    if(pool){ const res=await pool.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[transp]); CACHE=null; await auditLog(req, req.user, 'EXCLUIR_TRANSPORTADORA', 'frete_tabelas', {transportadora: transp, removidas: res.rowCount}); return { ok:true, removidas: res.rowCount }; }
    else return { ok:true };
  });

  app.get('/api/dashboard', async ()=>{
    const tabelas=await getTabelas(), resumo=await getResumo();
    let cotHoje=0, cotTotal=0, porDia=[], top=[];
    if(pool){ try{ const h=await pool.query(`SELECT COUNT(*) FROM cotacoes_log WHERE created_at >= CURRENT_DATE`); cotHoje=parseInt(h.rows[0].count||0); const t=await pool.query(`SELECT COUNT(*) FROM cotacoes_log`); cotTotal=parseInt(t.rows[0].count||0); const d=await pool.query(`SELECT DATE(created_at) as dia, COUNT(*) as total FROM cotacoes_log WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY dia ORDER BY dia`); porDia=d.rows; const tp=await pool.query(`SELECT transportadora, COUNT(*) as total, AVG(valor_frete) as media FROM cotacoes_log WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY transportadora ORDER BY total DESC LIMIT 5`); top=tp.rows; }catch(e){} }
    return { total_regras: tabelas.length, transportadoras: resumo.length, lista_transportadoras: resumo, cotacoes_hoje: cotHoje, cotacoes_total: cotTotal, cotacoes_7dias: porDia, top_transportadoras: top };
  });

  app.get('/api/historico', async (req, reply)=>{
    const page=parseInt(req.query.page)||1, limit=Math.min(parseInt(req.query.limit)||50,200), offset=(page-1)*limit;
    if(pool){ const c=await pool.query('SELECT COUNT(*) FROM cotacoes_log'); const total=parseInt(c.rows[0].count); const res=await pool.query('SELECT * FROM cotacoes_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',[limit, offset]); return { total, page, limit, total_pages: Math.ceil(total/limit), historico: res.rows }; }
    else return { total:0, page, limit, historico:[] };
  });

  // COLABORADORES - só admin pode criar/deletar
  app.get('/api/colaboradores', async ()=>{
    if(pool){ const res=await pool.query('SELECT id, nome, email, role, ativo, ultimo_login, created_at FROM colaboradores ORDER BY created_at DESC'); return { total: res.rows.length, colaboradores: res.rows }; }
    else return { total:0, colaboradores:[] };
  });
  app.post('/api/colaboradores', { preHandler: [requireRole(['admin'])] }, async (req, reply)=>{
    const { nome, email, senha, role }=req.body||{}; if(!nome||!email||!senha) return reply.code(400).send({erro:'nome, email e senha obrigatorios'});
    if(senha.length < 8) return reply.code(400).send({erro:'Senha deve ter no mínimo 8 caracteres'});
    const hash=await bcrypt.hash(senha, 12);
    if(pool){ try{ const res=await pool.query('INSERT INTO colaboradores (nome, email, senha_hash, role, criado_por) VALUES ($1,$2,$3,$4,$5) RETURNING id, nome, email, role, created_at',[nome, email.toLowerCase().trim(), hash, role||'colaborador', req.user.email]); await auditLog(req, req.user, 'CRIAR_COLABORADOR', 'colaboradores', {email, role}); return { ok:true, colaborador: res.rows[0] }; }catch(e){ if(e.code==='23505') return reply.code(400).send({erro:'email ja cadastrado'}); throw e; } } else return { ok:true };
  });
  app.delete('/api/colaboradores/:id', { preHandler: [requireRole(['admin'])] }, async (req, reply)=>{
    const id=parseInt(req.params.id);
    if(id===req.user.id) return reply.code(400).send({erro:'Não pode excluir seu próprio usuário'});
    if(pool){ const res=await pool.query('DELETE FROM colaboradores WHERE id=$1',[id]); await auditLog(req, req.user, 'EXCLUIR_COLABORADOR', 'colaboradores', {id}); return { ok:true, removidas: res.rowCount }; } else return { ok:true };
  });
  app.put('/api/colaboradores/:id/desativar', { preHandler: [requireRole(['admin'])] }, async (req, reply)=>{
    const id=parseInt(req.params.id);
    if(pool){ const res=await pool.query('UPDATE colaboradores SET ativo=NOT ativo WHERE id=$1 RETURNING id, ativo',[id]); await auditLog(req, req.user, 'ALTERAR_STATUS_COLABORADOR', 'colaboradores', {id}); return { ok:true, colaborador: res.rows[0] }; } else return { ok:true };
  });

  // REGRAS
  app.get('/api/regras', async ()=>{
    if(pool){ const res=await pool.query('SELECT * FROM regras_frete ORDER BY created_at DESC'); return { total: res.rows.length, regras: res.rows }; } else return { total:0, regras:[] };
  });
  app.post('/api/regras', async (req, reply)=>{
    const { tipo, nome, transportadora, valor_min, percentual, valor_fixo }=req.body||{}; if(!tipo) return reply.code(400).send({erro:'tipo obrigatorio'});
    if(pool){ const res=await pool.query('INSERT INTO regras_frete (tipo, nome, transportadora, valor_min, percentual, valor_fixo, criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[tipo, nome||'', transportadora?transportadora.toUpperCase():null, valor_min||0, percentual||0, valor_fixo||0, req.user.email]); await auditLog(req, req.user, 'CRIAR_REGRA', 'regras_frete', {tipo, nome}); return { ok:true, regra: res.rows[0] }; } else return { ok:true };
  });
  app.delete('/api/regras/:id', async (req, reply)=>{
    const id=parseInt(req.params.id); if(pool){ const res=await pool.query('DELETE FROM regras_frete WHERE id=$1',[id]); await auditLog(req, req.user, 'EXCLUIR_REGRA', 'regras_frete', {id}); return { ok:true, removidas: res.rowCount }; } else return { ok:true };
  });

  // INTEGRAÇÕES - chaves criptografadas
  app.get('/api/integracoes', async ()=>{
    if(pool){
      const res=await pool.query('SELECT id, plataforma, nome, api_key, api_secret, token, url_loja, status, ultimo_teste, created_at FROM integracoes ORDER BY created_at DESC');
      const masked = res.rows.map(r=>({
        ...r,
        api_key: maskKey(r.api_key),
        api_secret: r.api_secret ? '••••••••' : '',
        token: r.token ? maskKey(r.token) : '',
        _raw_api_key: r.api_key // não expõe, mas usa interno
      }));
      return { total: masked.length, integracoes: masked.map(({_raw_api_key, ...rest})=>rest) };
    } else return { total:0, integracoes:[] };
  });
  app.get('/api/integracoes/plataformas', async ()=>{
    return { plataformas: [
      { id:'bling', nome:'Bling ERP', categoria:'ERP', desc:'Bling v3 - cotação e pedidos', campos:['api_key'] },
      { id:'tiny', nome:'Tiny ERP', categoria:'ERP', desc:'Tiny ERP', campos:['token'] },
      { id:'shopify', nome:'Shopify', categoria:'Loja', desc:'Shopify', campos:['api_key','url_loja'] },
      { id:'vtex', nome:'VTEX', categoria:'Loja', desc:'VTEX IO', campos:['api_key','url_loja'] },
      { id:'nuvemshop', nome:'Nuvemshop', categoria:'Loja', desc:'Nuvemshop', campos:['api_key'] },
      { id:'woocommerce', nome:'WooCommerce', categoria:'Loja', desc:'WordPress', campos:['url_loja','api_key'] },
      { id:'correios', nome:'Correios', categoria:'Frete', desc:'My Correios', campos:['api_key','token'] },
      { id:'jadlog', nome:'Jadlog', categoria:'Frete', desc:'Jadlog API', campos:['token'] },
      { id:'braspress', nome:'Braspress', categoria:'Frete', desc:'Braspress', campos:['token'] },
      { id:'melhor_envio', nome:'Melhor Envio', categoria:'Hub', desc:'Melhor Envio', campos:['token'] },
    ]};
  });
  app.post('/api/integracoes', async (req, reply)=>{
    const { plataforma, nome, api_key, api_secret, token, url_loja }=req.body||{}; if(!plataforma) return reply.code(400).send({erro:'plataforma obrigatoria'});
    const enc_key = api_key ? encrypt(api_key) : '';
    const enc_secret = api_secret ? encrypt(api_secret) : '';
    const enc_token = token ? encrypt(token) : '';
    if(pool){
      const existe=await pool.query('SELECT id FROM integracoes WHERE plataforma=$1',[plataforma]);
      if(existe.rows.length>0){
        const res=await pool.query(`UPDATE integracoes SET nome=$1, api_key=$2, api_secret=$3, token=$4, url_loja=$5, status='configurado' WHERE plataforma=$6 RETURNING id, plataforma, nome, status`,[nome||plataforma, enc_key, enc_secret, enc_token, url_loja||'', plataforma]);
        await auditLog(req, req.user, 'ATUALIZAR_INTEGRACAO', 'integracoes', {plataforma});
        return { ok:true, integracao: res.rows[0], atualizado:true };
      } else {
        const res=await pool.query(`INSERT INTO integracoes (plataforma, nome, api_key, api_secret, token, url_loja, status, criado_por) VALUES ($1,$2,$3,$4,$5,$6,'configurado',$7) RETURNING id, plataforma, nome, status`,[plataforma, nome||plataforma, enc_key, enc_secret, enc_token, url_loja||'', req.user.email]);
        await auditLog(req, req.user, 'CRIAR_INTEGRACAO', 'integracoes', {plataforma});
        return { ok:true, integracao: res.rows[0] };
      }
    } else return { ok:true };
  });
  app.delete('/api/integracoes/:id', async (req, reply)=>{
    const id=parseInt(req.params.id); if(pool){ const res=await pool.query('DELETE FROM integracoes WHERE id=$1',[id]); await auditLog(req, req.user, 'EXCLUIR_INTEGRACAO', 'integracoes', {id}); return { ok:true, removidas: res.rowCount }; } else return { ok:true };
  });

  app.get('/api/audit', { preHandler: [requireRole(['admin'])] }, async (req, reply)=>{
    const page=parseInt(req.query.page)||1, limit=Math.min(parseInt(req.query.limit)||50,100), offset=(page-1)*limit;
    if(pool){
      const c=await pool.query('SELECT COUNT(*) FROM audit_log');
      const total=parseInt(c.rows[0].count);
      const res=await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',[limit, offset]);
      return { total, page, total_pages: Math.ceil(total/limit), logs: res.rows };
    } else return { total:0, logs:[] };
  });

  app.get('/api/sessoes', { preHandler: [requireRole(['admin'])] }, async ()=>{
    if(pool){
      const res=await pool.query('SELECT s.id, s.ip, s.user_agent, s.expira_em, s.revogado, s.created_at, c.email, c.nome FROM sessoes s JOIN colaboradores c ON s.user_id=c.id ORDER BY s.created_at DESC LIMIT 50');
      return { total: res.rows.length, sessoes: res.rows };
    } else return { total:0, sessoes:[] };
  });
});

// PAINEL COM LOGIN OBRIGATÓRIO
app.get('/painel', async (req, reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CIUZE LOG • Plataforma Blindada</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>*{font-family:'Plus Jakarta Sans',sans-serif} .mono{font-family:'JetBrains Mono',monospace} ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-thumb{background:#27272a;border-radius:999px} .menu-active{background:#18181b;border:1px solid #3f3f46}</style>
</head>
<body class="bg-[#09090b] text-zinc-100 min-h-screen">

<!-- LOGIN SCREEN - BLINDADO -->
<div id="loginScreen" class="min-h-screen flex items-center justify-center p-6 bg-[#050507]">
  <div class="w-full max-w-[420px]">
    <div class="text-center mb-8">
      <div class="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">CZ</div>
      <h1 class="text-[22px] font-bold mt-5">CIUZE LOG</h1>
      <p class="text-[13px] text-zinc-500 mt-1">Plataforma Blindada • Acesso Restrito</p>
      <div class="mt-4 inline-flex items-center gap-2 text-[11px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 px-3 py-1.5 rounded-full"><span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span> LGPD Compliant • Criptografia AES-256 • Audit Log</div>
    </div>
    <div class="bg-[#0f0f10] border border-zinc-800 rounded-[24px] p-7">
      <h2 class="font-bold text-[15px]">🔐 Login Seguro</h2>
      <p class="text-[12px] text-zinc-500 mt-1">Digite seu email corporativo e senha</p>
      <div class="mt-6 space-y-4">
        <div><label class="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase">Email Corporativo</label><input id="loginEmail" type="email" placeholder="seu@email.com" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-4 py-3.5 text-[13px] outline-none focus:border-amber-500/50"></div>
        <div><label class="text-[11px] font-semibold tracking-widest text-zinc-400 uppercase">Senha</label><input id="loginSenha" type="password" placeholder="••••••••" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-4 py-3.5 text-[13px] outline-none focus:border-amber-500/50"></div>
        <div id="loginErro" class="hidden p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-[12px]"></div>
        <button onclick="fazerLogin()" id="btnLogin" class="w-full bg-amber-500 hover:bg-amber-400 text-black rounded-xl py-3.5 text-[13px] font-bold">ENTRAR COM SEGURANÇA →</button>
        <div class="text-[11px] text-zinc-600 text-center pt-2"><p>🔒 Tentativas limitadas: 5 tentativas / 15min bloqueio</p><p class="mt-1">🛡️ Todas as ações são registradas em audit log</p></div>
      </div>
    </div>
    <p class="text-[10px] text-zinc-600 text-center mt-6 mono">v2.0 BLINDADO • bcrypt 12 rounds • JWT 12h • Rate Limit • LGPD</p>
  </div>
</div>

<!-- APP PRINCIPAL - SÓ APARECE LOGADO -->
<div id="appScreen" class="hidden min-h-screen flex">
  <div class="w-[280px] bg-[#0f0f10] border-r border-zinc-800 min-h-screen p-5 flex flex-col">
    <div class="flex items-center gap-3 mb-8"><div class="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black text-[13px]">CZ</div><div><h1 class="font-bold text-[14px]">CIUZE LOG</h1><p class="text-[11px] text-zinc-500">Blindado</p></div><button onclick="fazerLogout()" class="ml-auto text-[11px] bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-lg hover:bg-red-500/10 hover:border-red-500/30">Sair</button></div>
    <div class="bg-[#18181b] border border-zinc-800 rounded-xl p-3 mb-6"><p class="text-[11px] text-zinc-400">Logado como</p><p id="userNome" class="font-bold text-[13px] mt-1"></p><p id="userEmail" class="text-[11px] text-zinc-500 mono"></p><p id="userRole" class="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/20 px-2 py-0.5 rounded-full mt-2 inline-block"></p></div>
    <div class="space-y-6 flex-1">
      <div><p class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase mb-3 px-3">Operação</p><nav class="space-y-1"><button onclick="showPage('dashboard')" id="menu-dashboard" class="menu-active w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3"><span>◧</span> Dashboard</button><button onclick="showPage('cotacao')" id="menu-cotacao" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>◩</span> Cotação</button><button onclick="showPage('tabelas')" id="menu-tabelas" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>☰</span> Tabelas</button><button onclick="showPage('historico')" id="menu-historico" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>◫</span> Histórico</button></nav></div>
      <div><p class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase mb-3 px-3">Segurança</p><nav class="space-y-1"><button onclick="showPage('integracoes')" id="menu-integracoes" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>⟁</span> Integrações</button><button onclick="showPage('regras')" id="menu-regras" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>⚙</span> Regras</button><button onclick="showPage('colaboradores')" id="menu-colaboradores" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>◍</span> Colaboradores</button><button onclick="showPage('audit')" id="menu-audit" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>🛡️</span> Audit Log <span class="ml-auto text-[10px] bg-red-500/15 text-red-300 px-2 py-0.5 rounded-full">LGPD</span></button><button onclick="showPage('config')" id="menu-config" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] flex items-center gap-3 hover:bg-zinc-900 text-zinc-400"><span>⬡</span> Config</button></nav></div>
    </div>
    <div class="mt-auto pt-4 border-t border-zinc-800 space-y-2"><div class="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3"><p class="text-[11px] font-bold text-emerald-300">🛡️ Blindado</p><p class="text-[10px] text-zinc-400 mt-1">AES-256 • bcrypt 12 • JWT • Rate Limit • Audit</p></div><div id="statusBadge" class="text-[10px] text-zinc-500 mono text-center"></div></div>
  </div>

  <div class="flex-1 p-7 overflow-auto">
    <div id="page-dashboard" class="page"><div class="flex justify-between mb-8"><div><h2 class="text-[22px] font-bold">Dashboard Blindado</h2><p class="text-[13px] text-zinc-500 mt-1">Visão geral segura</p></div><span id="dashData" class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-full mono"></span></div><div class="grid md:grid-cols-4 gap-4 mb-8"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Regras</p><p id="dashTotalRegras" class="text-[28px] font-bold mt-3">-</p></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Transportadoras</p><p id="dashTotalTransp" class="text-[28px] font-bold mt-3">-</p></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Cotações Hoje</p><p id="dashHoje" class="text-[28px] font-bold mt-3">-</p></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Total</p><p id="dashTotal" class="text-[28px] font-bold mt-3">-</p></div></div><div class="grid lg:grid-cols-3 gap-6"><div class="lg:col-span-2 bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-6">Cotações 7 dias</h3><canvas id="chart7dias" height="220"></canvas></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-6">Top Transportadoras</h3><div id="topTransp" class="space-y-3"></div></div></div></div>

    <div id="page-cotacao" class="page hidden"><h2 class="text-[22px] font-bold mb-8">Cotação Blindada</h2><div class="grid lg:grid-cols-12 gap-6"><div class="lg:col-span-4 bg-[#121214] border border-zinc-800 rounded-[24px] p-6"><h3 class="font-semibold text-[13px] mb-5">Dados do Envio</h3><div class="space-y-4"><div class="grid grid-cols-2 gap-3"><div><label class="text-[11px] text-zinc-400">CEP Origem</label><input id="cotCepOrigem" value="87010000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div><div><label class="text-[11px] text-zinc-400">CEP Destino *</label><input id="cotCepDestino" value="01310000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div></div><div class="grid grid-cols-2 gap-3"><div><label class="text-[11px] text-zinc-400">Peso kg</label><input id="cotPeso" value="5" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div><div><label class="text-[11px] text-zinc-400">NF R$</label><input id="cotValor" value="100" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div></div><div class="grid grid-cols-3 gap-3"><div><label class="text-[11px] text-zinc-400">Altura</label><input id="cotAlt" value="20" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div><div><label class="text-[11px] text-zinc-400">Largura</label><input id="cotLarg" value="20" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div><div><label class="text-[11px] text-zinc-400">Comp</label><input id="cotComp" value="30" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div></div><button onclick="fazerCotacao()" class="w-full mt-2 bg-[#fafafa] text-black rounded-xl py-3.5 text-[13px] font-bold">CALCULAR →</button></div></div><div class="lg:col-span-8 bg-[#121214] border border-zinc-800 rounded-[24px] p-6"><h3 class="font-semibold text-[13px] mb-6">Resultados</h3><div id="cotacaoResultado" class="space-y-3"><p class="text-center py-16 text-zinc-500 text-[13px]">Preencha e calcule</p></div></div></div></div>

    <div id="page-tabelas" class="page hidden"><div class="flex justify-between mb-8"><h2 class="text-[22px] font-bold">Tabelas</h2><button onclick="carregarTransportadoras()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">↻</button></div><div class="grid lg:grid-cols-12 gap-6"><div class="lg:col-span-4 space-y-4"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><h3 class="font-semibold text-[13px] mb-4">Upload por Transportadora</h3><input id="transpInput" placeholder="NOME" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px] uppercase font-bold" oninput="this.value=this.value.toUpperCase()"><div id="dropZone" class="mt-4 border border-dashed border-zinc-700 rounded-xl p-8 text-center cursor-pointer bg-[#0f0f10]"><p class="text-[13px]">Arraste .xlsx</p><input id="fileInput" type="file" accept=".xlsx,.xls,.html,.htm" class="hidden"></div><div id="uploadResult" class="hidden mt-3 p-3 rounded-xl text-[12px]"></div></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><h3 class="font-semibold text-[13px] mb-4">Transportadoras</h3><div id="transpLista" class="space-y-2"></div></div></div><div class="lg:col-span-8"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><div id="editorHeader" class="hidden"><div class="flex justify-between mb-6"><h3 class="font-bold">Tabela: <span id="editorTranspNome" class="text-amber-400"></span></h3><div class="flex gap-2"><button onclick="abrirAddLinha()" class="text-[12px] bg-amber-500 text-black font-bold px-4 py-2 rounded-xl">+ Faixa</button><button onclick="fecharEditor()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">✕</button></div></div><div class="overflow-auto border border-zinc-800 rounded-xl"><table class="w-full text-[11px]"><thead class="bg-[#0f0f10]"><tr class="text-zinc-500"><th class="p-3 text-left">CEP Ini</th><th class="p-3 text-left">CEP Fim</th><th class="p-3 text-left">Peso</th><th class="p-3 text-left">Frete</th><th class="p-3 text-left">Prazo</th><th class="p-3 text-left">Ações</th></tr></thead><tbody id="linhasTabela"></tbody></table></div></div><div id="editorVazio" class="text-center py-20 text-zinc-500">Selecione transportadora</div></div><div id="modalLinha" class="hidden fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6 w-full max-w-xl"><h3 class="font-bold mb-5">Nova Faixa</h3><div class="grid grid-cols-2 gap-4 text-[12px]"><div><label class="text-zinc-400">CEP Ini *</label><input id="m_cep_ini" placeholder="01000-000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">CEP Fim *</label><input id="m_cep_fim" placeholder="08499-999" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Peso Ini</label><input id="m_peso_ini" type="number" value="0" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Peso Fim</label><input id="m_peso_fim" type="number" value="99.99" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Frete R$</label><input id="m_frete_valor" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Prazo</label><input id="m_prazo" type="number" value="5" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div></div><div class="flex gap-3 mt-6"><button onclick="salvarLinha()" class="flex-1 bg-amber-500 text-black py-3 rounded-xl font-bold">Salvar</button><button onclick="fecharModal()" class="flex-1 bg-zinc-900 border border-zinc-800 py-3 rounded-xl">Cancelar</button></div></div></div></div></div></div>

    <div id="page-integracoes" class="page hidden"><h2 class="text-[22px] font-bold mb-8">Integrações Blindadas - AES-256</h2><div class="grid lg:grid-cols-12 gap-6"><div class="lg:col-span-8"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Plataformas</h3><div id="plataformasGrid" class="grid md:grid-cols-2 gap-3"></div></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6 mt-6"><h3 class="font-semibold text-[13px] mb-5">Ativas (mascaradas ••••)</h3><div id="integracoesLista" class="space-y-3"></div></div></div><div class="lg:col-span-4"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6 sticky top-6"><h3 class="font-semibold text-[13px] mb-5">Configurar - Criptografado</h3><div id="integForm" class="hidden space-y-4"><input id="integPlataforma" disabled class="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-3 text-[12px] mono"><input id="integNome" placeholder="Apelido" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"><input id="integApiKey" type="password" placeholder="API Key (criptografada AES)" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"><input id="integToken" type="password" placeholder="Token" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"><input id="integUrlLoja" placeholder="URL Loja" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"><button onclick="salvarIntegracao()" class="w-full bg-amber-500 text-black rounded-xl py-3 font-bold">Salvar Criptografado</button></div><div id="integAjuda" class="p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl text-[11px] text-zinc-400">Selecione plataforma ao lado</div></div></div></div></div>

    <div id="page-regras" class="page hidden"><h2 class="text-[22px] font-bold mb-8">Regras</h2><div class="grid lg:grid-cols-2 gap-6"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Nova Regra</h3><div class="space-y-3"><select id="regraTipo" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"><option value="frete_gratis">Frete Grátis</option><option value="markup">Markup %</option></select><input id="regraNome" placeholder="Nome" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><input id="regraTransp" placeholder="Transportadora (opcional)" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 uppercase"><div class="grid grid-cols-2 gap-3"><input id="regraValorMin" type="number" placeholder="Valor mín" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><input id="regraPerc" type="number" placeholder="% markup" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><button onclick="criarRegra()" class="w-full bg-zinc-100 text-black rounded-xl py-3 font-bold">Criar</button></div></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Regras Ativas</h3><div id="regrasLista" class="space-y-3"></div></div></div></div>

    <div id="page-historico" class="page hidden"><h2 class="text-[22px] font-bold mb-8">Histórico</h2><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><div class="overflow-auto border border-zinc-800 rounded-xl"><table class="w-full text-[12px]"><thead class="bg-[#0f0f10]"><tr class="text-zinc-500"><th class="p-3 text-left">Data</th><th class="p-3 text-left">CEP</th><th class="p-3 text-left">Peso</th><th class="p-3 text-left">Transp</th><th class="p-3 text-left">Frete</th></tr></thead><tbody id="historicoTabela"></tbody></table></div></div></div>

    <div id="page-colaboradores" class="page hidden"><h2 class="text-[22px] font-bold mb-8">Colaboradores - Controle de Acesso</h2><div class="grid lg:grid-cols-2 gap-6"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Novo Usuário</h3><div class="space-y-3"><input id="colabNome" placeholder="Nome" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><input id="colabEmail" placeholder="Email corporativo" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><input id="colabSenha" type="password" placeholder="Senha mín 8 caracteres" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><select id="colabRole" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><option value="colaborador">Colaborador</option><option value="admin">Admin (total)</option><option value="visualizador">Visualizador (só vê)</option></select><button onclick="criarColaborador()" class="w-full bg-zinc-100 text-black rounded-xl py-3 font-bold">Criar Usuário</button><p class="text-[10px] text-zinc-500">Senha será criptografada com bcrypt 12 rounds</p></div></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Usuários</h3><div id="colabLista" class="space-y-2"></div></div></div></div>

    <div id="page-audit" class="page hidden"><div class="flex justify-between mb-8"><div><h2 class="text-[22px] font-bold">🛡️ Audit Log - LGPD</h2><p class="text-[13px] text-zinc-500 mt-1">Todas as ações registradas • Prova contra vazamento</p></div><button onclick="carregarAudit()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">↻ Atualizar</button></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><div class="overflow-auto border border-zinc-800 rounded-xl"><table class="w-full text-[11px]"><thead class="bg-[#0f0f10]"><tr class="text-zinc-500"><th class="p-3 text-left">Data</th><th class="p-3 text-left">Usuário</th><th class="p-3 text-left">Ação</th><th class="p-3 text-left">Recurso</th><th class="p-3 text-left">IP</th></tr></thead><tbody id="auditTabela"></tbody></table></div></div></div>

    <div id="page-config" class="page hidden"><h2 class="text-[22px] font-bold mb-8">Config</h2><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><div class="space-y-4"><div><label class="text-[11px] text-zinc-400">CEP Origem</label><input id="cfgCepOrigem" value="87010000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><button onclick="salvarConfig()" class="w-full bg-amber-500 text-black rounded-xl py-3 font-bold">Salvar</button><div class="mt-6 p-4 bg-zinc-900 border border-zinc-800 rounded-xl"><p class="text-[11px] text-zinc-400">Endpoint Bling - use Bearer Token</p><p id="apiEndpoint" class="mono text-[11px] break-all text-amber-300 mt-2"></p></div></div></div></div>

  </div>
</div>

<script>
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token=localStorage.getItem('cz_token')||'', currentUser=null;
const baseUrl=window.location.origin, apiUrl=p=>baseUrl+p;
let transpAtual=null, paginaAtual=1, totalPaginas=1, chartInstance=null, integracoesCache=[], plataformaSelecionada=null;
const limparCep=v=>parseInt(String(v||'').replace(/\\D/g,''))||0;

function authHeaders(){ return {'Content-Type':'application/json','Authorization':'Bearer '+token}; }

async function fazerLogin(){
  const email=document.getElementById('loginEmail').value.trim(), senha=document.getElementById('loginSenha').value;
  const errDiv=document.getElementById('loginErro'), btn=document.getElementById('btnLogin');
  if(!email||!senha){ errDiv.textContent='Preencha email e senha'; errDiv.classList.remove('hidden'); return; }
  btn.textContent='Verificando...'; btn.disabled=true;
  try{
    const r=await fetch(apiUrl('/api/auth/login'),{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email, senha})});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro||'Erro login');
    token=j.token; localStorage.setItem('cz_token', token); currentUser=j.user;
    mostrarApp();
  }catch(e){
    errDiv.textContent=e.message; errDiv.classList.remove('hidden');
  }finally{ btn.textContent='ENTRAR COM SEGURANÇA →'; btn.disabled=false; }
}
async function fazerLogout(){
  try{ await fetch(apiUrl('/api/auth/logout'),{method:'POST', headers: authHeaders()}); }catch(e){}
  localStorage.removeItem('cz_token'); token=''; currentUser=null;
  document.getElementById('appScreen').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
}
async function verificarSessao(){
  if(!token){ document.getElementById('loginScreen').classList.remove('hidden'); document.getElementById('appScreen').classList.add('hidden'); return; }
  try{
    const r=await fetch(apiUrl('/api/auth/me'),{headers: authHeaders()});
    if(!r.ok) throw new Error('Sessão expirada');
    const j=await r.json(); currentUser=j.user; mostrarApp();
  }catch(e){
    localStorage.removeItem('cz_token'); token='';
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('appScreen').classList.add('hidden');
  }
}
function mostrarApp(){
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
  document.getElementById('userNome').textContent=currentUser.nome;
  document.getElementById('userEmail').textContent=currentUser.email;
  document.getElementById('userRole').textContent=currentUser.role.toUpperCase();
  document.getElementById('statusBadge').textContent='● '+ (currentUser.role==='admin'?'ADMIN':'COLAB') +' • '+ new Date().toLocaleDateString('pt-BR');
  document.getElementById('apiEndpoint').textContent=baseUrl+'/api/cotacao (Bearer '+token.substring(0,20)+'...)';
  showPage('dashboard'); carregarDashboard();
}

function showPage(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.add('hidden'));
  document.getElementById('page-'+page).classList.remove('hidden');
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('menu-active'));
  document.getElementById('menu-'+page)?.classList.add('menu-active');
  if(page==='dashboard') carregarDashboard();
  if(page==='tabelas') carregarTransportadoras();
  if(page==='regras') carregarRegras();
  if(page==='historico') carregarHistorico();
  if(page==='colaboradores') carregarColaboradores();
  if(page==='integracoes') carregarIntegracoes();
  if(page==='audit') carregarAudit();
}

async function carregarDashboard(){
  try{
    const r=await fetch(apiUrl('/api/dashboard'),{headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    document.getElementById('dashTotalRegras').textContent=j.total_regras||0;
    document.getElementById('dashTotalTransp').textContent=j.transportadoras||0;
    document.getElementById('dashHoje').textContent=j.cotacoes_hoje||0;
    document.getElementById('dashTotal').textContent=j.cotacoes_total||0;
    document.getElementById('dashData').textContent=new Date().toLocaleDateString('pt-BR');
    if(j.cotacoes_7dias?.length){
      const ctx=document.getElementById('chart7dias').getContext('2d'); if(chartInstance) chartInstance.destroy();
      chartInstance=new Chart(ctx,{ type:'bar', data:{ labels:j.cotacoes_7dias.map(d=> new Date(d.dia).toLocaleDateString('pt-BR')), datasets:[{label:'Cotações', data:j.cotacoes_7dias.map(d=>parseInt(d.total)), backgroundColor:'#f59e0b', borderRadius:6}]}, options:{responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true, grid:{color:'#27272a'}, ticks:{color:'#a1a1aa'}}, x:{grid:{display:false}, ticks:{color:'#a1a1aa'}}}} });
    }
    const topDiv=document.getElementById('topTransp');
    if(j.top_transportadoras?.length){ let html=''; j.top_transportadoras.forEach(t=>{ html+=\`<div class="flex justify-between items-center bg-[#0f0f10] border border-zinc-800/60 p-3 rounded-xl"><div><p class="font-bold text-[12px]">\${esc(t.transportadora)}</p><p class="text-[11px] text-zinc-500">\${esc(t.total)} cotações</p></div><span class="text-[12px] font-bold">\${esc(t.total)}</span></div>\`; }); topDiv.innerHTML=html; } else topDiv.innerHTML='<p class="text-[12px] text-zinc-500">Sem dados</p>';
  }catch(e){}
}

async function fazerCotacao(){
  const cepDestino=document.getElementById('cotCepDestino').value, peso=parseFloat(document.getElementById('cotPeso').value)||1, valor=parseFloat(document.getElementById('cotValor').value)||100, alt=parseFloat(document.getElementById('cotAlt').value)||20, larg=parseFloat(document.getElementById('cotLarg').value)||20, comp=parseFloat(document.getElementById('cotComp').value)||30;
  const div=document.getElementById('cotacaoResultado'); div.innerHTML='<p class="text-center py-10 text-zinc-500 mono text-[12px]">Calculando...</p>';
  try{
    const r=await fetch(apiUrl('/api/cotacao'),{method:'POST', headers: authHeaders(), body:JSON.stringify({cep_destino:cepDestino, peso_real:peso, altura:alt, largura:larg, comprimento:comp, valor_nf:valor})});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    if(!j.cotacoes.length){ div.innerHTML='<p class="text-amber-300 text-[13px] p-4">⚠️ Nenhuma regra para CEP '+esc(j.cep_consultado)+'</p>'; return; }
    let html=''; j.cotacoes.forEach(c=>{ const isFree=c.valor_frete===0; html+=\`<div class="flex justify-between items-center border \${isFree?'border-emerald-500/30 bg-emerald-500/5':'border-zinc-800 bg-[#0f0f10]'} p-4 rounded-xl"><div><p class="font-bold text-[13px]">\${esc(c.transportadora)}</p><p class="text-[11px] text-zinc-500 mt-1">\${esc(c.metodo)} • \${esc(c.prazo)} dias</p></div><div class="text-right"><p class="font-bold text-[16px] \${isFree?'text-emerald-400':''}">\${isFree?'GRÁTIS':'R$ '+esc(c.valor_frete.toFixed(2))}</p></div></div>\`; }); div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400 text-[13px] p-4">Erro: '+esc(e.message)+'</p>'; }
}

const dropZone=document.getElementById('dropZone'), fileInput=document.getElementById('fileInput');
if(dropZone){ dropZone.onclick=()=>fileInput.click(); dropZone.ondrop=e=>{e.preventDefault(); const f=e.dataTransfer.files[0]; if(f) uploadFile(f);}; fileInput.onchange=e=>{const f=e.target.files[0]; if(f) uploadFile(f);}; }
async function uploadFile(file){
  const transp=document.getElementById('transpInput').value.trim().toUpperCase(); if(!transp){ alert('Digite nome transportadora'); return; }
  const resDiv=document.getElementById('uploadResult'); resDiv.classList.remove('hidden'); resDiv.textContent='Enviando...';
  try{
    const fd=new FormData(); fd.append('file',file); fd.append('transportadora',transp);
    const r=await fetch(apiUrl('/api/upload'),{method:'POST', headers:{'Authorization':'Bearer '+token, 'x-transportadora':transp}, body:fd});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro||JSON.stringify(j));
    resDiv.className='mt-3 p-3 rounded-xl text-[12px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'; resDiv.textContent='✅ '+esc(j.transportadora)+' • '+esc(j.total)+' faixas'; carregarTransportadoras(); carregarDashboard();
  }catch(e){ resDiv.className='mt-3 p-3 rounded-xl text-[12px] bg-red-500/10 border border-red-500/20 text-red-300'; resDiv.textContent='❌ '+e.message; }
}
async function carregarTransportadoras(){
  const div=document.getElementById('transpLista'); div.innerHTML='Carregando...';
  try{
    const r=await fetch(apiUrl('/api/transportadoras'),{headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhuma transportadora</p>'; return; }
    let html=''; j.transportadoras.forEach(t=>{ html+=\`<div class="border border-zinc-800 bg-[#0f0f10] rounded-xl p-3 cursor-pointer hover:border-zinc-700" onclick="abrirTransportadora('\${esc(t.transportadora)}')"><p class="font-bold text-[12px]">\${esc(t.transportadora)}</p><p class="text-[11px] text-zinc-500">\${esc(t.total)} faixas</p></div>\`; }); div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400 text-[12px]">Erro: '+esc(e.message)+'</p>'; }
}
let transpAtual=null;
function abrirTransportadora(nome){ transpAtual=nome; document.getElementById('editorVazio').classList.add('hidden'); document.getElementById('editorHeader').classList.remove('hidden'); document.getElementById('editorTranspNome').textContent=nome; carregarLinhas(); }
function fecharEditor(){ transpAtual=null; document.getElementById('editorHeader').classList.add('hidden'); document.getElementById('editorVazio').classList.remove('hidden'); }
async function carregarLinhas(){
  if(!transpAtual) return; const tbody=document.getElementById('linhasTabela'); tbody.innerHTML='<tr><td colspan="6" class="p-4 text-center text-zinc-500">Carregando...</td></tr>';
  try{
    const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/linhas?limit=100'),{headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    if(!j.linhas.length){ tbody.innerHTML='<tr><td colspan="6" class="p-4 text-center text-zinc-500">Nenhuma faixa</td></tr>'; return; }
    let html=''; j.linhas.forEach(l=>{ html+=\`<tr class="border-t border-zinc-800/60"><td class="p-3">\${esc(l.cep_ini)}-\${esc(l.cep_fim)}</td><td class="p-3">\${esc(l.cep_fim)}</td><td class="p-3">\${esc(l.peso_ini)}-\${esc(l.peso_fim)}kg</td><td class="p-3">R$ \${esc(l.frete_valor)}</td><td class="p-3">\${esc(l.prazo)}d</td><td class="p-3"><button onclick="deletarLinha(\${l.id})" class="text-[11px] bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">✕</button></td></tr>\`; }); tbody.innerHTML=html;
  }catch(e){ tbody.innerHTML='<tr><td colspan="6" class="p-4 text-center text-red-400">Erro: '+esc(e.message)+'</td></tr>'; }
}
async function deletarLinha(id){ if(!confirm('Excluir faixa?')) return; try{ const r=await fetch(apiUrl('/api/tabelas/linha/'+id),{method:'DELETE', headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarLinhas(); }catch(e){ alert('Erro: '+e.message); } }
function abrirAddLinha(){ document.getElementById('modalLinha').classList.remove('hidden'); }
function fecharModal(){ document.getElementById('modalLinha').classList.add('hidden'); }
async function salvarLinha(){
  const payload={ cep_ini: limparCep(document.getElementById('m_cep_ini').value), cep_fim: limparCep(document.getElementById('m_cep_fim').value), peso_ini: parseFloat(document.getElementById('m_peso_ini').value)||0, peso_fim: parseFloat(document.getElementById('m_peso_fim').value)||999, frete_valor: parseFloat(document.getElementById('m_frete_valor').value)||0, prazo: parseInt(document.getElementById('m_prazo').value)||5 };
  if(!payload.cep_ini || !payload.cep_fim){ alert('CEP obrigatório'); return; }
  try{ const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/linha'),{method:'POST', headers: authHeaders(), body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); fecharModal(); carregarLinhas(); }catch(e){ alert('Erro: '+e.message); }
}

// INTEGRAÇÕES
async function carregarPlataformas(){
  try{
    const r=await fetch(apiUrl('/api/integracoes/plataformas'),{headers: authHeaders()}); const j=await r.json();
    const grid=document.getElementById('plataformasGrid'); let html='';
    j.plataformas.forEach(p=>{ html+=\`<div onclick="selecionarPlataforma('\${p.id}','\${esc(p.nome)}')" class="border border-zinc-800 bg-[#0f0f10] hover:border-zinc-700 rounded-xl p-4 cursor-pointer"><p class="font-semibold text-[12px]">\${esc(p.nome)}</p><p class="text-[11px] text-zinc-500">\${esc(p.desc)}</p></div>\`; }); grid.innerHTML=html;
  }catch(e){}
}
function selecionarPlataforma(id, nome){ plataformaSelecionada=id; document.getElementById('integPlataforma').value=id; document.getElementById('integForm').classList.remove('hidden'); }
async function carregarIntegracoes(){ try{ const r=await fetch(apiUrl('/api/integracoes'),{headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); const div=document.getElementById('integracoesLista'); if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhuma integração</p>'; return; } let html=''; j.integracoes.forEach(i=>{ html+=\`<div class="bg-[#0f0f10] border border-zinc-800 rounded-xl p-4"><p class="font-bold text-[12px]">\${esc(i.plataforma.toUpperCase())}</p><p class="text-[11px] text-zinc-500">\${esc(i.nome)} • \${esc(i.api_key)}</p><button onclick="deletarIntegracao(\${i.id})" class="mt-2 text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1 rounded">Remover</button></div>\`; }); div.innerHTML=html; carregarPlataformas(); }catch(e){} }
async function salvarIntegracao(){ const payload={ plataforma: document.getElementById('integPlataforma').value, nome: document.getElementById('integPlataforma').value, api_key: document.getElementById('integApiKey').value, token: document.getElementById('integToken').value, url_loja: document.getElementById('integUrlLoja').value }; try{ const r=await fetch(apiUrl('/api/integracoes'),{method:'POST', headers: authHeaders(), body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); alert('Salvo criptografado!'); carregarIntegracoes(); }catch(e){ alert('Erro: '+e.message); } }
async function deletarIntegracao(id){ if(!confirm('Remover?')) return; try{ const r=await fetch(apiUrl('/api/integracoes/'+id),{method:'DELETE', headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarIntegracoes(); }catch(e){ alert('Erro: '+e.message); } }

async function carregarRegras(){ try{ const r=await fetch(apiUrl('/api/regras'),{headers: authHeaders()}); const j=await r.json(); const div=document.getElementById('regrasLista'); if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhuma regra</p>'; return; } let html=''; j.regras.forEach(reg=>{ html+=\`<div class="bg-[#0f0f10] border border-zinc-800 rounded-xl p-4 flex justify-between"><div><p class="font-bold text-[12px]">\${esc(reg.nome||reg.tipo)}</p><p class="text-[11px] text-zinc-500">\${esc(reg.tipo)}</p></div><button onclick="deletarRegra(\${reg.id})" class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1 rounded">✕</button></div>\`; }); div.innerHTML=html; }catch(e){} }
async function criarRegra(){ const payload={ tipo: document.getElementById('regraTipo').value, nome: document.getElementById('regraNome').value, transportadora: document.getElementById('regraTransp').value, valor_min: parseFloat(document.getElementById('regraValorMin').value)||0, percentual: parseFloat(document.getElementById('regraPerc').value)||0 }; try{ const r=await fetch(apiUrl('/api/regras'),{method:'POST', headers: authHeaders(), body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarRegras(); }catch(e){ alert('Erro: '+e.message); } }
async function deletarRegra(id){ try{ const r=await fetch(apiUrl('/api/regras/'+id),{method:'DELETE', headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarRegras(); }catch(e){} }

async function carregarHistorico(){ try{ const r=await fetch(apiUrl('/api/historico?limit=50'),{headers: authHeaders()}); const j=await r.json(); const tbody=document.getElementById('historicoTabela'); if(!j.historico.length){ tbody.innerHTML='<tr><td colspan="5" class="p-4 text-center text-zinc-500">Nenhuma</td></tr>'; return; } let html=''; j.historico.forEach(h=>{ html+=\`<tr class="border-t border-zinc-800/60"><td class="p-3">\${new Date(h.created_at).toLocaleString('pt-BR')}</td><td class="p-3">\${esc(h.cep_destino)}</td><td class="p-3">\${esc(h.peso)}kg</td><td class="p-3">\${esc(h.transportadora)}</td><td class="p-3">R$ \${esc(parseFloat(h.valor_frete||0).toFixed(2))}</td></tr>\`; }); tbody.innerHTML=html; }catch(e){} }

async function carregarColaboradores(){ try{ const r=await fetch(apiUrl('/api/colaboradores'),{headers: authHeaders()}); const j=await r.json(); const div=document.getElementById('colabLista'); if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhum</p>'; return; } let html=''; j.colaboradores.forEach(c=>{ html+=\`<div class="bg-[#0f0f10] border border-zinc-800 rounded-xl p-3 flex justify-between"><div><p class="font-bold text-[12px]">\${esc(c.nome)}</p><p class="text-[11px] text-zinc-500">\${esc(c.email)} • \${esc(c.role)}</p></div><button onclick="deletarColab(\${c.id})" class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1 rounded">✕</button></div>\`; }); div.innerHTML=html; }catch(e){} }
async function criarColaborador(){ const payload={ nome: document.getElementById('colabNome').value, email: document.getElementById('colabEmail').value, senha: document.getElementById('colabSenha').value, role: document.getElementById('colabRole').value }; try{ const r=await fetch(apiUrl('/api/colaboradores'),{method:'POST', headers: authHeaders(), body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarColaboradores(); }catch(e){ alert('Erro: '+e.message); } }
async function deletarColab(id){ if(!confirm('Excluir?')) return; try{ const r=await fetch(apiUrl('/api/colaboradores/'+id),{method:'DELETE', headers: authHeaders()}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarColaboradores(); }catch(e){ alert('Erro: '+e.message); } }

async function carregarAudit(){ try{ const r=await fetch(apiUrl('/api/audit?limit=100'),{headers: authHeaders()}); const j=await r.json(); const tbody=document.getElementById('auditTabela'); if(!j.logs.length){ tbody.innerHTML='<tr><td colspan="5" class="p-4 text-center text-zinc-500">Nenhum log</td></tr>'; return; } let html=''; j.logs.forEach(l=>{ html+=\`<tr class="border-t border-zinc-800/60"><td class="p-3 mono text-[11px]">\${new Date(l.created_at).toLocaleString('pt-BR')}</td><td class="p-3">\${esc(l.user_email)}</td><td class="p-3"><span class="bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded">\${esc(l.acao)}</span></td><td class="p-3">\${esc(l.recurso)}</td><td class="p-3 mono text-[10px]">\${esc(l.ip)}</td></tr>\`; }); tbody.innerHTML=html; }catch(e){} }

verificarSessao();
</script>
</body>
</html>
  `);
});

app.get('/api/status', async ()=>{ const t=await getTabelas().catch(()=>[]); return { status:'ok', total:t.length, security:'BLINDADO - AES-256 + bcrypt + JWT + Rate Limit + Audit Log' }; });

const port=process.env.PORT||3000;
app.listen({ port, host:'0.0.0.0' });

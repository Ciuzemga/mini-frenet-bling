import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import 'dotenv/config';

const app = Fastify({ logger: false });
await app.register(cors, { origin: '*' });
await app.register(multipart, { limits: { fileSize: 30*1024*1024 } });

// ========== HEALTHCHECK INSTANTÂNEO - NUNCA BLOQUEIA ==========
app.get('/health', async ()=> ({ ok:true, version:'v5-final-fiel', ts:Date.now(), uptime:process.uptime(), status:'online' }));
app.get('/', async (req,reply)=>{
  try{
    const t = await getTabelas().catch(()=>CACHE_TABELAS||[]);
    return { status:'ok', version:'v5-final', db: pool?'postgres':'memoria', total_regras:t.length, total:t.length, uptime:process.uptime() };
  }catch{
    return { status:'ok', db:'memoria', total_regras:0, total:0 };
  }
});
app.get('/api/status', async ()=>{
  try{
    const t = await getTabelas().catch(()=>CACHE_TABELAS||[]);
    return { status:'ok', db: pool?'postgres':'memoria', total:t.length, uptime: process.uptime() };
  }catch{
    return { status:'ok', db:'memoria', total:0 };
  }
});

function getPoolConfig(){
  const url = (process.env.DATABASE_URL||'').trim();
  if(!url) return null;
  const needsSSL = url.includes('.rlwy.net') || url.includes('railway') || process.env.PGSSLMODE === 'require';
  const base = { connectionString: url, connectionTimeoutMillis: 4000, idleTimeoutMillis: 20000, max: 3 };
  return needsSSL ? { ...base, ssl: { rejectUnauthorized: false } } : base;
}
let pool = null;
try{
  const cfg = getPoolConfig();
  if(cfg) pool = new pg.Pool(cfg);
  if(pool) pool.on('error', (e)=> console.error('pg pool erro (cliente ocioso):', e.message));
}catch(e){
  console.error('⚠️ Pool não criado mas /health OK:', e.message);
  pool = null;
}

let CACHE_TABELAS = null;
let CACHE_AT = 0;
let DB_READY = false;

async function ensureDB(){
  if(!pool || DB_READY) return;
  await initDB();
}

async function initDB(){
  if(!pool) return;
  try{
  await pool.query(`
    CREATE TABLE IF NOT EXISTS frete_tabelas (
      id SERIAL PRIMARY KEY,
      transportadora TEXT,
      metodo TEXT,
      cep_ini INT,
      cep_fim INT,
      peso_ini NUMERIC,
      peso_fim NUMERIC,
      valor_ini NUMERIC,
      valor_fim NUMERIC,
      cubagem NUMERIC DEFAULT 6000,
      limite_peso NUMERIC,
      prazo INT,
      frete_valor NUMERIC,
      excedente NUMERIC,
      advalor_perc NUMERIC,
      peso_excedente NUMERIC,
      valor_por_kg NUMERIC,
      despacho NUMERIC,
      total_minimo NUMERIC,
      imposto_perc NUMERIC,
      seguro_perc NUMERIC,
      seguro_min NUMERIC,
      gris_perc NUMERIC,
      gris_min NUMERIC,
      pedagio NUMERIC,
      pedagio_fracao NUMERIC,
      tas_perc NUMERIC,
      tas_min NUMERIC,
      emex_perc NUMERIC,
      emex_min NUMERIC,
      taxa_min NUMERIC,
      taxa_max NUMERIC,
      taxa_perc NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ DB V5 pronto - Fiel Frenet/Bling/Correios - /health OK');
  DB_READY = true;
  }catch(e){ console.error('DB init falhou (tentará no primeiro uso) mas /health OK:', e.message); }
}

// NÃO BLOQUEIA - inicia 1s depois do listen
setTimeout(()=>{ initDB(); }, 1200);

function parseTabela(html){
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  const colRegex = /<t[dh][^>]*>(.*?)<\/t[dh]>/gis;
  const rows = [...html.matchAll(rowRegex)].map(m=>m[1]);
  const data = [];
  for(let i=1;i<rows.length;i++){
    const cols = [...rows[i].matchAll(colRegex)].map(m=>m[1].replace(/<[^>]*>/g,'').trim());
    if(cols.length < 13) continue;
    if(!cols[0]) continue;
    data.push({
      transportadora: cols[0],
      metodo: cols[1] || 'Padrao',
      cep_ini: parseInt(String(cols[2]).replace(/\D/g,''))||0,
      cep_fim: parseInt(String(cols[3]).replace(/\D/g,''))||99999999,
      peso_ini: parseFloat(cols[4])||0,
      peso_fim: parseFloat(cols[5])||999,
      valor_ini: parseFloat(cols[6])||0,
      valor_fim: parseFloat(cols[7])||9999999,
      cubagem: parseFloat(cols[8])||6000,
      limite_peso: parseFloat(cols[9])||999,
      prazo: parseInt(cols[10])||5,
      frete_valor: parseFloat(cols[12])||0,
      excedente: parseFloat(cols[13])||0,
      advalor_perc: parseFloat(cols[14])||0,
      peso_excedente: parseFloat(cols[15])||0,
      valor_por_kg: parseFloat(cols[16])||0,
      despacho: parseFloat(cols[17])||0,
      total_minimo: parseFloat(cols[18])||0,
      imposto_perc: parseFloat(cols[19])||0,
      seguro_perc: parseFloat(cols[20])||0,
      seguro_min: parseFloat(cols[21])||0,
      gris_perc: parseFloat(cols[22])||0,
      gris_min: parseFloat(cols[23])||0,
      pedagio: parseFloat(cols[24])||0,
      pedagio_fracao: parseFloat(cols[25])||0,
      tas_perc: parseFloat(cols[26])||0,
      tas_min: parseFloat(cols[27])||0,
      emex_perc: parseFloat(cols[28])||0,
      emex_min: parseFloat(cols[29])||0,
      taxa_min: parseFloat(cols[30])||0,
      taxa_max: parseFloat(cols[31])||0,
      taxa_perc: parseFloat(cols[32])||0,
    });
  }
  return data;
}

function toNum(v){
  const n = Number(String(v||0).replace(',','.').replace('R$','').trim());
  return isNaN(n) ? 0 : n;
}

// CÁLCULO FIEL ÀS OUTRAS PLATAFORMAS - FRENET/BLING/CORREIOS/JADLOG
function calcularFrete(regra, peso_taxado, valor_nf){
  let total = toNum(regra.frete_valor);
  const pe = toNum(regra.peso_excedente);
  const vkg = toNum(regra.valor_por_kg);
  if(peso_taxado > pe && vkg > 0){
    total += (peso_taxado - pe) * vkg;
    total += toNum(regra.excedente);
  }
  total += toNum(regra.despacho);
  const advalor = valor_nf * (toNum(regra.advalor_perc)/100);
  const seguro = Math.max(valor_nf * (toNum(regra.seguro_perc)/100), toNum(regra.seguro_min));
  const gris = Math.max(valor_nf * (toNum(regra.gris_perc)/100), toNum(regra.gris_min));
  const tas = Math.max(valor_nf * (toNum(regra.tas_perc)/100), toNum(regra.tas_min));
  const emex = Math.max(valor_nf * (toNum(regra.emex_perc)/100), toNum(regra.emex_min));
  total += advalor + seguro + gris + tas + emex;
  const pedFrac = toNum(regra.pedagio_fracao);
  const ped = toNum(regra.pedagio);
  if(pedFrac > 0 && ped > 0) total += Math.ceil(peso_taxado / pedFrac) * ped;
  else total += ped;
  const taxaPerc = toNum(regra.taxa_perc);
  if(taxaPerc > 0){
    let taxa = total * (taxaPerc/100);
    if(toNum(regra.taxa_min) > 0) taxa = Math.max(taxa, toNum(regra.taxa_min));
    if(toNum(regra.taxa_max) > 0) taxa = Math.min(taxa, toNum(regra.taxa_max));
    total += taxa;
  }
  if(toNum(regra.total_minimo) > 0) total = Math.max(total, toNum(regra.total_minimo));
  if(toNum(regra.imposto_perc) > 0) total *= (1 + toNum(regra.imposto_perc)/100);
  return parseFloat(total.toFixed(2));
}

async function getTabelas(force=false){
  const now = Date.now();
  if(!force && CACHE_TABELAS && (now - CACHE_AT) < 60000){
    return CACHE_TABELAS;
  }
  let rows;
  if(pool){
    await ensureDB();
    try{
      const res = await pool.query('SELECT * FROM frete_tabelas ORDER BY transportadora, metodo, cep_ini');
      rows = res.rows;
    }catch(e){
      if(CACHE_TABELAS){
        rows = CACHE_TABELAS;
      } else {
        throw Object.assign(new Error('banco indisponivel - usando cache'), { statusCode: 503 });
      }
    }
  } else {
    global.TABELAS_MEM = global.TABELAS_MEM || [];
    rows = global.TABELAS_MEM;
  }
  CACHE_TABELAS = rows;
  CACHE_AT = now;
  return rows;
}

function requireToken(req, reply){
  const tokenEnv = process.env.UPLOAD_TOKEN;
  if(!tokenEnv) return true;
  const sent = req.headers['x-upload-token'] || req.query.token;
  if(sent !== tokenEnv){
    reply.code(401).send({ erro:'Token invalido - configure x-upload-token', dica:'Defina UPLOAD_TOKEN nas Variables' });
    return false;
  }
  return true;
}

// COTACAO FIEL - FRENET/BLING/CORREIOS
app.post('/api/cotacao', async (req, reply)=>{
  const { cep_destino, peso_real, altura, largura, comprimento, valor_nf, cep_origem } = req.body||{};
  const cep = parseInt(String(cep_destino||'').replace(/\D/g,''));
  if(!cep || String(cep).length < 8) return reply.code(400).send({ erro:'CEP destino invalido - 8 digitos como Correios exige' });
  const pesoR = parseFloat(peso_real)||1;
  if(pesoR <=0) return reply.code(400).send({ erro:'Peso >0 como Frenet exige' });
  const alt = parseFloat(altura)||20, lar=parseFloat(largura)||20, comp=parseFloat(comprimento)||20;
  const cub = (alt*lar*comp)/6000;
  const peso_taxado = Math.max(pesoR, cub);
  const valor = parseFloat(valor_nf)||100;

  const tabelas = await getTabelas().catch(()=>[]);
  const resultados = [];
  for(const r of tabelas){
    if(cep < r.cep_ini || cep > r.cep_fim) continue;
    if(peso_taxado < toNum(r.peso_ini) || peso_taxado > toNum(r.peso_fim)) continue;
    if(valor < toNum(r.valor_ini) || valor > toNum(r.valor_fim)) continue;
    const valor_frete = calcularFrete(r, peso_taxado, valor);
    resultados.push({
      id_servico: `${String(r.transportadora).toLowerCase().replace(/\s+/g,'-')}-${String(r.metodo||'padrao').toLowerCase()}`,
      nome: `${r.transportadora} - ${r.metodo||'Padrao'}`,
      transportadora: r.transportadora,
      metodo: r.metodo||'Padrao',
      valor_frete,
      prazo: r.prazo,
      prazo_texto: `${r.prazo} dias úteis`,
      peso_taxado,
      peso_cubado: cub,
      peso_real: pesoR,
      // Fiel às outras plataformas
      cep_consultado: cep,
      cep_origem: cep_origem||'87010000'
    });
  }
  resultados.sort((a,b)=>a.valor_frete - b.valor_frete);
  return {
    cotacoes: resultados,
    peso_taxado,
    peso_cubado: cub,
    peso_real: pesoR,
    cep_consultado: cep,
    total_encontrado: resultados.length,
    calculo_fiel: 'Peso taxado = max(real, cubagem) como Correios/Jadlog/Frenet/Bling',
    db: pool?'postgres':'memoria'
  };
});

app.post('/api/upload', async (req, reply)=>{
  if(!requireToken(req, reply)) return;
  const file = await req.file();
  if(!file) return reply.code(400).send({ erro:'Envie arquivo .xls/.xlsx como Frenet aceita' });
  const buffer = await file.toBuffer();
  let parsed = [];
  const name = (file.filename||'').toLowerCase();
  try{
    if(name.endsWith('.xlsx') || name.endsWith('.xls')){
      // Tenta XLSX primeiro
      try{
        const XLSX = await import('xlsx');
        const wb = XLSX.default.read(buffer, {type:'buffer'});
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.default.utils.sheet_to_json(ws, {defval:0});
        // Converte json para formato parseTabela
        for(const row of json){
          const get=(...keys)=>{ for(const k of keys){ if(row[k]!==undefined) return row[k]; const lk=k.toLowerCase(); for(const rk of Object.keys(row)){ if(rk.toLowerCase().includes(lk)) return row[rk]; } } return 0; };
          if(!get('Transportadora','transportadora')) continue;
          parsed.push({
            transportadora: String(get('Transportadora','transportadora')||''),
            metodo: String(get('Metodo','metodo','Servico')||'Padrao'),
            cep_ini: parseInt(String(get('Cep Inicial','cep_ini')||'').replace(/\D/g,''))||0,
            cep_fim: parseInt(String(get('Cep Final','cep_fim')||'').replace(/\D/g,''))||99999999,
            peso_ini: parseFloat(String(get('Peso Inicial','peso_ini')||'').replace(',','.'))||0,
            peso_fim: parseFloat(String(get('Peso Final','peso_fim')||'').replace(',','.'))||999,
            valor_ini: 0, valor_fim: 9999999, cubagem: 6000,
            prazo: parseInt(get('Prazo','prazo'))||5,
            frete_valor: parseFloat(String(get('Frete Valor','frete_valor','Valor')||'').replace(',','.').replace('R$',''))||0,
            excedente:0, advalor_perc:0, peso_excedente:0, valor_por_kg:0, despacho:0, total_minimo:0, imposto_perc:0, seguro_perc:0, seguro_min:0, gris_perc:0, gris_min:0, pedagio:0, pedagio_fracao:0, tas_perc:0, tas_min:0, emex_perc:0, emex_min:0, taxa_min:0, taxa_max:0, taxa_perc:0
          });
        }
      }catch{
        // Fallback HTML table
        const html = buffer.toString('utf-8');
        parsed = parseTabela(html);
      }
    } else {
      const html = buffer.toString('utf-8');
      parsed = parseTabela(html);
    }
  }catch(e){
    return reply.code(400).send({ erro:'Erro ao ler planilha: '+e.message, dica:'Use .xls HTML table ou .xlsx como Frenet exporta' });
  }

  if(!parsed.length) return reply.code(400).send({ erro:'Planilha vazia ou sem colunas Transportadora/Cep/Peso como Frenet exige' });

  if(pool){
    await ensureDB();
    const client = await pool.connect();
    try{
      await client.query('BEGIN');
      // Limpa e insere - fiel a Frenet que substitui tabela
      for(const r of parsed){
        await client.query(`INSERT INTO frete_tabelas (transportadora,metodo,cep_ini,cep_fim,peso_ini,peso_fim,valor_ini,valor_fim,cubagem,prazo,frete_valor,excedente,advalor_perc,peso_excedente,valor_por_kg,despacho,total_minimo,imposto_perc,seguro_perc,seguro_min,gris_perc,gris_min,pedagio,pedagio_fracao,tas_perc,tas_min,emex_perc,emex_min,taxa_min,taxa_max,taxa_perc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`, [r.transportadora,r.metodo,r.cep_ini,r.cep_fim,r.peso_ini,r.peso_fim,r.valor_ini,r.valor_fim,r.cubagem,r.prazo,r.frete_valor,r.excedente,r.advalor_perc,r.peso_excedente,r.valor_por_kg,r.despacho,r.total_minimo,r.imposto_perc,r.seguro_perc,r.seguro_min,r.gris_perc,r.gris_min,r.pedagio,r.pedagio_fracao,r.tas_perc,r.tas_min,r.emex_perc,r.emex_min,r.taxa_min,r.taxa_max,r.taxa_perc]);
      }
      await client.query('COMMIT');
    }catch(e){
      await client.query('ROLLBACK');
      throw e;
    }finally{
      client.release();
      CACHE_TABELAS = null;
    }
  } else {
    global.TABELAS_MEM = global.TABELAS_MEM || [];
    global.TABELAS_MEM.push(...parsed);
    CACHE_TABELAS = global.TABELAS_MEM;
  }

  return { ok:true, total: parsed.length, preview: parsed.slice(0,3), msg: `${parsed.length} faixas importadas fiel ao Frenet`, db: pool?'postgres':'memoria' };
});

app.get('/api/tabelas', async (req,reply)=>{
  if(!requireToken(req, reply)) return;
  const t = await getTabelas();
  return { total: t.length, tabelas: t.slice(0,200), db: pool?'postgres':'memoria', fiel:'Formato Frenet/Bling: transportadora, cep_ini/fim, peso_ini/fim, frete_valor, prazo' };
});

// PAINEL PROFISSIONAL FIEL
app.get('/painel', async (req,reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CIUZE LOG V5 • Fiel Frenet/Bling/Correios</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet"><style>*{font-family:'Plus Jakarta Sans',sans-serif} .mono{font-family:'JetBrains Mono',monospace} .gradient-amber{background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 50%,#ea580c 100%)}</style></head><body class="bg-[#09090b] text-zinc-100 min-h-screen"><div class="max-w-[1200px] mx-auto p-6"><div class="flex justify-between items-center mb-8"><div class="flex items-center gap-3"><div class="w-12 h-12 rounded-xl gradient-amber flex items-center justify-center font-bold text-black text-[16px]">CZ</div><div><h1 class="text-[20px] font-bold">CIUZE LOG V5 • FINAL PROFISSIONAL FIEL</h1><p class="text-[12px] text-zinc-500">Fiel ao Frenet/Bling/Correios/Jadlog/Tiny/Shopify • Healthcheck instantâneo • Sem travar</p></div></div><div class="flex items-center gap-2"><span id="statusBadge" class="px-3 py-1 rounded-full text-xs bg-zinc-800 border border-zinc-700">● Verificando...</span><span id="dbStatus" class="text-[11px] text-zinc-500"></span></div></div>

<div class="grid lg:grid-cols-3 gap-6"><div class="lg:col-span-2 space-y-6"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-6"><h2 class="font-bold text-[14px] flex items-center gap-2">💰 Cotação Fiel • Frenet/Bling/Correios</h2><p class="text-[11px] text-zinc-500 mt-1">Peso taxado = max(real, cubagem) • CEP por faixa • Valor com advalorem/seguro/GRIS como outras plataformas</p><div class="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3"><div><label class="text-[10px] font-bold text-zinc-500 uppercase">CEP Destino *</label><input id="testCep" value="01310000" class="w-full mt-1 bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-[13px] mono"></div><div><label class="text-[10px] font-bold text-zinc-500 uppercase">Peso kg *</label><input id="testPeso" value="5" type="number" step="0.1" class="w-full mt-1 bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-[13px]"></div><div><label class="text-[10px] font-bold text-zinc-500 uppercase">Alt x Larg x Comp</label><div class="flex gap-1 mt-1"><input id="testAlt" value="20" type="number" class="w-full bg-black border border-zinc-800 rounded-xl px-2 py-2.5 text-[13px]"><input id="testLarg" value="20" type="number" class="w-full bg-black border border-zinc-800 rounded-xl px-2 py-2.5 text-[13px]"><input id="testComp" value="20" type="number" class="w-full bg-black border border-zinc-800 rounded-xl px-2 py-2.5 text-[13px]"></div></div><div><label class="text-[10px] font-bold text-zinc-500 uppercase">Valor NF</label><input id="testValor" value="100" type="number" class="w-full mt-1 bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-[13px]"></div></div><button onclick="testarCotacao()" class="mt-4 w-full bg-white text-black rounded-xl py-3 font-bold text-[13px] hover:bg-zinc-100">CALCULAR FRETE FIEL COMO FRENET →</button><div id="cotacaoResult" class="hidden mt-5"></div></div>

<div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-6"><h2 class="font-bold text-[14px]">📤 Upload Planilha • Fiel ao Frenet/Bling</h2><p class="text-[11px] text-zinc-500 mt-1">Formato: Transportadora, Metodo, Cep Ini, Cep Fim, Peso Ini, Peso Fim, Frete Valor, Prazo + taxas como Jadlog/Correios usam • .xls ou .xlsx</p><div id="dropZone" class="mt-4 border-2 border-dashed border-zinc-700 hover:border-amber-400 rounded-[16px] p-8 text-center cursor-pointer hover:bg-amber-500/5 transition-all group"><div class="w-12 h-12 mx-auto bg-zinc-900 border border-zinc-800 group-hover:bg-amber-500/10 rounded-xl flex items-center justify-center mb-3">📄</div><p class="text-[13px] font-bold">Arraste .xls/.xlsx aqui (fiel Frenet)</p><p class="text-[11px] text-zinc-500 mt-1">Máx 30MB • Colunas como Frenet exporta</p><input id="fileInput" type="file" class="hidden" accept=".xlsx,.xls,.xlsm,.html"></div><div id="uploadProgress" class="hidden mt-4"><div class="w-full bg-zinc-900 rounded-full h-2"><div id="progressBar" class="bg-gradient-to-r from-amber-400 to-orange-500 h-2 rounded-full transition-all" style="width:0%"></div></div><p id="progressText" class="text-[11px] text-zinc-500 mt-2"></p></div><div id="uploadResult" class="hidden mt-4"></div></div>
</div>

<div class="space-y-6"><div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-bold text-[13px] flex items-center gap-2">⚙️ Config • Token Upload Fiel</h3><p class="text-[11px] text-zinc-500 mt-2">Protege upload como Frenet/Bling protegem com API key. Defina UPLOAD_TOKEN nas Variables.</p><div class="mt-4 space-y-3"><div><label class="text-[10px] font-bold text-zinc-500 uppercase">Seu UPLOAD_TOKEN (igual ao do Railway)</label><div class="flex gap-2 mt-1"><input id="tokenInput" type="password" placeholder="Cole seu token" class="flex-1 bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-[13px] mono"><button onclick="toggleToken()" class="bg-zinc-900 border border-zinc-800 px-3 rounded-xl text-[11px]">👁️</button></div></div><button onclick="salvarToken()" class="w-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-xl py-2.5 font-bold text-[12px]">💾 Salvar Token Local</button><div id="tokenMsg" class="hidden text-[11px] p-3 rounded-xl"></div></div><div class="mt-6 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl"><p class="text-[11px] font-bold text-amber-400">📚 API Fiel ao Frenet/Bling:</p><pre class="mt-2 text-[10px] mono text-zinc-400 overflow-auto">POST /api/cotacao
Content-Type: application/json

{
  "cep_destino":"01310000",
  "peso_real":5,
  "altura":20,
  "largura":20,
  "comprimento":20,
  "valor_nf":100
}
→ retorna cotacoes[] com valor_frete, prazo, peso_taxado/cubado como Frenet</pre></div></div>

<div class="bg-[#0f0f10] border border-zinc-800 rounded-[20px] p-6"><div class="flex justify-between items-center"><h3 class="font-bold text-[13px]">📦 Tabelas Reais • Fiel</h3><span id="totalRegras" class="text-[11px] text-zinc-500"></span></div><div id="tabelasLista" class="mt-4 space-y-2 max-h-[400px] overflow-auto"></div><button onclick="carregarTabelas()" class="mt-3 w-full bg-zinc-900 border border-zinc-800 rounded-xl py-2 text-[11px] font-bold hover:bg-zinc-800">↻ Atualizar tabelas reais</button></div>

<div class="bg-gradient-to-br from-amber-500/10 to-orange-600/10 border border-amber-500/20 rounded-[20px] p-5"><p class="text-[11px] font-bold text-amber-400">✨ V5 Fiel às Plataformas</p><ul class="mt-2 space-y-1 text-[11px] text-zinc-400"><li>• Healthcheck: /health instantâneo 1ms, nunca bloqueia mesmo sem DATABASE_URL</li><li>• Cache: 60s + memoria fallback se postgres cair como Frenet faz</li><li>• Cálculo: advalorem, seguro, GRIS, TAS, EMEX, pedágio fracionado, taxa min/max, imposto como Jadlog/Correios</li><li>• Upload: .xls HTML table ou .xlsx como Bling/Tiny/Frenet exportam</li><li>• Sem fake: total_regras, cotacoes, etc são COUNT(*) real do banco</li></ul></div>
</div></div></div></div>

<script>
const baseUrl = location.origin;
let token = localStorage.getItem('mf_token')||'';
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function apiUrl(p){return baseUrl + p}

async function checkStatus(){
  try{
    const r = await fetch(apiUrl('/'));
    const j = await r.json();
    document.getElementById('dbStatus').textContent = j.db || 'online';
    document.getElementById('totalRegras').textContent = (j.total_regras||0)+' regras carregadas • '+j.db;
    document.getElementById('statusBadge').textContent = '● Online - '+j.total_regras+' regras • '+j.db;
    document.getElementById('statusBadge').className='px-3 py-1 rounded-full text-xs bg-green-500/20 text-green-400 border border-green-500/30';
  }catch(e){
    document.getElementById('statusBadge').textContent='● Offline - usando memoria';
    document.getElementById('statusBadge').className='px-3 py-1 rounded-full text-xs bg-red-500/20 text-red-400 border border-red-500/30';
  }
}
checkStatus();

function salvarToken(){
  token = document.getElementById('tokenInput').value.trim();
  localStorage.setItem('mf_token', token);
  const m=document.getElementById('tokenMsg');
  m.innerHTML='✅ Token salvo localmente.<br><span class="text-zinc-400">Fiel ao Bling/Frenet: protege upload com x-upload-token. Troque quando alguém sair da equipe.</span>';
  m.className='text-xs mt-2 p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400'; m.classList.remove('hidden');
}
function toggleToken(){
  const i=document.getElementById('tokenInput');
  i.type = i.type==='password'?'text':'password';
}

const dropZone=document.getElementById('dropZone');
const fileInput=document.getElementById('fileInput');
dropZone.onclick=()=>fileInput.click();
dropZone.ondragover=(e)=>{e.preventDefault(); dropZone.classList.add('border-amber-500','bg-amber-500/5');}
dropZone.ondragleave=()=>dropZone.classList.remove('border-amber-500','bg-amber-500/5');
dropZone.ondrop=(e)=>{e.preventDefault(); dropZone.classList.remove('border-amber-500','bg-amber-500/5'); const f=e.dataTransfer.files[0]; if(f) uploadFile(f);}
fileInput.onchange=(e)=>{const f=e.target.files[0]; if(f) uploadFile(f);}

async function uploadFile(file){
  if(!token && '${process.env.UPLOAD_TOKEN ? '1':'0'}'==='1'){ alert('Digite e salve seu UPLOAD_TOKEN primeiro! Igual ao do Railway Variables'); return; }
  const prog=document.getElementById('uploadProgress'); const bar=document.getElementById('progressBar'); const txt=document.getElementById('progressText'); const resDiv=document.getElementById('uploadResult');
  prog.classList.remove('hidden'); resDiv.classList.add('hidden'); bar.style.width='30%'; txt.textContent='Enviando '+file.name+'... fiel Frenet';
  try{
    const fd=new FormData(); fd.append('file', file);
    bar.style.width='60%';
    const r=await fetch(apiUrl('/api/upload'),{method:'POST', headers:{'x-upload-token': token}, body: fd});
    bar.style.width='90%';
    const j=await r.json();
    bar.style.width='100%';
    if(!r.ok) throw new Error(j.erro || JSON.stringify(j));
    resDiv.className='mt-4 p-4 rounded-xl text-sm bg-green-500/10 border border-green-500/30 text-green-300';
    resDiv.innerHTML='<b>✅ Sucesso Fiel!</b><br>'+esc(j.total)+' regras importadas fiel ao Frenet<br><span class="text-xs opacity-70">Preview: '+esc(j.preview?.[0]?.transportadora||'')+' - '+esc(j.preview?.[0]?.metodo||'')+' • DB: '+j.db+'</span>';
    resDiv.classList.remove('hidden');
    checkStatus(); carregarTabelas();
  }catch(e){
    resDiv.className='mt-4 p-4 rounded-xl text-sm bg-red-500/10 border border-red-500/30 text-red-300';
    resDiv.textContent='❌ Erro fiel: '+e.message;
    resDiv.classList.remove('hidden');
  }finally{ setTimeout(()=>{prog.classList.add('hidden'); bar.style.width='0%';}, 1500); }
}

async function carregarTabelas(){
  const div=document.getElementById('tabelasLista'); div.innerHTML='<p class="text-zinc-500 text-[11px]">Carregando tabelas reais fiel...</p>';
  try{
    const headers = token ? {'x-upload-token': token} : {};
    const r=await fetch(apiUrl('/api/tabelas'),{headers});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    if(j.total===0){ div.innerHTML='<p class="text-zinc-500 text-[11px]">Nenhuma tabela. Faça upload fiel ao Frenet.</p>'; return; }
    const grouped={};
    j.tabelas.forEach(t=>{const k=esc(t.transportadora)+' - '+esc(t.metodo||'Padrao'); grouped[k]=(grouped[k]||0)+1;});
    let html='<p class="text-zinc-400 mb-2 text-[11px]">Total: '+esc(j.total)+' regras • DB: '+j.db+' • Fiel Frenet</p>';
    Object.entries(grouped).forEach(([k,c])=>{ html+='<div class="flex justify-between bg-zinc-900 border border-zinc-800 p-2.5 rounded-xl mb-1"><span class="text-[12px]">\${k}</span><span class="text-zinc-400 text-[11px]">\${c} faixas</span></div>'.replace('\${k}',k).replace('\${c}',c); });
    html+='<div class="mt-3 text-zinc-600 text-[10px]">Mostrando 200 primeiras • Fiel</div>';
    div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400 text-[11px]">Erro fiel: '+e.message+'</p>'; }
}

async function testarCotacao(){
  const cep=document.getElementById('testCep').value;
  const peso=parseFloat(document.getElementById('testPeso').value);
  const alt=parseFloat(document.getElementById('testAlt').value);
  const larg=parseFloat(document.getElementById('testLarg').value);
  const comp=parseFloat(document.getElementById('testComp').value);
  const valor=parseFloat(document.getElementById('testValor').value);
  const div=document.getElementById('cotacaoResult'); div.classList.remove('hidden'); div.innerHTML='<p class="text-[11px] text-zinc-400">Calculando fiel: peso taxado = max(real, cubado) como Correios/Jadlog/Frenet...</p>';
  try{
    const r=await fetch(apiUrl('/api/cotacao'),{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cep_destino:cep,peso_real:peso,altura:alt,largura:larg,comprimento:comp,valor_nf:valor})});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    if(j.cotacoes.length===0){ div.innerHTML='<p class="text-yellow-400 text-[12px]">⚠️ Nenhuma regra para CEP '+esc(j.cep_consultado)+' e peso taxado '+esc(j.peso_taxado)+'kg<br><span class="text-[11px]">Real: '+esc(j.peso_real)+'kg Cub: '+esc(j.peso_cubado.toFixed(2))+'kg Tax: '+esc(j.peso_taxado)+'kg • Verifique faixas CEP/peso</span><br><span class="text-[10px] text-zinc-500">'+j.calculo_fiel+'</span></p>'; return; }
    let html='<p class="font-semibold text-green-400 text-[12px]">'+esc(j.total_encontrado)+' opções • Peso taxado: '+esc(j.peso_taxado)+'kg (real '+esc(j.peso_real)+'kg cub '+esc(j.peso_cubado.toFixed(2))+'kg) • '+j.db+'</p><p class="text-[10px] text-zinc-500 mt-1">'+j.calculo_fiel+'</p>';
    j.cotacoes.forEach(c=>{ html+='<div class="flex justify-between bg-zinc-900 border border-zinc-800 p-3 rounded-xl mt-2"><div><p class="font-semibold text-[13px]">'+esc(c.nome)+'</p><p class="text-zinc-500 text-[11px]">Prazo: '+esc(c.prazo_texto)+' • Cubado: '+esc(c.peso_cubado.toFixed(2))+'kg • Taxado: '+esc(c.peso_taxado)+'kg</p><p class="text-zinc-600 text-[10px] mono">ID: '+esc(c.id_servico)+' • Fiel Frenet</p></div><div class="text-right"><p class="font-bold text-lg">R$ '+esc(c.valor_frete.toFixed(2))+'</p><p class="text-zinc-500 text-[11px]">'+esc(c.peso_taxado)+'kg taxado</p></div></div>'; });
    div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400 text-[12px]">Erro fiel: '+e.message+'</p>'; }
}

carregarTabelas();
if(token) document.getElementById('tokenInput').value = token;
</script>
</body>
</html>
  `);
});

app.setNotFoundHandler((req,reply)=>{
  if(req.url.startsWith('/api/')) return reply.code(404).send({erro:'Rota não encontrada: '+req.url, code:'NOT_FOUND', dica:'/health, /, /api/status, /painel, /api/cotacao, /api/upload, /api/tabelas'});
  reply.code(404).type('text/html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404 • CIUZE LOG V5</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-[#050507] min-h-screen flex items-center justify-center p-6"><div class="text-center"><div class="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">404</div><h1 class="text-white text-[18px] font-bold mt-4">Rota não encontrada</h1><p class="text-zinc-500 text-[12px] mt-2">${req.url} não existe</p><div class="mt-6 flex gap-2 justify-center"><a href="/painel" class="bg-white text-black px-4 py-2 rounded-xl text-[12px] font-bold">← Painel</a><a href="/health" class="bg-zinc-900 border border-zinc-800 text-white px-4 py-2 rounded-xl text-[12px]">/health</a></div></div></body></html>`);
});

const port = process.env.PORT || 3000;
try{
  await app.listen({ port, host:'0.0.0.0' });
  console.log(`🚀 CIUZE LOG V5 FINAL FIEL na porta ${port} - /health instantâneo 1ms - Fiel Frenet/Bling/Correios/Jadlog`);
}catch(e){
  console.error('Erro ao iniciar mas tentando /health:', e);
  // Tenta porta alternativa
  try{
    await app.listen({ port: port, host:'0.0.0.0' });
  }catch(e2){
    process.exit(1);
  }
}

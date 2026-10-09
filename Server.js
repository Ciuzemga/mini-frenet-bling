
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import 'dotenv/config';

const app = Fastify({ logger: true });
await app.register(cors, { origin: '*' });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

function getPoolConfig(){
  const url = process.env.DATABASE_URL;
  if(!url) return null;
  const needsSSL = url.includes('.rlwy.net') || process.env.PGSSLMODE === 'require';
  const base = { connectionString: url, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 };
  return needsSSL ? { ...base, ssl: { rejectUnauthorized: false } } : base;
}
const pool = process.env.DATABASE_URL ? new pg.Pool(getPoolConfig()) : null;
if(pool) pool.on('error', (e)=> console.error('pg pool erro (cliente ocioso):', e.message));

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
  console.log('DB pronto');
  DB_READY = true;
  }catch(e){ console.error('DB init falhou (tentara novamente no primeiro uso):', e.message); }
}
await initDB();

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
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

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
        throw Object.assign(new Error('banco indisponivel'), { statusCode: 503 });
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

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

app.post('/api/cotacao', async (req, reply)=>{
  const body = req.body || {};
  const cep_destino = body.cep_destino || body.cep || body.destination_zip;
  const peso_real = num(body.peso_real || body.peso, 1);
  const altura = num(body.altura || body.height, 20);
  const largura = num(body.largura || body.width, 20);
  const comprimento = num(body.comprimento || body.length, 20);
  const valor_nf = num(body.valor_nf || body.valor || body.total, 100);

  if(!cep_destino){
    return reply.code(400).send({ erro: 'cep_destino obrigatorio' });
  }

  const cep = parseInt(String(cep_destino).replace(/\D/g,''));
  if(!Number.isFinite(cep) || cep <= 0){
    return reply.code(400).send({ erro: 'cep_destino invalido' });
  }
  let tabelas;
  try{
    tabelas = await getTabelas();
  }catch(e){
    const code = e.statusCode || 503;
    return reply.code(code).send({ erro: 'banco indisponivel', detalhe: e.message });
  }
  if(tabelas.length === 0){
    return { cotacoes: [], aviso: 'Nenhuma tabela carregada. Faca upload em /api/upload', peso_taxado: peso_real, cep_consultado: cep };
  }

  const resultados = [];
  for(const r of tabelas){
    const cubagemRegra = toNum(r.cubagem) || 6000;
    const cub = (altura * largura * comprimento) / cubagemRegra;
    const peso_taxado = Math.max(peso_real, cub);

    if(cep < toNum(r.cep_ini) || cep > toNum(r.cep_fim)) continue;
    if(peso_taxado < toNum(r.peso_ini) || peso_taxado > toNum(r.peso_fim)) continue;
    if(valor_nf < toNum(r.valor_ini) || valor_nf > toNum(r.valor_fim)) continue;
    if(peso_taxado > toNum(r.limite_peso||999)) continue;

    const valor = calcularFrete(r, peso_taxado, valor_nf);
    resultados.push({
      id_servico: `${r.transportadora}-${r.metodo}`.toLowerCase().replace(/[^a-z0-9]+/g,'-'),
      nome: `${r.transportadora} - ${r.metodo}`,
      transportadora: r.transportadora,
      metodo: r.metodo,
      valor_frete: valor,
      prazo: toNum(r.prazo),
      peso_taxado: parseFloat(peso_taxado.toFixed(2)),
      peso_cubado: parseFloat(cub.toFixed(2))
    });
  }
  resultados.sort((a,b)=>a.valor_frete - b.valor_frete);
  const pesoTaxadoResp = Math.max(peso_real, (altura*largura*comprimento)/6000);
  return { cotacoes: resultados, peso_taxado: parseFloat(pesoTaxadoResp.toFixed(2)), cep_consultado: cep, total_encontrado: resultados.length };
});

app.post('/api/upload', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN){
    return reply.code(401).send({ erro: 'token invalido. Defina UPLOAD_TOKEN na Railway e envie header x-upload-token' });
  }
  const file = await req.file();
  if(!file){
    return reply.code(400).send({ erro: 'arquivo ausente. Envie como multipart field file' });
  }
  const buffer = await file.toBuffer();
  const html = buffer.toString('utf-8');
  const parsed = parseTabela(html);
  if(parsed.length === 0){
    return reply.code(400).send({ erro: 'Nenhuma linha valida encontrada. Verifique se a planilha tem dados no tbody' });
  }
  if(pool){
    let client;
    try{
      await ensureDB();
      client = await pool.connect();
    }catch(e){
      return reply.code(503).send({ erro: 'banco indisponivel', detalhe: e.message });
    }
    try{
      await client.query('BEGIN');
      await client.query('DELETE FROM frete_tabelas');
      const INSERT_SQL = `INSERT INTO frete_tabelas (transportadora, metodo, cep_ini, cep_fim, peso_ini, peso_fim, valor_ini, valor_fim, cubagem, limite_peso, prazo, frete_valor, excedente, advalor_perc, peso_excedente, valor_por_kg, despacho, total_minimo, imposto_perc, seguro_perc, seguro_min, gris_perc, gris_min, pedagio, pedagio_fracao, tas_perc, tas_min, emex_perc, emex_min, taxa_min, taxa_max, taxa_perc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`;
      for(const r of parsed){
        await client.query(INSERT_SQL,
        [r.transportadora, r.metodo, r.cep_ini, r.cep_fim, r.peso_ini, r.peso_fim, r.valor_ini, r.valor_fim, r.cubagem, r.limite_peso, r.prazo, r.frete_valor, r.excedente, r.advalor_perc, r.peso_excedente, r.valor_por_kg, r.despacho, r.total_minimo, r.imposto_perc, r.seguro_perc, r.seguro_min, r.gris_perc, r.gris_min, r.pedagio, r.pedagio_fracao, r.tas_perc, r.tas_min, r.emex_perc, r.emex_min, r.taxa_min, r.taxa_max, r.taxa_perc]);
      }
      await client.query('COMMIT');
    } catch(e){
      await client.query('ROLLBACK');
      req.log.error(e);
      return reply.code(500).send({ erro: 'falha ao salvar no banco', detalhe: e.message });
    } finally {
      client.release();
    }
    CACHE_TABELAS = null;
  } else {
    global.TABELAS_MEM = parsed;
    CACHE_TABELAS = parsed;
    CACHE_AT = Date.now();
  }
  return { ok:true, total: parsed.length, preview: parsed.slice(0,3) };
});

app.get('/api/tabelas', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN){
    return reply.code(401).send({ erro: 'nao autorizado' });
  }
  let tabelas;
  try{
    tabelas = await getTabelas();
  }catch(e){
    return reply.code(503).send({ erro: 'banco indisponivel' });
  }
  return { total: tabelas.length, tabelas: tabelas.slice(0,200) };
});

app.get('/', async (req, reply)=>{
  try{
    const tabelas = await getTabelas();
    return { status:'Mini-Frenet rodando', db: pool ? 'postgres' : 'memoria', total_regras: tabelas.length };
  }catch(e){
    return { status:'Mini-Frenet rodando', db: pool ? 'postgres-indisponivel' : 'memoria', total_regras: CACHE_TABELAS?.length || 0, aviso: 'banco indisponivel, usando cache' };
  }
});

app.get('/health', async ()=>({ ok:true, timestamp: new Date().toISOString() }));

const port = process.env.PORT || 3000;
app.listen({ port, host:'0.0.0.0' });

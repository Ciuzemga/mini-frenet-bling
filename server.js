import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import 'dotenv/config';
import XLSX from 'xlsx';

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
if(pool) pool.on('error', (e)=> console.error('pg pool erro:', e.message));

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
      transportadora TEXT NOT NULL,
      metodo TEXT,
      cep_ini INT,
      cep_fim INT,
      peso_ini NUMERIC,
      peso_fim NUMERIC,
      valor_ini NUMERIC,
      valor_fim NUMERIC,
      cubagem NUMERIC DEFAULT 300,
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frete_transp ON frete_tabelas(transportadora);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frete_cep ON frete_tabelas(cep_ini, cep_fim);`);
  console.log('DB pronto');
  DB_READY = true;
  }catch(e){ console.error('DB init falhou:', e.message); }
}
await initDB();

function normKey(k){
  return String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}

function parseTabelaFromRows(rows, forcedTransportadora=null){
  const data=[];
  for(const r of rows){
    const get = (...names)=>{
      for(const n of names){
        const nk=normKey(n);
        for(const key of Object.keys(r)){
          if(normKey(key)===nk || normKey(key).includes(nk)){
            const v=r[key];
            if(v!=='' && v!=null) return v;
          }
        }
      }
      return 0;
    };
    const cep_ini = parseInt(String(get('cep inicial','cep ini','cep_ini','cep inicio')).replace(/\D/g,''))||0;
    const cep_fim = parseInt(String(get('cep final','cep fim','cep_fim')).replace(/\D/g,''))||99999999;
    if(cep_ini===0 && cep_fim===99999999) continue;

    let transportadora = forcedTransportadora;
    if(!transportadora){
      const raw = r['transportadora'] || r['Transportadora'] || r['TRANSPORTADORA'] || '';
      transportadora = raw ? String(raw).trim() : '';
    }
    if(!transportadora) transportadora = 'CIUZE';
    transportadora = transportadora.toUpperCase().trim();

    const metodoRaw = r['metodo']||r['Metodo']||r['Formula']||r['formula']||'Frete Peso';
    const metodo = String(metodoRaw).trim() || 'Frete Peso';

    data.push({
      transportadora,
      metodo,
      cep_ini,
      cep_fim,
      peso_ini: parseFloat(String(get('peso inicial','peso ini','peso_inicial')).replace(',','.'))||0,
      peso_fim: parseFloat(String(get('peso final','peso_fim','peso final kg')).replace(',','.'))||999,
      valor_ini: parseFloat(String(get('valor inicial','valor ini','valor inicial r$')).replace(',','.'))||0,
      valor_fim: parseFloat(String(get('valor final','valor fim','valor final r$')).replace(',','.'))||9999999,
      cubagem: parseFloat(String(get('cubagem','fator cubagem')).replace(',','.'))||300,
      limite_peso: parseFloat(String(get('limite peso','limite peso kg')).replace(',','.'))||5000,
      prazo: parseInt(String(get('prazo entrega','prazo','prazo dias')))||5,
      frete_valor: parseFloat(String(get('frete valor','frete valor r$','frete')).replace(',','.'))||0,
      excedente: parseFloat(String(get('excedente','excedente r$')).replace(',','.'))||0,
      advalor_perc: parseFloat(String(get('advalor %','advalor','ad valorem')).replace(',','.'))||0,
      peso_excedente: parseFloat(String(get('peso excedente','fracao taxa peso')).replace(',','.'))||0,
      valor_por_kg: parseFloat(String(get('valor por kg','valor por kg r$','valor por kg')).replace(',','.'))||0,
      despacho: parseFloat(String(get('despacho','despacho r$')).replace(',','.'))||0,
      total_minimo: parseFloat(String(get('total minimo','total minimo r$')).replace(',','.'))||0,
      imposto_perc: parseFloat(String(get('imposto %','imposto')).replace(',','.'))||0,
      seguro_perc: parseFloat(String(get('seguro %','seguro perc')).replace(',','.'))||0,
      seguro_min: parseFloat(String(get('seguro minimo','seguro min')).replace(',','.'))||0,
      gris_perc: parseFloat(String(get('gris %','gris')).replace(',','.'))||0,
      gris_min: parseFloat(String(get('gris minimo','gris min')).replace(',','.'))||0,
      pedagio: parseFloat(String(get('pedagio r$','pedagio')).replace(',','.'))||0,
      pedagio_fracao: parseFloat(String(get('pedagio fracao','pedagio fração')).replace(',','.'))||0,
      tas_perc: parseFloat(String(get('tas %','tas perc')).replace(',','.'))||0,
      tas_min: parseFloat(String(get('tas minimo','tas min')).replace(',','.'))||0,
      emex_perc: parseFloat(String(get('emex %','emex perc')).replace(',','.'))||0,
      emex_min: parseFloat(String(get('emex minimo','emex min')).replace(',','.'))||0,
      taxa_min: parseFloat(String(get('taxa minima','taxa min')).replace(',','.'))||0,
      taxa_max: parseFloat(String(get('taxa maxima','taxa max')).replace(',','.'))||0,
      taxa_perc: parseFloat(String(get('taxa %','taxa perc')).replace(',','.'))||0,
    });
  }
  return data;
}

function parseTabelaHTML(html, forcedTransportadora=null){
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  const colRegex = /<t[dh][^>]*>(.*?)<\/t[dh]>/gis;
  const rows = [...html.matchAll(rowRegex)].map(m=>m[1]);
  const tmp=[];
  for(let i=1;i<rows.length;i++){
    const cols = [...rows[i].matchAll(colRegex)].map(m=>m[1].replace(/<[^>]*>/g,'').trim());
    if(cols.length < 3) continue;
    let offset=0;
    let transp = forcedTransportadora;
    if(!transp && cols[0] && isNaN(parseInt(cols[0]))){
      transp = cols[0];
      offset=1;
    }
    if(!transp) transp='CIUZE';
    tmp.push({
      transportadora: transp,
      CepInicial: cols[0+offset]||0,
      CepFinal: cols[1+offset]||99999999,
      PesoInicial: cols[2+offset]||0,
      PesoFinal: cols[3+offset]||999,
      ValorInicial: cols[4+offset]||0,
      ValorFinal: cols[5+offset]||9999999,
      Cubagem: cols[6+offset]||300,
      LimitePeso: cols[7+offset]||5000,
      Prazo: cols[8+offset]||5,
      FreteValor: cols[10+offset]||0,
    });
  }
  return parseTabelaFromRows(tmp.map(o=>({
    transportadora: o.transportadora,
    'Cep Inicial': o.CepInicial,
    'Cep Final': o.CepFinal,
    'Peso Inicial Kg': o.PesoInicial,
    'Peso Final Kg': o.PesoFinal,
    'Valor Inicial R$': o.ValorInicial,
    'Valor Final R$': o.ValorFinal,
    'Cubagem': o.Cubagem,
    'Limite Peso Kg': o.LimitePeso,
    'Prazo Entrega': o.Prazo,
    'Frete Valor R$': o.FreteValor,
  })), forcedTransportadora);
}

function parseTabelaXLSX(buffer, forcedTransportadora=null){
  const wb = XLSX.read(buffer, {type:'buffer'});
  const firstSheet = wb.SheetNames[0];
  const ws = wb.Sheets[firstSheet];
  const json = XLSX.utils.sheet_to_json(ws, {defval:0});
  if(json.length===0) return [];
  return parseTabelaFromRows(json, forcedTransportadora);
}

function parseTabela(buffer, filename='', forcedTransportadora=null){
  const name = (filename||'').toLowerCase();
  const isZip = buffer[0]===0x50 && buffer[1]===0x4B;
  const isXlsxName = name.endsWith('.xlsx') || name.endsWith('.xls');
  if(isZip || isXlsxName){
    try{
      const d = parseTabelaXLSX(buffer, forcedTransportadora);
      if(d.length>0) return d;
    }catch(e){ console.log('Falha XLSX:', e.message); }
  }
  const html = buffer.toString('utf-8');
  if(html.includes('<tr') || html.includes('<TR')){
    return parseTabelaHTML(html, forcedTransportadora);
  }
  if(html.includes(';') || html.includes(',')){
    const lines = html.split(/\r?\n/).filter(l=>l.trim());
    if(lines.length>1){
      const headers = lines[0].split(/;|,/).map(h=>h.trim());
      const rows = lines.slice(1).map(l=>{
        const vals = l.split(/;|,/);
        const obj={};
        headers.forEach((h,i)=>obj[h]=vals[i]);
        return obj;
      });
      return parseTabelaFromRows(rows, forcedTransportadora);
    }
  }
  return [];
}

function toNum(v){ const n=Number(v); return isNaN(n)?0:n; }
function calcularFrete(regra, peso_taxado, valor_nf){
  let total = toNum(regra.frete_valor);
  const pe = toNum(regra.peso_excedente);
  const vkg = toNum(regra.valor_por_kg);
  if(peso_taxado > pe && vkg > 0){ total += (peso_taxado - pe) * vkg; total += toNum(regra.excedente); }
  total += toNum(regra.despacho);
  const advalor = valor_nf * (toNum(regra.advalor_perc)/100);
  const seguro = Math.max(valor_nf * (toNum(regra.seguro_perc)/100), toNum(regra.seguro_min));
  const gris = Math.max(valor_nf * (toNum(regra.gris_perc)/100), toNum(regra.gris_min));
  const tas = Math.max(valor_nf * (toNum(regra.tas_perc)/100), toNum(regra.tas_min));
  const emex = Math.max(valor_nf * (toNum(regra.emex_perc)/100), toNum(regra.emex_min));
  total += advalor + seguro + gris + tas + emex;
  const pedFrac = toNum(regra.pedagio_fracao);
  const ped = toNum(regra.pedagio);
  if(pedFrac>0 && ped>0) total += Math.ceil(peso_taxado/pedFrac)*ped; else total+=ped;
  const taxaPerc = toNum(regra.taxa_perc);
  if(taxaPerc>0){
    let taxa = total*(taxaPerc/100);
    if(toNum(regra.taxa_min)>0) taxa=Math.max(taxa,toNum(regra.taxa_min));
    if(toNum(regra.taxa_max)>0) taxa=Math.min(taxa,toNum(regra.taxa_max));
    total+=taxa;
  }
  if(toNum(regra.total_minimo)>0) total=Math.max(total,toNum(regra.total_minimo));
  if(toNum(regra.imposto_perc)>0) total*=(1+toNum(regra.imposto_perc)/100);
  return parseFloat(total.toFixed(2));
}

async function getTabelas(force=false){
  const now=Date.now();
  if(!force && CACHE_TABELAS && (now-CACHE_AT)<60000) return CACHE_TABELAS;
  let rows;
  if(pool){
    await ensureDB();
    try{ const res=await pool.query('SELECT * FROM frete_tabelas ORDER BY transportadora, cep_ini'); rows=res.rows; }
    catch(e){ if(CACHE_TABELAS) rows=CACHE_TABELAS; else throw Object.assign(new Error('banco indisponivel'),{statusCode:503}); }
  } else { global.TABELAS_MEM=global.TABELAS_MEM||[]; rows=global.TABELAS_MEM; }
  CACHE_TABELAS=rows; CACHE_AT=now; return rows;
}

async function getResumoTransportadoras(){
  const tabelas = await getTabelas();
  const map={};
  for(const t of tabelas){
    const key = (t.transportadora||'CIUZE').toUpperCase();
    if(!map[key]) map[key]={transportadora:key, total:0, metodos:new Set(), prazoMin:999, prazoMax:0, updated: t.created_at};
    map[key].total++;
    map[key].metodos.add(t.metodo);
    const prazo=toNum(t.prazo);
    if(prazo>0){ map[key].prazoMin=Math.min(map[key].prazoMin,prazo); map[key].prazoMax=Math.max(map[key].prazoMax,prazo); }
    if(t.created_at && (!map[key].updated || t.created_at>map[key].updated)) map[key].updated=t.created_at;
  }
  return Object.values(map).map(m=>({...m, metodos:[...m.metodos], prazoMin: m.prazoMin===999?5:m.prazoMin}));
}

const num = (v,d)=>{ const n=parseFloat(v); return Number.isFinite(n)?n:d; };

app.post('/api/cotacao', async (req, reply)=>{
  const body=req.body||{};
  const cep_destino=body.cep_destino||body.cep||body.destination_zip;
  const peso_real=num(body.peso_real||body.peso,1);
  const altura=num(body.altura||body.height,20);
  const largura=num(body.largura||body.width,20);
  const comprimento=num(body.comprimento||body.length,20);
  const valor_nf=num(body.valor_nf||body.valor||body.total,100);
  if(!cep_destino) return reply.code(400).send({erro:'cep_destino obrigatorio'});
  const cep=parseInt(String(cep_destino).replace(/\D/g,''));
  if(!Number.isFinite(cep)||cep<=0) return reply.code(400).send({erro:'cep_destino invalido'});
  let tabelas;
  try{ tabelas=await getTabelas(); }catch(e){ return reply.code(e.statusCode||503).send({erro:'banco indisponivel',detalhe:e.message}); }
  if(tabelas.length===0) return {cotacoes:[], aviso:'Nenhuma tabela carregada. Faca upload em /painel', peso_taxado:peso_real, cep_consultado:cep};

  const porTransportadora={};
  for(const r of tabelas){
    const cubagemRegra=toNum(r.cubagem)||300;
    const cub=(altura*largura*comprimento)/cubagemRegra;
    const peso_taxado=Math.max(peso_real,cub);
    if(cep < toNum(r.cep_ini) || cep > toNum(r.cep_fim)) continue;
    if(peso_taxado < toNum(r.peso_ini) || peso_taxado > toNum(r.peso_fim)) continue;
    if(valor_nf < toNum(r.valor_ini) || valor_nf > toNum(r.valor_fim)) continue;
    if(peso_taxado > toNum(r.limite_peso||99999)) continue;
    const valor=calcularFrete(r, peso_taxado, valor_nf);
    const transpKey = (r.transportadora||'CIUZE').toUpperCase();
    if(!porTransportadora[transpKey] || valor < porTransportadora[transpKey].valor_frete){
      porTransportadora[transpKey]={
        id_servico: transpKey.toLowerCase().replace(/[^a-z0-9]+/g,'-'),
        nome: transpKey,
        transportadora: transpKey,
        metodo: r.metodo,
        valor_frete: valor,
        prazo: toNum(r.prazo),
        peso_taxado: parseFloat(peso_taxado.toFixed(2)),
        peso_cubado: parseFloat(cub.toFixed(2)),
        regra_id: r.id
      };
    }
  }
  const resultados = Object.values(porTransportadora).sort((a,b)=>a.valor_frete-b.valor_frete);
  const pesoTaxadoResp=Math.max(peso_real,(altura*largura*comprimento)/300);
  return {cotacoes:resultados, peso_taxado:parseFloat(pesoTaxadoResp.toFixed(2)), cep_consultado:cep, total_encontrado:resultados.length, transportadoras: Object.keys(porTransportadora).length };
});

app.post('/api/upload', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN){
    return reply.code(401).send({ erro: 'token invalido. Defina UPLOAD_TOKEN na Railway e envie header x-upload-token' });
  }
  let forcedTransp = null;
  const file = await req.file();
  if(!file) return reply.code(400).send({ erro: 'arquivo ausente. Envie como multipart field file' });

  if(file.fields && file.fields.transportadora){
    forcedTransp = file.fields.transportadora.value;
  }
  if(!forcedTransp && req.headers['x-transportadora']) forcedTransp = req.headers['x-transportadora'];
  if(!forcedTransp && req.query && req.query.transportadora) forcedTransp = req.query.transportadora;

  if(!forcedTransp) return reply.code(400).send({ erro: 'Informe o nome da transportadora. Campo transportadora é obrigatório.' });

  forcedTransp = String(forcedTransp).toUpperCase().trim();
  if(forcedTransp.length < 2) return reply.code(400).send({ erro: 'Nome da transportadora muito curto' });

  const buffer = await file.toBuffer();
  const filename = file.filename || '';
  const parsed = parseTabela(buffer, filename, forcedTransp);
  if(parsed.length===0) return reply.code(400).send({ erro: 'Nenhuma linha valida encontrada. Verifique a planilha. Formatos: .xlsx, .xls, .html, .htm' });

  if(pool){
    let client;
    try{ await ensureDB(); client=await pool.connect(); }catch(e){ return reply.code(503).send({ erro:'banco indisponivel', detalhe:e.message }); }
    try{
      await client.query('BEGIN');
      await client.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)', [forcedTransp]);
      const INSERT_SQL = `INSERT INTO frete_tabelas (transportadora, metodo, cep_ini, cep_fim, peso_ini, peso_fim, valor_ini, valor_fim, cubagem, limite_peso, prazo, frete_valor, excedente, advalor_perc, peso_excedente, valor_por_kg, despacho, total_minimo, imposto_perc, seguro_perc, seguro_min, gris_perc, gris_min, pedagio, pedagio_fracao, tas_perc, tas_min, emex_perc, emex_min, taxa_min, taxa_max, taxa_perc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`;
      for(const r of parsed){
        await client.query(INSERT_SQL, [r.transportadora, r.metodo, r.cep_ini, r.cep_fim, r.peso_ini, r.peso_fim, r.valor_ini, r.valor_fim, r.cubagem, r.limite_peso, r.prazo, r.frete_valor, r.excedente, r.advalor_perc, r.peso_excedente, r.valor_por_kg, r.despacho, r.total_minimo, r.imposto_perc, r.seguro_perc, r.seguro_min, r.gris_perc, r.gris_min, r.pedagio, r.pedagio_fracao, r.tas_perc, r.tas_min, r.emex_perc, r.emex_min, r.taxa_min, r.taxa_max, r.taxa_perc]);
      }
      await client.query('COMMIT');
    }catch(e){ await client.query('ROLLBACK'); req.log.error(e); return reply.code(500).send({ erro:'falha ao salvar', detalhe:e.message }); }
    finally{ client.release(); }
    CACHE_TABELAS=null;
  } else {
    global.TABELAS_MEM = global.TABELAS_MEM || [];
    global.TABELAS_MEM = global.TABELAS_MEM.filter(r=> (r.transportadora||'').toUpperCase() !== forcedTransp);
    global.TABELAS_MEM.push(...parsed);
    CACHE_TABELAS = global.TABELAS_MEM;
    CACHE_AT=Date.now();
  }
  return { ok:true, transportadora:forcedTransp, total:parsed.length, mensagem: `Tabela ${forcedTransp} atualizada. ${parsed.length} regras. Anterior removida para economizar espaço.`, preview: parsed.slice(0,3) };
});

app.get('/api/tabelas', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  try{
    const resumo = await getResumoTransportadoras();
    const tabelas = await getTabelas();
    return { total: tabelas.length, transportadoras: resumo, tabelas: tabelas.slice(0,200) };
  }catch(e){ return reply.code(503).send({ erro:'banco indisponivel' }); }
});

app.get('/api/transportadoras', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  try{
    const resumo = await getResumoTransportadoras();
    return { total: resumo.length, transportadoras: resumo };
  }catch(e){ return reply.code(503).send({ erro:'banco indisponivel' }); }
});

app.delete('/api/tabelas/:transportadora', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  const transp = (req.params.transportadora||'').toUpperCase().trim();
  if(!transp) return reply.code(400).send({ erro:'transportadora obrigatoria' });
  if(pool){
    try{
      await ensureDB();
      const res = await pool.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)', [transp]);
      CACHE_TABELAS=null;
      return { ok:true, transportadora:transp, removidas: res.rowCount };
    }catch(e){ return reply.code(500).send({ erro:e.message }); }
  } else {
    const antes = (global.TABELAS_MEM||[]).length;
    global.TABELAS_MEM = (global.TABELAS_MEM||[]).filter(r=> (r.transportadora||'').toUpperCase() !== transp);
    CACHE_TABELAS=global.TABELAS_MEM;
    return { ok:true, transportadora:transp, removidas: antes - CACHE_TABELAS.length };
  }
});

app.get('/', async (req, reply)=>{
  try{ const tabelas=await getTabelas(); const resumo=await getResumoTransportadoras(); return { status:'Mini-Frenet rodando', db: pool?'postgres':'memoria', total_regras:tabelas.length, transportadoras: resumo.length, lista_transportadoras: resumo.map(r=>r.transportadora) }; }
  catch(e){ return { status:'Mini-Frenet rodando', db: pool?'postgres-indisponivel':'memoria', total_regras:CACHE_TABELAS?.length||0, aviso:'banco indisponivel, usando cache' }; }
});

app.get('/health', async ()=>({ ok:true, timestamp:new Date().toISOString() }));

app.get('/painel', async (req, reply)=>{
  reply.type('text/html').send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mini-Frenet - Painel Completo</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>body{font-family:Inter,sans-serif}</style>
</head>
<body class="bg-[#0f0f10] text-white min-h-screen">
<div class="max-w-7xl mx-auto p-4 md:p-8">
  <div class="flex items-center justify-between mb-8">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center font-bold">MF</div>
      <div><h1 class="font-bold text-xl">Mini-Frenet</h1><p class="text-xs text-zinc-400">Painel Multi-Transportadora</p></div>
    </div>
    <div id="statusBadge" class="px-3 py-1 rounded-full text-xs bg-zinc-800 text-zinc-400">Carregando...</div>
  </div>

  <div class="grid md:grid-cols-4 gap-4 mb-8">
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5"><p class="text-zinc-400 text-xs">Status DB</p><p id="dbStatus" class="text-lg font-semibold mt-1">-</p><p id="totalRegras" class="text-xs text-zinc-500 mt-1"></p></div>
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5"><p class="text-zinc-400 text-xs">Transportadoras</p><p id="totalTransp" class="text-lg font-semibold mt-1">-</p><p class="text-xs text-zinc-500 mt-1">cadastradas</p></div>
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5"><p class="text-zinc-400 text-xs">API Cotação</p><p class="text-sm font-mono mt-1 break-all">/api/cotacao</p><p class="text-xs text-green-400 mt-2">● 1 preço por transportadora</p></div>
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5"><p class="text-zinc-400 text-xs">Link Bling</p><button onclick="copyLink()" class="mt-2 text-xs bg-violet-600 hover:bg-violet-500 px-3 py-2 rounded-lg w-full">Copiar Link Bling</button><p id="copyMsg" class="text-xs text-green-400 mt-1 hidden">Copiado!</p></div>
  </div>

  <div class="grid lg:grid-cols-5 gap-6">
    <div class="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
      <h2 class="font-semibold mb-4">🔐 Acesso</h2>
      <label class="text-xs text-zinc-400">Token UPLOAD_TOKEN</label>
      <div class="flex gap-2 mt-1">
        <input id="tokenInput" type="password" placeholder="Digite seu token" class="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-violet-500">
        <button onclick="toggleToken()" class="px-3 bg-zinc-800 border border-zinc-700 rounded-xl text-xs">👁️</button>
      </div>
      <button onclick="salvarToken()" class="mt-3 w-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl py-2.5 text-sm">Salvar Token</button>
      <p id="tokenMsg" class="text-xs mt-2 hidden"></p>

      <h3 class="font-semibold mt-8 mb-3">📤 Upload por Transportadora</h3>
      <div class="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4 mb-4">
        <label class="text-xs text-zinc-300 font-semibold">Nome da Transportadora *</label>
        <input id="transpInput" placeholder="Ex: BRASPRESS, JADLOG, CORREIOS, CIUZE" class="w-full mt-2 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm uppercase font-semibold tracking-wide outline-none focus:border-violet-500" oninput="this.value=this.value.toUpperCase()">
        <p class="text-[11px] text-zinc-500 mt-2">Se já existir, a antiga é APAGADA e substituída (economiza espaço).</p>
      </div>

      <div id="dropZone" class="border-2 border-dashed border-zinc-700 rounded-2xl p-8 text-center hover:border-violet-500/50 transition cursor-pointer bg-zinc-800/30">
        <div class="text-3xl mb-2">📄</div>
        <p class="text-sm font-medium">Arraste a planilha aqui</p>
        <p class="text-xs text-zinc-500 mt-1">.xlsx, .xls, .html, .htm</p>
        <p class="text-xs text-zinc-600 mt-3">ou clique para selecionar</p>
        <input id="fileInput" type="file" accept=".xlsx,.xls,.html,.htm" class="hidden">
      </div>
      <div id="uploadProgress" class="hidden mt-4"><div class="h-2 bg-zinc-800 rounded-full overflow-hidden"><div id="progressBar" class="h-full bg-violet-500 transition-all" style="width:0%"></div></div><p id="progressText" class="text-xs text-zinc-400 mt-2"></p></div>
      <div id="uploadResult" class="hidden mt-4 p-4 rounded-xl text-sm"></div>
    </div>

    <div class="lg:col-span-3 space-y-6">
      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold">🚚 Transportadoras Cadastradas</h3>
          <button onclick="carregarTabelas()" class="text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-3 py-2 rounded-lg">🔄 Atualizar</button>
        </div>
        <div id="transpLista" class="space-y-3"></div>
        <div id="tabelasResumo" class="mt-4 text-xs text-zinc-500"></div>
      </div>

      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
        <h3 class="font-semibold mb-4">🧪 Testar Cotação (Multi-Transportadora)</h3>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-xs text-zinc-400">CEP Destino</label><input id="testCep" value="87010000" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm"></div>
          <div><label class="text-xs text-zinc-400">Peso (kg)</label><input id="testPeso" value="5" type="number" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm"></div>
          <div><label class="text-xs text-zinc-400">Altura (cm)</label><input id="testAlt" value="20" type="number" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm"></div>
          <div><label class="text-xs text-zinc-400">Largura (cm)</label><input id="testLarg" value="20" type="number" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm"></div>
          <div><label class="text-xs text-zinc-400">Comprimento (cm)</label><input id="testComp" value="30" type="number" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm"></div>
          <div><label class="text-xs text-zinc-400">Valor NF</label><input id="testValor" value="100" type="number" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm"></div>
        </div>
        <button onclick="testarCotacao()" class="mt-4 w-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 rounded-xl py-2.5 text-sm font-semibold">Calcular Frete por Transportadora</button>
        <div id="cotacaoResult" class="hidden mt-4 p-4 bg-zinc-800 rounded-xl text-xs space-y-2"></div>
      </div>
    </div>
  </div>

  <p class="text-center text-xs text-zinc-600 mt-10">Ao subir nova tabela da mesma transportadora, a anterior é removida automaticamente • Dados só com UPLOAD_TOKEN</p>
</div>

<script>
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token = localStorage.getItem('mf_token') || '';
document.getElementById('tokenInput').value = token;
const baseUrl = window.location.origin;
function apiUrl(p){return baseUrl + p}

async function checkStatus(){
  try{
    const r = await fetch(apiUrl('/'));
    const j = await r.json();
    document.getElementById('dbStatus').textContent = j.db || 'online';
    document.getElementById('totalRegras').textContent = (j.total_regras||0)+' regras • '+(j.transportadoras||0)+' transportadoras';
    document.getElementById('totalTransp').textContent = j.transportadoras||0;
    document.getElementById('statusBadge').textContent = '● Online - '+(j.total_regras||0)+' regras • '+(j.transportadoras||0)+' transp.';
    document.getElementById('statusBadge').className='px-3 py-1 rounded-full text-xs bg-green-500/20 text-green-400 border border-green-500/30';
  }catch(e){ document.getElementById('statusBadge').textContent='● Offline'; }
}
checkStatus();

function salvarToken(){
  token = document.getElementById('tokenInput').value.trim();
  localStorage.setItem('mf_token', token);
  const m=document.getElementById('tokenMsg');
  m.innerHTML='✅ Token salvo localmente.<br><span class="text-zinc-400">Protege upload, listagem e exclusão.</span>';
  m.className='text-xs mt-2 text-green-400'; m.classList.remove('hidden');
  carregarTabelas();
}
function toggleToken(){ const i=document.getElementById('tokenInput'); i.type = i.type==='password'?'text':'password'; }
function copyLink(){ const link = baseUrl + '/api/cotacao'; navigator.clipboard.writeText(link); const msg=document.getElementById('copyMsg'); msg.classList.remove('hidden'); setTimeout(()=>msg.classList.add('hidden'),2000); }

const dropZone=document.getElementById('dropZone');
const fileInput=document.getElementById('fileInput');
dropZone.onclick=()=>fileInput.click();
dropZone.ondragover=(e)=>{e.preventDefault(); dropZone.classList.add('border-violet-500');}
dropZone.ondragleave=()=>dropZone.classList.remove('border-violet-500');
dropZone.ondrop=(e)=>{e.preventDefault(); dropZone.classList.remove('border-violet-500'); const f=e.dataTransfer.files[0]; if(f) uploadFile(f);}
fileInput.onchange=(e)=>{const f=e.target.files[0]; if(f) uploadFile(f);}

async function uploadFile(file){
  if(!token){ alert('Digite e salve seu UPLOAD_TOKEN primeiro!'); return; }
  const transp = document.getElementById('transpInput').value.trim().toUpperCase();
  if(!transp){ alert('Digite o nome da transportadora primeiro! Ex: BRASPRESS'); document.getElementById('transpInput').focus(); return; }
  if(transp.length<2){ alert('Nome da transportadora muito curto'); return; }

  const prog=document.getElementById('uploadProgress'); const bar=document.getElementById('progressBar'); const txt=document.getElementById('progressText'); const resDiv=document.getElementById('uploadResult');
  prog.classList.remove('hidden'); resDiv.classList.add('hidden'); bar.style.width='30%'; txt.textContent='Enviando '+file.name+' como '+transp+'...';
  try{
    const fd=new FormData(); fd.append('file', file); fd.append('transportadora', transp);
    bar.style.width='60%';
    const r=await fetch(apiUrl('/api/upload'),{method:'POST', headers:{'x-upload-token': token, 'x-transportadora': transp}, body: fd});
    bar.style.width='90%';
    const j=await r.json();
    bar.style.width='100%';
    if(!r.ok) throw new Error(j.erro || JSON.stringify(j));
    resDiv.className='mt-4 p-4 rounded-xl text-sm bg-green-500/10 border border-green-500/30 text-green-300';
    resDiv.innerHTML='<b>✅ Sucesso!</b><br>Transportadora: <b>'+esc(j.transportadora)+'</b><br>'+esc(j.total)+' regras importadas<br><span class="text-xs opacity-70">'+esc(j.mensagem||'')+'</span>';
    resDiv.classList.remove('hidden');
    checkStatus(); carregarTabelas();
  }catch(e){
    resDiv.className='mt-4 p-4 rounded-xl text-sm bg-red-500/10 border border-red-500/30 text-red-300';
    resDiv.textContent='❌ Erro: '+e.message;
    resDiv.classList.remove('hidden');
  }finally{ setTimeout(()=>{prog.classList.add('hidden'); bar.style.width='0%';}, 1500); }
}

async function carregarTabelas(){
  if(!token){ document.getElementById('transpLista').innerHTML='<p class="text-zinc-500 text-sm">Salve o token para ver as transportadoras</p>'; return; }
  const div=document.getElementById('transpLista'); const resumoDiv=document.getElementById('tabelasResumo');
  div.innerHTML='Carregando...';
  try{
    const r=await fetch(apiUrl('/api/transportadoras'),{headers:{'x-upload-token': token}});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    if(j.total===0){ div.innerHTML='<p class="text-zinc-500 text-sm">Nenhuma transportadora cadastrada ainda. Faça upload informando o nome.</p>'; resumoDiv.textContent=''; return; }
    let html='';
    j.transportadoras.forEach(t=>{
      html+= \`
      <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 flex items-center justify-between">
        <div class="flex-1">
          <p class="font-bold text-sm tracking-wide">\${esc(t.transportadora)}</p>
          <p class="text-xs text-zinc-400 mt-1">\${esc(t.total)} regras • \${esc(t.metodos?.join(', ')||'')} • Prazo \${esc(t.prazoMin)}-\${esc(t.prazoMax)} dias</p>
          <p class="text-[11px] text-zinc-500 mt-1">Atualizada: \${t.updated ? new Date(t.updated).toLocaleString('pt-BR') : '-'}</p>
        </div>
        <div class="flex flex-col gap-2 ml-4">
          <button onclick="deletarTransp('\${esc(t.transportadora)}')" class="text-xs bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 px-3 py-2 rounded-lg">🗑️ Excluir</button>
          <button onclick="selecionarTransp('\${esc(t.transportadora)}')" class="text-xs bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 px-3 py-2 rounded-lg">Usar no upload</button>
        </div>
      </div>\`;
    });
    div.innerHTML=html;
    resumoDiv.textContent='Total: '+j.total+' transportadoras • '+j.transportadoras.reduce((s,t)=>s+t.total,0)+' regras no banco';
  }catch(e){ div.innerHTML='<p class="text-red-400 text-sm">Erro: '+esc(e.message)+'</p>'; }
}

function selecionarTransp(nome){ document.getElementById('transpInput').value=nome; window.scrollTo({top:0, behavior:'smooth'}); }
async function deletarTransp(nome){
  if(!confirm('Excluir TODAS as regras da transportadora '+nome+'? Isso não pode ser desfeito.')) return;
  try{
    const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(nome)),{method:'DELETE', headers:{'x-upload-token': token}});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    alert('Removidas '+j.removidas+' regras de '+nome);
    checkStatus(); carregarTabelas();
  }catch(e){ alert('Erro: '+e.message); }
}

async function testarCotacao(){
  const cep=document.getElementById('testCep').value;
  const peso=parseFloat(document.getElementById('testPeso').value);
  const alt=parseFloat(document.getElementById('testAlt').value);
  const larg=parseFloat(document.getElementById('testLarg').value);
  const comp=parseFloat(document.getElementById('testComp').value);
  const valor=parseFloat(document.getElementById('testValor').value);
  const div=document.getElementById('cotacaoResult'); div.classList.remove('hidden'); div.innerHTML='Calculando...';
  try{
    const r=await fetch(apiUrl('/api/cotacao'),{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cep_destino:cep,peso_real:peso,altura:alt,largura:larg,comprimento:comp,valor_nf:valor})});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    if(j.cotacoes.length===0){ div.innerHTML='<p class="text-yellow-400">⚠️ Nenhuma regra encontrada para CEP '+esc(j.cep_consultado)+' e peso '+esc(j.peso_taxado)+'kg.</p>'; return; }
    let html='<p class="font-semibold text-green-400">'+esc(j.total_encontrado)+' transportadoras encontradas (peso taxado: '+esc(j.peso_taxado)+'kg)</p>';
    j.cotacoes.forEach(c=>{ html+='<div class="flex justify-between bg-zinc-900 border border-zinc-800 p-3 rounded-xl mt-2"><div><p class="font-bold text-sm tracking-wide">'+esc(c.transportadora)+'</p><p class="text-zinc-500 text-xs">Método: '+esc(c.metodo)+' • Prazo: '+esc(c.prazo)+' dias • Cubado: '+esc(c.peso_cubado)+'kg</p></div><div class="text-right"><p class="font-bold text-lg">R$ '+esc(c.valor_frete.toFixed(2))+'</p><p class="text-zinc-500 text-xs">'+esc(c.peso_taxado)+'kg taxado</p></div></div>'; });
    div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400">Erro: '+e.message+'</p>'; }
}
</script>
</body>
</html>
  `);
});

app.get('/api/status', async ()=>{
  const t = await getTabelas().catch(()=>CACHE_TABELAS||[]);
  const resumo = await getResumoTransportadoras().catch(()=>[]);
  return { status:'ok', db: pool?'postgres':'memoria', total:t.length, transportadoras: resumo.length, uptime: process.uptime() };
});

const port = process.env.PORT || 3000;
app.listen({ port, host:'0.0.0.0' });

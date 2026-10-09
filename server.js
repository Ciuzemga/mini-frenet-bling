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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frete_transp ON frete_tabelas(transportadora);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frete_cep ON frete_tabelas(cep_ini, cep_fim);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frete_peso ON frete_tabelas(peso_ini, peso_fim);`);
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

function parseTabelaXLSX(buffer, forcedTransportadora=null){
  const wb = XLSX.read(buffer, {type:'buffer'});
  const firstSheet = wb.SheetNames[0];
  const ws = wb.Sheets[firstSheet];
  const json = XLSX.utils.sheet_to_json(ws, {defval:0});
  if(json.length===0) return [];
  return parseTabelaFromRows(json, forcedTransportadora);
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
    try{ const res=await pool.query('SELECT * FROM frete_tabelas ORDER BY transportadora, cep_ini, peso_ini'); rows=res.rows; }
    catch(e){ if(CACHE_TABELAS) rows=CACHE_TABELAS; else throw Object.assign(new Error('banco indisponivel'),{statusCode:503}); }
  } else { global.TABELAS_MEM=global.TABELAS_MEM||[]; rows=global.TABELAS_MEM; }
  CACHE_TABELAS=rows; CACHE_AT=now; return rows;
}

async function getResumoTransportadoras(){
  const tabelas = await getTabelas();
  const map={};
  for(const t of tabelas){
    const key = (t.transportadora||'CIUZE').toUpperCase();
    if(!map[key]) map[key]={transportadora:key, total:0, metodos:new Set(), prazoMin:999, prazoMax:0, updated: t.created_at, updated_at: t.updated_at};
    map[key].total++;
    map[key].metodos.add(t.metodo);
    const prazo=toNum(t.prazo);
    if(prazo>0){ map[key].prazoMin=Math.min(map[key].prazoMin,prazo); map[key].prazoMax=Math.max(map[key].prazoMax,prazo); }
    if(t.updated_at && (!map[key].updated_at || t.updated_at>map[key].updated_at)) map[key].updated_at=t.updated_at;
    if(t.created_at && (!map[key].updated || t.created_at>map[key].updated)) map[key].updated=t.created_at;
  }
  return Object.values(map).map(m=>({...m, metodos:[...m.metodos], prazoMin: m.prazoMin===999?5:m.prazoMin}));
}

const num = (v,d)=>{ const n=parseFloat(v); return Number.isFinite(n)?n:d; };

// ROTAS

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
  if(file.fields && file.fields.transportadora){ forcedTransp = file.fields.transportadora.value; }
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
  return { ok:true, transportadora:forcedTransp, total:parsed.length, mensagem: `Tabela ${forcedTransp} atualizada. ${parsed.length} regras.`, preview: parsed.slice(0,3) };
});

app.get('/api/transportadoras', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  try{
    const resumo = await getResumoTransportadoras();
    return { total: resumo.length, transportadoras: resumo };
  }catch(e){ return reply.code(503).send({ erro:'banco indisponivel' }); }
});

app.get('/api/tabelas/:transportadora/linhas', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  const transp = (req.params.transportadora||'').toUpperCase().trim();
  const page = parseInt(req.query.page)||1;
  const limit = Math.min(parseInt(req.query.limit)||50, 200);
  const buscaCep = req.query.cep ? parseInt(String(req.query.cep).replace(/\D/g,'')) : null;
  const offset = (page-1)*limit;
  if(pool){
    await ensureDB();
    let where='WHERE UPPER(transportadora)=UPPER($1)';
    const params=[transp];
    if(buscaCep){
      where+=` AND cep_ini <= $${params.length+1} AND cep_fim >= $${params.length+1}`;
      params.push(buscaCep);
    }
    const countRes = await pool.query(`SELECT COUNT(*) FROM frete_tabelas ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    const res = await pool.query(`SELECT * FROM frete_tabelas ${where} ORDER BY cep_ini, peso_ini LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    return { transportadora: transp, total, page, limit, total_pages: Math.ceil(total/limit), linhas: res.rows };
  } else {
    let rows = (global.TABELAS_MEM||[]).filter(r=> (r.transportadora||'').toUpperCase()===transp);
    if(buscaCep) rows = rows.filter(r=> buscaCep >= toNum(r.cep_ini) && buscaCep <= toNum(r.cep_fim));
    const total = rows.length;
    const linhas = rows.slice(offset, offset+limit);
    return { transportadora: transp, total, page, limit, total_pages: Math.ceil(total/limit), linhas };
  }
});

app.put('/api/tabelas/linha/:id', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  const id = parseInt(req.params.id);
  const body = req.body||{};
  const allowed = ['cep_ini','cep_fim','peso_ini','peso_fim','valor_ini','valor_fim','cubagem','limite_peso','prazo','frete_valor','excedente','advalor_perc','peso_excedente','valor_por_kg','despacho','total_minimo','imposto_perc','seguro_perc','seguro_min','gris_perc','gris_min','pedagio','pedagio_fracao','tas_perc','tas_min','emex_perc','emex_min','taxa_min','taxa_max','taxa_perc','metodo','transportadora'];
  const sets=[];
  const vals=[];
  let idx=1;
  for(const k of allowed){
    if(body[k]!==undefined){
      sets.push(`${k}=$${idx}`);
      vals.push(k==='transportadora'||k==='metodo' ? String(body[k]).toUpperCase().trim() : body[k]);
      idx++;
    }
  }
  if(sets.length===0) return reply.code(400).send({ erro:'nenhum campo para atualizar' });
  sets.push(`updated_at=NOW()`);
  if(pool){
    await ensureDB();
    vals.push(id);
    const res = await pool.query(`UPDATE frete_tabelas SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
    CACHE_TABELAS=null;
    if(res.rows.length===0) return reply.code(404).send({ erro:'linha nao encontrada' });
    return { ok:true, linha: res.rows[0] };
  } else {
    const mem = global.TABELAS_MEM||[];
    const i = mem.findIndex(r=> r.id===id);
    if(i===-1) return reply.code(404).send({ erro:'linha nao encontrada' });
    for(const k of allowed){ if(body[k]!==undefined) mem[i][k]=body[k]; }
    CACHE_TABELAS=mem;
    return { ok:true, linha: mem[i] };
  }
});

app.delete('/api/tabelas/linha/:id', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  const id = parseInt(req.params.id);
  if(pool){
    await ensureDB();
    const res = await pool.query('DELETE FROM frete_tabelas WHERE id=$1', [id]);
    CACHE_TABELAS=null;
    return { ok:true, removidas: res.rowCount };
  } else {
    const antes = (global.TABELAS_MEM||[]).length;
    global.TABELAS_MEM = (global.TABELAS_MEM||[]).filter(r=> r.id!==id);
    CACHE_TABELAS=global.TABELAS_MEM;
    return { ok:true, removidas: antes - CACHE_TABELAS.length };
  }
});

app.post('/api/tabelas/:transportadora/linha', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  const transp = (req.params.transportadora||'').toUpperCase().trim();
  const body = req.body||{};
  if(!transp) return reply.code(400).send({ erro:'transportadora obrigatoria' });
  const nova = {
    transportadora: transp,
    metodo: body.metodo||'Frete Peso',
    cep_ini: parseInt(body.cep_ini)||0,
    cep_fim: parseInt(body.cep_fim)||99999999,
    peso_ini: parseFloat(body.peso_ini)||0,
    peso_fim: parseFloat(body.peso_fim)||999,
    valor_ini: parseFloat(body.valor_ini)||0,
    valor_fim: parseFloat(body.valor_fim)||9999999,
    cubagem: parseFloat(body.cubagem)||300,
    limite_peso: parseFloat(body.limite_peso)||5000,
    prazo: parseInt(body.prazo)||5,
    frete_valor: parseFloat(body.frete_valor)||0,
    excedente: parseFloat(body.excedente)||0,
    advalor_perc: parseFloat(body.advalor_perc)||0,
    peso_excedente: parseFloat(body.peso_excedente)||0,
    valor_por_kg: parseFloat(body.valor_por_kg)||0,
    despacho: parseFloat(body.despacho)||0,
    total_minimo: parseFloat(body.total_minimo)||0,
    imposto_perc: parseFloat(body.imposto_perc)||0,
    seguro_perc: parseFloat(body.seguro_perc)||0,
    seguro_min: parseFloat(body.seguro_min)||0,
    gris_perc: parseFloat(body.gris_perc)||0,
    gris_min: parseFloat(body.gris_min)||0,
    pedagio: parseFloat(body.pedagio)||0,
    pedagio_fracao: parseFloat(body.pedagio_fracao)||0,
    tas_perc: parseFloat(body.tas_perc)||0,
    tas_min: parseFloat(body.tas_min)||0,
    emex_perc: parseFloat(body.emex_perc)||0,
    emex_min: parseFloat(body.emex_min)||0,
    taxa_min: parseFloat(body.taxa_min)||0,
    taxa_max: parseFloat(body.taxa_max)||0,
    taxa_perc: parseFloat(body.taxa_perc)||0,
  };
  if(pool){
    await ensureDB();
    const res = await pool.query(`INSERT INTO frete_tabelas (transportadora, metodo, cep_ini, cep_fim, peso_ini, peso_fim, valor_ini, valor_fim, cubagem, limite_peso, prazo, frete_valor, excedente, advalor_perc, peso_excedente, valor_por_kg, despacho, total_minimo, imposto_perc, seguro_perc, seguro_min, gris_perc, gris_min, pedagio, pedagio_fracao, tas_perc, tas_min, emex_perc, emex_min, taxa_min, taxa_max, taxa_perc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING *`, [nova.transportadora, nova.metodo, nova.cep_ini, nova.cep_fim, nova.peso_ini, nova.peso_fim, nova.valor_ini, nova.valor_fim, nova.cubagem, nova.limite_peso, nova.prazo, nova.frete_valor, nova.excedente, nova.advalor_perc, nova.peso_excedente, nova.valor_por_kg, nova.despacho, nova.total_minimo, nova.imposto_perc, nova.seguro_perc, nova.seguro_min, nova.gris_perc, nova.gris_min, nova.pedagio, nova.pedagio_fracao, nova.tas_perc, nova.tas_min, nova.emex_perc, nova.emex_min, nova.taxa_min, nova.taxa_max, nova.taxa_perc]);
    CACHE_TABELAS=null;
    return { ok:true, linha: res.rows[0] };
  } else {
    const id = Date.now();
    global.TABELAS_MEM = global.TABELAS_MEM||[];
    const row = { id, ...nova };
    global.TABELAS_MEM.push(row);
    CACHE_TABELAS=global.TABELAS_MEM;
    return { ok:true, linha: row };
  }
});

app.post('/api/tabelas/:transportadora/reajuste', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  const transp = (req.params.transportadora||'').toUpperCase().trim();
  const { percentual, campo } = req.body||{};
  const perc = parseFloat(percentual);
  if(!transp || isNaN(perc)) return reply.code(400).send({ erro:'transportadora e percentual obrigatorios' });
  const campoAlvo = campo || 'frete_valor';
  const allowed = ['frete_valor','excedente','valor_por_kg','pedagio','despacho','total_minimo'];
  if(!allowed.includes(campoAlvo)) return reply.code(400).send({ erro:'campo invalido. Use: '+allowed.join(', ') });
  const fator = 1 + perc/100;
  if(pool){
    await ensureDB();
    const res = await pool.query(`UPDATE frete_tabelas SET ${campoAlvo}=${campoAlvo}*$1, updated_at=NOW() WHERE UPPER(transportadora)=UPPER($2)`, [fator, transp]);
    CACHE_TABELAS=null;
    return { ok:true, transportadora: transp, campo: campoAlvo, percentual: perc, afetadas: res.rowCount };
  } else {
    let afetadas=0;
    (global.TABELAS_MEM||[]).forEach(r=>{ if((r.transportadora||'').toUpperCase()===transp){ r[campoAlvo]=toNum(r[campoAlvo])*fator; afetadas++; } });
    CACHE_TABELAS=global.TABELAS_MEM;
    return { ok:true, transportadora: transp, campo: campoAlvo, percentual: perc, afetadas };
  }
});

app.delete('/api/tabelas/:transportadora', async (req, reply)=>{
  const token = req.headers['x-upload-token'];
  if(!process.env.UPLOAD_TOKEN || token !== process.env.UPLOAD_TOKEN) return reply.code(401).send({ erro:'nao autorizado' });
  const transp = (req.params.transportadora||'').toUpperCase().trim();
  if(!transp) return reply.code(400).send({ erro:'transportadora obrigatoria' });
  if(pool){
    await ensureDB();
    const res = await pool.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)', [transp]);
    CACHE_TABELAS=null;
    return { ok:true, transportadora:transp, removidas: res.rowCount };
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
<title>Mini-Frenet - Painel Frenet-like</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{font-family:Inter,sans-serif}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#3f3f46;border-radius:4px}
.table-edit input{width:100%;background:#27272a;border:1px solid #3f3f46;border-radius:6px;padding:4px 6px;font-size:11px}
.table-edit input:focus{border-color:#8b5cf6;outline:none}
</style>
</head>
<body class="bg-[#0f0f10] text-white min-h-screen">
<div class="max-w-[1600px] mx-auto p-4 md:p-6">

  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center font-bold">MF</div>
      <div><h1 class="font-bold text-xl">Mini-Frenet</h1><p class="text-xs text-zinc-400">Painel Frenet-like • Edição por Faixa de CEP</p></div>
    </div>
    <div class="flex gap-2">
      <div id="statusBadge" class="px-3 py-1 rounded-full text-xs bg-zinc-800 text-zinc-400">Carregando...</div>
      <button onclick="copyLink()" class="text-xs bg-violet-600 hover:bg-violet-500 px-3 py-1 rounded-full">Link Bling</button>
    </div>
  </div>

  <div class="grid md:grid-cols-4 gap-4 mb-6">
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-4"><p class="text-zinc-400 text-xs">Status DB</p><p id="dbStatus" class="text-sm font-semibold mt-1">-</p><p id="totalRegras" class="text-xs text-zinc-500 mt-1"></p></div>
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-4"><p class="text-zinc-400 text-xs">Transportadoras</p><p id="totalTransp" class="text-sm font-semibold mt-1">-</p><p class="text-xs text-zinc-500 mt-1">cadastradas</p></div>
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-4"><p class="text-zinc-400 text-xs">API</p><p class="text-xs font-mono mt-1">/api/cotacao</p><p class="text-[11px] text-green-400 mt-1">1 preço por transp.</p></div>
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-4"><p class="text-zinc-400 text-xs">Edição</p><p class="text-xs mt-1">Clique na transportadora para editar faixas de CEP</p></div>
  </div>

  <div class="grid lg:grid-cols-12 gap-6">
    <div class="lg:col-span-4 space-y-4">
      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <h2 class="font-semibold mb-3 text-sm">🔐 Acesso</h2>
        <div class="flex gap-2">
          <input id="tokenInput" type="password" placeholder="Token" class="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm outline-none focus:border-violet-500">
          <button onclick="salvarToken()" class="bg-zinc-800 border border-zinc-700 rounded-xl px-3 text-xs">Salvar</button>
        </div>
        <p id="tokenMsg" class="text-xs mt-2 hidden"></p>

        <h3 class="font-semibold mt-6 mb-2 text-sm">📤 Upload por Transportadora</h3>
        <div class="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-3 mb-3">
          <input id="transpInput" placeholder="NOME TRANSPORTADORA" class="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm uppercase font-semibold outline-none focus:border-violet-500" oninput="this.value=this.value.toUpperCase()">
          <p class="text-[10px] text-zinc-500 mt-1">Ao subir de novo, apaga só essa.</p>
        </div>
        <div id="dropZone" class="border-2 border-dashed border-zinc-700 rounded-xl p-6 text-center hover:border-violet-500/50 cursor-pointer bg-zinc-800/30">
          <p class="text-sm">Arraste a planilha</p>
          <p class="text-[11px] text-zinc-500 mt-1">.xlsx .xls .html .htm</p>
          <input id="fileInput" type="file" accept=".xlsx,.xls,.html,.htm" class="hidden">
        </div>
        <div id="uploadProgress" class="hidden mt-3"><div class="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><div id="progressBar" class="h-full bg-violet-500 transition-all" style="width:0%"></div></div><p id="progressText" class="text-[11px] text-zinc-400 mt-1"></p></div>
        <div id="uploadResult" class="hidden mt-3 p-3 rounded-xl text-xs"></div>
      </div>

      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-semibold text-sm">🚚 Transportadoras</h3>
          <button onclick="carregarTransportadoras()" class="text-[11px] bg-zinc-800 border border-zinc-700 px-2 py-1 rounded-lg">🔄</button>
        </div>
        <div id="transpLista" class="space-y-2 max-h-[600px] overflow-auto pr-1"></div>
      </div>
    </div>

    <div class="lg:col-span-8">
      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <div id="editorHeader" class="hidden">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 class="font-bold text-base">📋 Tabela: <span id="editorTranspNome" class="text-violet-400"></span></h3>
              <p id="editorStats" class="text-xs text-zinc-400 mt-1"></p>
            </div>
            <div class="flex gap-2">
              <button onclick="abrirAddLinha()" class="text-xs bg-violet-600 hover:bg-violet-500 px-3 py-2 rounded-lg">➕ Add Faixa</button>
              <button onclick="fecharEditor()" class="text-xs bg-zinc-800 border border-zinc-700 px-3 py-2 rounded-lg">✕</button>
            </div>
          </div>

          <div class="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-3 mb-4 grid md:grid-cols-4 gap-3 items-end">
            <div>
              <label class="text-[11px] text-zinc-400">Reajuste %</label>
              <input id="reajustePerc" type="number" placeholder="5" class="w-full mt-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs">
            </div>
            <div>
              <label class="text-[11px] text-zinc-400">Campo</label>
              <select id="reajusteCampo" class="w-full mt-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs">
                <option value="frete_valor">Frete Valor R$</option>
                <option value="valor_por_kg">Valor Por Kg</option>
                <option value="excedente">Excedente R$</option>
                <option value="pedagio">Pedágio R$</option>
                <option value="despacho">Despacho R$</option>
              </select>
            </div>
            <button onclick="aplicarReajuste()" class="text-xs bg-amber-600 hover:bg-amber-500 px-3 py-2 rounded-lg h-[32px]">Aplicar</button>
            <div class="flex gap-2">
              <input id="buscaCep" placeholder="Buscar CEP" class="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs">
              <button onclick="carregarLinhas()" class="text-xs bg-zinc-700 border border-zinc-600 px-3 py-1.5 rounded-lg">🔍</button>
            </div>
          </div>

          <div class="overflow-auto max-h-[700px] border border-zinc-800 rounded-xl">
            <table class="w-full text-[11px] table-edit">
              <thead class="bg-zinc-800 sticky top-0 z-10">
                <tr class="text-zinc-400">
                  <th class="p-2 text-left">ID</th>
                  <th class="p-2 text-left">CEP Ini</th>
                  <th class="p-2 text-left">CEP Fim</th>
                  <th class="p-2 text-left">Peso Ini</th>
                  <th class="p-2 text-left">Peso Fim</th>
                  <th class="p-2 text-left">Frete R$</th>
                  <th class="p-2 text-left">Exced.</th>
                  <th class="p-2 text-left">Vlr/Kg</th>
                  <th class="p-2 text-left">Prazo</th>
                  <th class="p-2 text-left">Cub.</th>
                  <th class="p-2 text-left">Ações</th>
                </tr>
              </thead>
              <tbody id="linhasTabela"></tbody>
            </table>
          </div>
          <div class="flex items-center justify-between mt-3 text-xs">
            <div class="flex gap-2">
              <button onclick="paginaAnterior()" class="bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded-lg">◀</button>
              <span id="paginacaoInfo" class="px-2 py-1.5 text-zinc-400"></span>
              <button onclick="proximaPagina()" class="bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded-lg">▶</button>
            </div>
            <span id="linhasTotal" class="text-zinc-500"></span>
          </div>
        </div>

        <div id="editorVazio" class="text-center py-16">
          <div class="text-4xl mb-3">📦</div>
          <p class="text-sm font-semibold">Nenhuma transportadora selecionada</p>
          <p class="text-xs text-zinc-500 mt-2">Clique em uma transportadora para editar faixas de CEP como na Frenet</p>
        </div>
      </div>

      <div id="modalLinha" class="hidden fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
        <div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto">
          <h3 id="modalTitulo" class="font-bold mb-4">Adicionar Faixa de CEP</h3>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <div><label class="text-zinc-400">CEP Inicial *</label><input id="m_cep_ini" type="text" placeholder="01000-000" inputmode="numeric" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">CEP Final *</label><input id="m_cep_fim" type="text" placeholder="08499-999" inputmode="numeric" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">Método</label><input id="m_metodo" value="Frete Peso" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">Peso Ini kg *</label><input id="m_peso_ini" type="number" step="0.01" value="0" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">Peso Fim kg *</label><input id="m_peso_fim" type="number" step="0.01" value="99.99" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">Frete Valor R$ *</label><input id="m_frete_valor" type="number" step="0.01" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">Prazo dias</label><input id="m_prazo" type="number" value="5" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">Cubagem</label><input id="m_cubagem" type="number" value="300" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
            <div><label class="text-zinc-400">Limite Peso kg</label><input id="m_limite_peso" type="number" value="5000" class="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2"></div>
          </div>
          <div class="flex gap-2 mt-6">
            <button onclick="salvarLinha()" class="flex-1 bg-violet-600 hover:bg-violet-500 py-2.5 rounded-xl text-sm font-semibold">Salvar</button>
            <button onclick="fecharModal()" class="flex-1 bg-zinc-800 border border-zinc-700 py-2.5 rounded-xl text-sm">Cancelar</button>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>

<script>
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token = localStorage.getItem('mf_token') || '';
document.getElementById('tokenInput').value = token;
const baseUrl = window.location.origin;
function apiUrl(p){return baseUrl + p}
let transpAtual=null;
let paginaAtual=1;
let totalPaginas=1;

async function checkStatus(){
  try{
    const r = await fetch(apiUrl('/'));
    const j = await r.json();
    document.getElementById('dbStatus').textContent = j.db || 'online';
    document.getElementById('totalRegras').textContent = (j.total_regras||0)+' regras • '+(j.transportadoras||0)+' transp.';
    document.getElementById('totalTransp').textContent = j.transportadoras||0;
    document.getElementById('statusBadge').textContent = '● Online - '+(j.total_regras||0)+' regras';
    document.getElementById('statusBadge').className='px-3 py-1 rounded-full text-xs bg-green-500/20 text-green-400 border border-green-500/30';
  }catch(e){ document.getElementById('statusBadge').textContent='● Offline'; }
}
checkStatus();
function salvarToken(){
  token = document.getElementById('tokenInput').value.trim();
  localStorage.setItem('mf_token', token);
  document.getElementById('tokenMsg').textContent='✅ Token salvo!'; document.getElementById('tokenMsg').className='text-xs mt-2 text-green-400'; document.getElementById('tokenMsg').classList.remove('hidden');
  carregarTransportadoras();
}
function copyLink(){ navigator.clipboard.writeText(baseUrl + '/api/cotacao'); }

const dropZone=document.getElementById('dropZone');
const fileInput=document.getElementById('fileInput');
dropZone.onclick=()=>fileInput.click();
dropZone.ondragover=(e)=>{e.preventDefault(); dropZone.classList.add('border-violet-500');}
dropZone.ondragleave=()=>dropZone.classList.remove('border-violet-500');
dropZone.ondrop=(e)=>{e.preventDefault(); dropZone.classList.remove('border-violet-500'); const f=e.dataTransfer.files[0]; if(f) uploadFile(f);}
fileInput.onchange=(e)=>{const f=e.target.files[0]; if(f) uploadFile(f);}

async function uploadFile(file){
  if(!token){ alert('Salve o token primeiro!'); return; }
  const transp = document.getElementById('transpInput').value.trim().toUpperCase();
  if(!transp){ alert('Digite o nome da transportadora!'); return; }
  const prog=document.getElementById('uploadProgress'); const bar=document.getElementById('progressBar'); const txt=document.getElementById('progressText'); const resDiv=document.getElementById('uploadResult');
  prog.classList.remove('hidden'); resDiv.classList.add('hidden'); bar.style.width='30%'; txt.textContent='Enviando '+file.name+' como '+transp+'...';
  try{
    const fd=new FormData(); fd.append('file', file); fd.append('transportadora', transp);
    bar.style.width='60%';
    const r=await fetch(apiUrl('/api/upload'),{method:'POST', headers:{'x-upload-token': token, 'x-transportadora': transp}, body: fd});
    bar.style.width='90%'; const j=await r.json(); bar.style.width='100%';
    if(!r.ok) throw new Error(j.erro || JSON.stringify(j));
    resDiv.className='mt-3 p-3 rounded-xl text-xs bg-green-500/10 border border-green-500/30 text-green-300';
    resDiv.innerHTML='<b>✅ Sucesso!</b> '+esc(j.transportadora)+' - '+esc(j.total)+' regras'; resDiv.classList.remove('hidden');
    checkStatus(); carregarTransportadoras();
    if(transpAtual===transp) carregarLinhas();
  }catch(e){
    resDiv.className='mt-3 p-3 rounded-xl text-xs bg-red-500/10 border border-red-500/30 text-red-300';
    resDiv.textContent='❌ Erro: '+e.message; resDiv.classList.remove('hidden');
  }finally{ setTimeout(()=>{prog.classList.add('hidden'); bar.style.width='0%';}, 1500); }
}

async function carregarTransportadoras(){
  if(!token){ document.getElementById('transpLista').innerHTML='<p class="text-zinc-500 text-xs">Salve o token</p>'; return; }
  const div=document.getElementById('transpLista'); div.innerHTML='Carregando...';
  try{
    const r=await fetch(apiUrl('/api/transportadoras'),{headers:{'x-upload-token': token}});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    if(j.total===0){ div.innerHTML='<p class="text-zinc-500 text-xs">Nenhuma transportadora ainda</p>'; return; }
    let html='';
    j.transportadoras.forEach(t=>{
      const ativo = transpAtual===t.transportadora ? 'border-violet-500 bg-violet-500/10' : 'border-zinc-700 bg-zinc-800';
      html+= \`
      <div class="border rounded-xl p-3 cursor-pointer hover:border-zinc-600 \${ativo}" onclick="abrirTransportadora('\${esc(t.transportadora)}')">
        <div class="flex justify-between items-start">
          <div class="flex-1">
            <p class="font-bold text-xs tracking-wide">\${esc(t.transportadora)}</p>
            <p class="text-[11px] text-zinc-400 mt-1">\${esc(t.total)} faixas • Prazo \${esc(t.prazoMin)}-\${esc(t.prazoMax)}d</p>
          </div>
          <button onclick="event.stopPropagation(); deletarTransp('\${esc(t.transportadora)}')" class="text-[11px] bg-red-500/20 border border-red-500/30 text-red-300 px-2 py-1 rounded-lg ml-2">🗑️</button>
        </div>
      </div>\`;
    });
    div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400 text-xs">Erro: '+esc(e.message)+'</p>'; }
}

function abrirTransportadora(nome){
  transpAtual=nome;
  paginaAtual=1;
  document.getElementById('editorVazio').classList.add('hidden');
  document.getElementById('editorHeader').classList.remove('hidden');
  document.getElementById('editorTranspNome').textContent=nome;
  carregarTransportadoras();
  carregarLinhas();
}
function fecharEditor(){
  transpAtual=null;
  document.getElementById('editorHeader').classList.add('hidden');
  document.getElementById('editorVazio').classList.remove('hidden');
  carregarTransportadoras();
}

async function carregarLinhas(){
  if(!transpAtual) return;
  const tbody=document.getElementById('linhasTabela');
  const cepBusca=document.getElementById('buscaCep').value.trim();
  tbody.innerHTML='<tr><td colspan="11" class="p-4 text-center text-zinc-500">Carregando...</td></tr>';
  try{
    const params=new URLSearchParams({page:paginaAtual, limit:50});
    if(cepBusca) params.set('cep', cepBusca);
    const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/linhas?'+params.toString()),{headers:{'x-upload-token': token}});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    totalPaginas=j.total_pages||1;
    document.getElementById('paginacaoInfo').textContent='Página '+j.page+' de '+j.total_pages;
    document.getElementById('linhasTotal').textContent=j.total+' faixas';
    document.getElementById('editorStats').textContent=j.total+' faixas de CEP • Mostrando '+j.linhas.length;

    if(j.linhas.length===0){ tbody.innerHTML='<tr><td colspan="11" class="p-4 text-center text-zinc-500">Nenhuma faixa</td></tr>'; return; }

    let html='';
    j.linhas.forEach(l=>{
      html+= \`
      <tr id="row-\${l.id}" class="border-t border-zinc-800 hover:bg-zinc-800/50">
        <td class="p-1">\${esc(l.id)}</td>
        <td class="p-1"><input id="cep_ini_\${l.id}" value="\${esc(l.cep_ini)}" class="w-[90px]"></td>
        <td class="p-1"><input id="cep_fim_\${l.id}" value="\${esc(l.cep_fim)}" class="w-[90px]"></td>
        <td class="p-1"><input id="peso_ini_\${l.id}" value="\${esc(l.peso_ini)}" class="w-[60px]"></td>
        <td class="p-1"><input id="peso_fim_\${l.id}" value="\${esc(l.peso_fim)}" class="w-[60px]"></td>
        <td class="p-1"><input id="frete_valor_\${l.id}" value="\${esc(l.frete_valor)}" class="w-[70px]"></td>
        <td class="p-1"><input id="excedente_\${l.id}" value="\${esc(l.excedente||0)}" class="w-[60px]"></td>
        <td class="p-1"><input id="valor_por_kg_\${l.id}" value="\${esc(l.valor_por_kg||0)}" class="w-[60px]"></td>
        <td class="p-1"><input id="prazo_\${l.id}" value="\${esc(l.prazo)}" class="w-[50px]"></td>
        <td class="p-1"><input id="cubagem_\${l.id}" value="\${esc(l.cubagem)}" class="w-[60px]"></td>
        <td class="p-1">
          <div class="flex gap-1">
            <button onclick="salvarEdicaoInline(\${l.id})" class="bg-green-600 hover:bg-green-500 text-white px-2 py-1 rounded text-[10px]">💾</button>
            <button onclick="deletarLinha(\${l.id})" class="bg-red-600 hover:bg-red-500 text-white px-2 py-1 rounded text-[10px]">🗑️</button>
          </div>
        </td>
      </tr>\`;
    });
    tbody.innerHTML=html;
  }catch(e){ tbody.innerHTML='<tr><td colspan="11" class="p-4 text-center text-red-400">Erro: '+esc(e.message)+'</td></tr>'; }
}

async function salvarEdicaoInline(id){
  const payload={
    cep_ini: limparCep(document.getElementById('cep_ini_'+id).value),
    cep_fim: limparCep(document.getElementById('cep_fim_'+id).value),
    peso_ini: parseFloat(document.getElementById('peso_ini_'+id).value)||0,
    peso_fim: parseFloat(document.getElementById('peso_fim_'+id).value)||999,
    frete_valor: parseFloat(document.getElementById('frete_valor_'+id).value)||0,
    excedente: parseFloat(document.getElementById('excedente_'+id).value)||0,
    valor_por_kg: parseFloat(document.getElementById('valor_por_kg_'+id).value)||0,
    prazo: parseInt(document.getElementById('prazo_'+id).value)||5,
    cubagem: parseFloat(document.getElementById('cubagem_'+id).value)||300,
  };
  try{
    const r=await fetch(apiUrl('/api/tabelas/linha/'+id),{method:'PUT', headers:{'Content-Type':'application/json','x-upload-token': token}, body: JSON.stringify(payload)});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    const row=document.getElementById('row-'+id);
    row.classList.add('bg-green-500/20'); setTimeout(()=>row.classList.remove('bg-green-500/20'), 1000);
  }catch(e){ alert('Erro ao salvar: '+e.message); }
}

async function deletarLinha(id){
  if(!confirm('Excluir essa faixa de CEP? ID '+id)) return;
  try{
    const r=await fetch(apiUrl('/api/tabelas/linha/'+id),{method:'DELETE', headers:{'x-upload-token': token}});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    document.getElementById('row-'+id).remove();
  }catch(e){ alert('Erro: '+e.message); }
}

function limparCep(v){ return parseInt(String(v).replace(/\D/g,''))||0; }
function abrirAddLinha(){
  document.getElementById('modalTitulo').textContent='Adicionar Faixa em '+transpAtual;
  document.getElementById('m_cep_ini').value='';
  document.getElementById('m_cep_fim').value='';
  document.getElementById('m_peso_ini').value='0';
  document.getElementById('m_peso_fim').value='99.99';
  document.getElementById('m_frete_valor').value='';
  document.getElementById('modalLinha').classList.remove('hidden');
}
function fecharModal(){ document.getElementById('modalLinha').classList.add('hidden'); }

function limparCep(v){ return parseInt(String(v).replace(/\D/g,''))||0; }
async function salvarLinha(){
  const payload={
    cep_ini: limparCep(document.getElementById('m_cep_ini').value),
    cep_fim: limparCep(document.getElementById('m_cep_fim').value),
    metodo: document.getElementById('m_metodo').value||'Frete Peso',
    peso_ini: parseFloat(document.getElementById('m_peso_ini').value)||0,
    peso_fim: parseFloat(document.getElementById('m_peso_fim').value)||999,
    frete_valor: parseFloat(String(document.getElementById('m_frete_valor').value).replace(',','.'))||0,
    prazo: parseInt(document.getElementById('m_prazo').value)||5,
    cubagem: parseFloat(document.getElementById('m_cubagem').value)||300,
    limite_peso: parseFloat(document.getElementById('m_limite_peso').value)||5000,
  };
  if(!payload.cep_ini || !payload.cep_fim){ alert('CEP Inicial e Final obrigatórios. Digite apenas números, ex: 01000000 ou 01000-000'); return; }
  try{
    const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/linha'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token': token}, body: JSON.stringify(payload)});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    fecharModal(); carregarLinhas(); checkStatus();
  }catch(e){ alert('Erro: '+e.message); }
}

async function aplicarReajuste(){
  const perc=parseFloat(document.getElementById('reajustePerc').value);
  const campo=document.getElementById('reajusteCampo').value;
  if(isNaN(perc)){ alert('Digite o percentual'); return; }
  if(!confirm('Aplicar reajuste de '+perc+'% em '+campo+' para TODAS as faixas de '+transpAtual+'?')) return;
  try{
    const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/reajuste'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token': token}, body: JSON.stringify({percentual:perc, campo})});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    alert('Reajuste aplicado em '+j.afetadas+' faixas!');
    carregarLinhas();
  }catch(e){ alert('Erro: '+e.message); }
}

function paginaAnterior(){ if(paginaAtual>1){ paginaAtual--; carregarLinhas(); } }
function proximaPagina(){ if(paginaAtual<totalPaginas){ paginaAtual++; carregarLinhas(); } }

async function deletarTransp(nome){
  if(!confirm('Excluir TODA a tabela da transportadora '+nome+'?')) return;
  try{
    const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(nome)),{method:'DELETE', headers:{'x-upload-token': token}});
    const j=await r.json();
    if(!r.ok) throw new Error(j.erro);
    if(transpAtual===nome) fecharEditor();
    carregarTransportadoras(); checkStatus();
  }catch(e){ alert('Erro: '+e.message); }
}

carregarTransportadoras();
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

    

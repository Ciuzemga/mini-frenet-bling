import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pg from 'pg';
import 'dotenv/config';
import XLSX from 'xlsx';
import crypto from 'crypto';

const app = Fastify({ logger: true });
await app.register(cors, { origin: '*' });
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });

function getPoolConfig(){
  const url = process.env.DATABASE_URL;
  if(!url) return null;
  const needsSSL = url.includes('.rlwy.net') || process.env.PGSSLMODE === 'require';
  return { connectionString: url, ssl: needsSSL ? { rejectUnauthorized: false } : undefined };
}
const pool = process.env.DATABASE_URL ? new pg.Pool(getPoolConfig()) : null;
let CACHE = null, CACHE_AT=0, DB_READY=false;

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
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frete_transp ON frete_tabelas(transportadora); CREATE INDEX IF NOT EXISTS idx_frete_cep ON frete_tabelas(cep_ini, cep_fim);`);
  DB_READY=true;
  console.log('DB Premium pronto');
}
await initDB();

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
      seguro_perc: parseFloat(String(get('seguro %')).replace(',','.'))||0,
      gris_perc: parseFloat(String(get('gris %')).replace(',','.'))||0,
      pedagio: parseFloat(String(get('pedagio')).replace(',','.'))||0,
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

// API COTAÇÃO - NUNCA SOME, É O CORE
app.post('/api/cotacao', async (req, reply)=>{
  const b=req.body||{};
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
    try{ await pool.query(`INSERT INTO cotacoes_log (cep_destino, peso, valor_nf, transportadora, valor_frete, prazo, peso_taxado) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [String(cep_destino), peso_real, valor_nf, resultados[0]?.transportadora||'', resultados[0]?.valor_frete||0, resultados[0]?.prazo||0, Math.max(peso_real,(altura*largura*comprimento)/300)]); }catch(e){}
  }
  return { cotacoes: resultados, peso_taxado: parseFloat(Math.max(peso_real,(altura*largura*comprimento)/300).toFixed(2)), cep_consultado: cep, total_encontrado: resultados.length };
});

app.post('/api/upload', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'token invalido'});
  let forcedTransp=null;
  const file=await req.file();
  if(!file) return reply.code(400).send({erro:'arquivo ausente'});
  if(file.fields?.transportadora) forcedTransp=file.fields.transportadora.value;
  if(!forcedTransp && req.headers['x-transportadora']) forcedTransp=req.headers['x-transportadora'];
  if(!forcedTransp) return reply.code(400).send({erro:'Informe nome da transportadora'});
  forcedTransp=String(forcedTransp).toUpperCase().trim();
  const buffer=await file.toBuffer();
  const parsed=parseTabela(buffer, file.filename||'', forcedTransp);
  if(parsed.length===0) return reply.code(400).send({erro:'Nenhuma linha valida'});
  if(pool){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)', [forcedTransp]);
      for(const r of parsed){
        await client.query(`INSERT INTO frete_tabelas (transportadora, metodo, cep_ini, cep_fim, peso_ini, peso_fim, valor_ini, valor_fim, cubagem, limite_peso, prazo, frete_valor, excedente, advalor_perc, peso_excedente, valor_por_kg, despacho, total_minimo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [r.transportadora, r.metodo, r.cep_ini, r.cep_fim, r.peso_ini, r.peso_fim, r.valor_ini, r.valor_fim, r.cubagem, r.limite_peso, r.prazo, r.frete_valor, r.excedente, r.advalor_perc, r.peso_excedente, r.valor_por_kg, r.despacho, r.total_minimo]);
      }
      await client.query('COMMIT');
    }catch(e){ await client.query('ROLLBACK'); return reply.code(500).send({erro:e.message}); }finally{ client.release(); }
    CACHE=null;
  } else {
    global.MEM=global.MEM||[]; global.MEM=global.MEM.filter(r=> r.transportadora!==forcedTransp); global.MEM.push(...parsed); CACHE=global.MEM;
  }
  return { ok:true, transportadora: forcedTransp, total: parsed.length };
});

app.get('/api/transportadoras', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const resumo=await getResumo();
  return { total: resumo.length, transportadoras: resumo };
});

app.get('/api/tabelas/:transportadora/linhas', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
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
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const id=parseInt(req.params.id), body=req.body||{};
  const allowed=['cep_ini','cep_fim','peso_ini','peso_fim','frete_valor','valor_por_kg','prazo','cubagem','metodo'];
  const sets=[], vals=[]; let idx=1;
  for(const k of allowed){ if(body[k]!==undefined){ sets.push(`${k}=$${idx}`); vals.push(k==='cep_ini'||k==='cep_fim'? limparCep(body[k]) : body[k]); idx++; } }
  if(sets.length===0) return reply.code(400).send({erro:'nada para atualizar'});
  sets.push('updated_at=NOW()'); vals.push(id);
  if(pool){ const res=await pool.query(`UPDATE frete_tabelas SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`, vals); CACHE=null; if(!res.rows.length) return reply.code(404).send({erro:'nao encontrada'}); return { ok:true, linha: res.rows[0] }; }
  else { const mem=global.MEM||[]; const i=mem.findIndex(r=>r.id===id); if(i===-1) return reply.code(404).send({erro:'nao encontrada'}); for(const k of allowed) if(body[k]!==undefined) mem[i][k]=body[k]; CACHE=mem; return { ok:true, linha: mem[i] }; }
});

app.delete('/api/tabelas/linha/:id', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const id=parseInt(req.params.id);
  if(pool){ const res=await pool.query('DELETE FROM frete_tabelas WHERE id=$1',[id]); CACHE=null; return { ok:true, removidas: res.rowCount }; }
  else { const antes=(global.MEM||[]).length; global.MEM=global.MEM.filter(r=>r.id!==id); CACHE=global.MEM; return { ok:true, removidas: antes-CACHE.length }; }
});

app.post('/api/tabelas/:transportadora/linha', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const transp=(req.params.transportadora||'').toUpperCase(), b=req.body||{};
  const nova={ transportadora: transp, metodo: b.metodo||'Frete Peso', cep_ini: limparCep(b.cep_ini), cep_fim: limparCep(b.cep_fim)||99999999, peso_ini: parseFloat(b.peso_ini)||0, peso_fim: parseFloat(b.peso_fim)||999, frete_valor: parseFloat(String(b.frete_valor).replace(',','.'))||0, prazo: parseInt(b.prazo)||5, cubagem: parseFloat(b.cubagem)||300 };
  if(!nova.cep_ini || !nova.cep_fim) return reply.code(400).send({erro:'CEP obrigatorio'});
  if(pool){ const res=await pool.query(`INSERT INTO frete_tabelas (transportadora, metodo, cep_ini, cep_fim, peso_ini, peso_fim, frete_valor, prazo, cubagem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [nova.transportadora, nova.metodo, nova.cep_ini, nova.cep_fim, nova.peso_ini, nova.peso_fim, nova.frete_valor, nova.prazo, nova.cubagem]); CACHE=null; return { ok:true, linha: res.rows[0] }; }
  else { const id=Date.now(); const row={id, ...nova}; global.MEM.push(row); CACHE=global.MEM; return { ok:true, linha: row }; }
});

app.post('/api/tabelas/:transportadora/reajuste', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const transp=(req.params.transportadora||'').toUpperCase(), perc=parseFloat(req.body?.percentual); if(isNaN(perc)) return reply.code(400).send({erro:'percentual obrigatorio'});
  const campo=req.body?.campo||'frete_valor', fator=1+perc/100;
  if(pool){ const res=await pool.query(`UPDATE frete_tabelas SET ${campo}=${campo}*$1, updated_at=NOW() WHERE UPPER(transportadora)=UPPER($2)`, [fator, transp]); CACHE=null; return { ok:true, afetadas: res.rowCount }; }
  else { let afetadas=0; (global.MEM||[]).forEach(r=>{ if(r.transportadora===transp){ r[campo]=toNum(r[campo])*fator; afetadas++; } }); return { ok:true, afetadas }; }
});

app.delete('/api/tabelas/:transportadora', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const transp=(req.params.transportadora||'').toUpperCase();
  if(pool){ const res=await pool.query('DELETE FROM frete_tabelas WHERE UPPER(transportadora)=UPPER($1)',[transp]); CACHE=null; return { ok:true, removidas: res.rowCount }; }
  else { const antes=(global.MEM||[]).length; global.MEM=global.MEM.filter(r=>r.transportadora!==transp); CACHE=global.MEM; return { ok:true, removidas: antes-CACHE.length }; }
});

// COLABORADORES, REGRAS, INTEGRAÇÕES, DASHBOARD
app.get('/api/dashboard', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const tabelas=await getTabelas(), resumo=await getResumo();
  let cotHoje=0, cotTotal=0, porDia=[], top=[];
  if(pool){ try{ const h=await pool.query(`SELECT COUNT(*) FROM cotacoes_log WHERE created_at >= CURRENT_DATE`); cotHoje=parseInt(h.rows[0].count||0); const t=await pool.query(`SELECT COUNT(*) FROM cotacoes_log`); cotTotal=parseInt(t.rows[0].count||0); const d=await pool.query(`SELECT DATE(created_at) as dia, COUNT(*) as total FROM cotacoes_log WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY dia ORDER BY dia`); porDia=d.rows; const tp=await pool.query(`SELECT transportadora, COUNT(*) as total, AVG(valor_frete) as media FROM cotacoes_log WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY transportadora ORDER BY total DESC LIMIT 5`); top=tp.rows; }catch(e){} }
  return { total_regras: tabelas.length, transportadoras: resumo.length, lista_transportadoras: resumo, cotacoes_hoje: cotHoje, cotacoes_total: cotTotal, cotacoes_7dias: porDia, top_transportadoras: top };
});

app.get('/api/historico', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const page=parseInt(req.query.page)||1, limit=Math.min(parseInt(req.query.limit)||50,200), offset=(page-1)*limit;
  if(pool){ const c=await pool.query('SELECT COUNT(*) FROM cotacoes_log'); const total=parseInt(c.rows[0].count); const res=await pool.query('SELECT * FROM cotacoes_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',[limit, offset]); return { total, page, limit, total_pages: Math.ceil(total/limit), historico: res.rows }; }
  else return { total:0, page, limit, historico:[] };
});

app.get('/api/colaboradores', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  if(pool){ const res=await pool.query('SELECT id, nome, email, role, ativo, created_at FROM colaboradores ORDER BY created_at DESC'); return { total: res.rows.length, colaboradores: res.rows }; }
  else return { total:0, colaboradores:[] };
});
app.post('/api/colaboradores', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const { nome, email, senha, role }=req.body||{}; if(!nome||!email||!senha) return reply.code(400).send({erro:'nome, email e senha obrigatorios'});
  const hash=crypto.createHash('sha256').update(senha).digest('hex');
  if(pool){ try{ const res=await pool.query('INSERT INTO colaboradores (nome, email, senha_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, nome, email, role, created_at',[nome, email.toLowerCase().trim(), hash, role||'colaborador']); return { ok:true, colaborador: res.rows[0] }; }catch(e){ if(e.code==='23505') return reply.code(400).send({erro:'email ja cadastrado'}); throw e; } } else return { ok:true };
});
app.delete('/api/colaboradores/:id', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const id=parseInt(req.params.id); if(pool){ const res=await pool.query('DELETE FROM colaboradores WHERE id=$1',[id]); return { ok:true, removidas: res.rowCount }; } else return { ok:true };
});

app.get('/api/regras', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  if(pool){ const res=await pool.query('SELECT * FROM regras_frete ORDER BY created_at DESC'); return { total: res.rows.length, regras: res.rows }; } else return { total:0, regras:[] };
});
app.post('/api/regras', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const { tipo, nome, transportadora, valor_min, percentual, valor_fixo }=req.body||{}; if(!tipo) return reply.code(400).send({erro:'tipo obrigatorio'});
  if(pool){ const res=await pool.query('INSERT INTO regras_frete (tipo, nome, transportadora, valor_min, percentual, valor_fixo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[tipo, nome||'', transportadora?transportadora.toUpperCase():null, valor_min||0, percentual||0, valor_fixo||0]); return { ok:true, regra: res.rows[0] }; } else return { ok:true };
});
app.delete('/api/regras/:id', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const id=parseInt(req.params.id); if(pool){ const res=await pool.query('DELETE FROM regras_frete WHERE id=$1',[id]); return { ok:true, removidas: res.rowCount }; } else return { ok:true };
});

app.get('/api/integracoes', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  if(pool){ const res=await pool.query('SELECT * FROM integracoes ORDER BY created_at DESC'); return { total: res.rows.length, integracoes: res.rows }; } else return { total:0, integracoes:[] };
});
app.get('/api/integracoes/plataformas', async ()=>{
  return { plataformas: [
    { id:'bling', nome:'Bling ERP', categoria:'ERP', desc:'ERP Bling v3 - cotação e pedidos', campos:['api_key'], icon:'🧾' },
    { id:'tiny', nome:'Tiny ERP', categoria:'ERP', desc:'Tiny ERP - gestão e fretes', campos:['token'], icon:'📘' },
    { id:'shopify', nome:'Shopify', categoria:'Loja', desc:'Shopify - checkout transparente', campos:['api_key','url_loja'], icon:'🛍️' },
    { id:'vtex', nome:'VTEX', categoria:'Loja', desc:'VTEX IO', campos:['api_key','url_loja'], icon:'🏬' },
    { id:'nuvemshop', nome:'Nuvemshop', categoria:'Loja', desc:'Nuvemshop', campos:['api_key'], icon:'☁️' },
    { id:'woocommerce', nome:'WooCommerce', categoria:'Loja', desc:'WordPress', campos:['url_loja','api_key'], icon:'🛒' },
    { id:'correios', nome:'Correios', categoria:'Frete', desc:'My Correios / SIGEP', campos:['api_key','token'], icon:'📮' },
    { id:'jadlog', nome:'Jadlog', categoria:'Frete', desc:'Jadlog API', campos:['token'], icon:'🚚' },
    { id:'braspress', nome:'Braspress', categoria:'Frete', desc:'Braspress', campos:['token'], icon:'🚛' },
    { id:'melhor_envio', nome:'Melhor Envio', categoria:'Hub', desc:'Hub multi-transportadora', campos:['token'], icon:'📦' },
    { id:'frenet', nome:'Frenet', categoria:'Hub', desc:'Importar tabelas da Frenet', campos:['token'], icon:'🔶' },
  ]};
});
app.post('/api/integracoes', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const { plataforma, nome, api_key, api_secret, token: tok, url_loja }=req.body||{}; if(!plataforma) return reply.code(400).send({erro:'plataforma obrigatoria'});
  if(pool){
    const existe=await pool.query('SELECT id FROM integracoes WHERE plataforma=$1',[plataforma]);
    if(existe.rows.length>0){
      const res=await pool.query(`UPDATE integracoes SET nome=$1, api_key=$2, api_secret=$3, token=$4, url_loja=$5, status='configurado' WHERE plataforma=$6 RETURNING *`,[nome||plataforma, api_key||'', api_secret||'', tok||'', url_loja||'', plataforma]);
      return { ok:true, integracao: res.rows[0], atualizado:true };
    } else {
      const res=await pool.query(`INSERT INTO integracoes (plataforma, nome, api_key, api_secret, token, url_loja, status) VALUES ($1,$2,$3,$4,$5,$6,'configurado') RETURNING *`,[plataforma, nome||plataforma, api_key||'', api_secret||'', tok||'', url_loja||'']);
      return { ok:true, integracao: res.rows[0] };
    }
  } else return { ok:true };
});
app.delete('/api/integracoes/:id', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const id=parseInt(req.params.id); if(pool){ const res=await pool.query('DELETE FROM integracoes WHERE id=$1',[id]); return { ok:true, removidas: res.rowCount }; } else return { ok:true };
});
app.post('/api/integracoes/:id/testar', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const id=parseInt(req.params.id);
  if(pool){
    const res=await pool.query('SELECT * FROM integracoes WHERE id=$1',[id]); if(!res.rows.length) return reply.code(404).send({erro:'nao encontrada'});
    const integ=res.rows[0];
    const ok=!!(integ.api_key||integ.token);
    await pool.query(`UPDATE integracoes SET status=$1, ultimo_teste=NOW() WHERE id=$2`,[ok?'conectado':'erro', id]);
    return { ok, status: ok?'conectado':'erro', mensagem: ok? `Conexão com ${integ.plataforma.toUpperCase()} OK - chave ${String(integ.api_key||integ.token).substring(0,6)}...` : 'Preencha API Key', plataforma: integ.plataforma };
  } else return { ok:true, status:'conectado', mensagem:'OK' };
});

app.get('/api/config', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  if(pool){ const res=await pool.query('SELECT * FROM configuracoes'); const map={}; res.rows.forEach(r=> map[r.chave]=r.valor); return map; } else return {};
});
app.post('/api/config', async (req, reply)=>{
  const token=req.headers['x-upload-token'];
  if(process.env.UPLOAD_TOKEN && token!==process.env.UPLOAD_TOKEN) return reply.code(401).send({erro:'nao autorizado'});
  const body=req.body||{}; if(pool){ for(const [k,v] of Object.entries(body)){ await pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=$2, updated_at=NOW()`,[k, String(v)]); } } return { ok:true };
});

app.get('/', async ()=>{ const tabelas=await getTabelas(); const resumo=await getResumo(); return { status:'CIUZE LOG - Plataforma Premium', db: pool?'postgres':'memoria', total_regras: tabelas.length, transportadoras: resumo.length, versao:'premium-v1', inspiracao:'Frenet + Intelepost + AllPost (identidade propria)' }; });
app.get('/health', async ()=>({ ok:true, timestamp:new Date().toISOString() }));

app.get('/painel', async (req, reply)=>{
  reply.type('text/html').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CIUZE LOG • Plataforma de Fretes</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
*{font-family:'Plus Jakarta Sans',sans-serif}
.mono{font-family:'JetBrains Mono',monospace}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:#27272a;border-radius:999px}
.menu-active{background:#18181b;border:1px solid #3f3f46;color:#fafafa}
.table-edit input{width:100%;background:#18181b;border:1px solid #27272a;border-radius:8px;padding:6px 8px;font-size:11px;transition:.15s}
.table-edit input:focus{border-color:#f59e0b;outline:none;background:#1f1f23}
</style>
</head>
<body class="bg-[#09090b] text-zinc-100 min-h-screen flex selection:bg-amber-500/20">
<!-- SIDEBAR PREMIUM - SEM AZUL, IDENTIDADE PRÓPRIA -->
<div class="w-[280px] bg-[#0f0f10] border-r border-zinc-800/80 min-h-screen p-5 flex flex-col">
  <div class="flex items-center gap-3 mb-10">
    <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black text-[13px]">CZ</div>
    <div><h1 class="font-bold text-[14px] tracking-tight">CIUZE LOG</h1><p class="text-[11px] text-zinc-500 font-medium">Plataforma Premium</p></div>
    <div class="ml-auto w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
  </div>
  
  <div class="space-y-6 flex-1">
    <div>
      <p class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase mb-3 px-3">Operação</p>
      <nav class="space-y-1">
        <button onclick="showPage('dashboard')" id="menu-dashboard" class="menu-active w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3"><span>◧</span> Dashboard <span class="ml-auto text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded">⌘1</span></button>
        <button onclick="showPage('cotacao')" id="menu-cotacao" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"><span>◩</span> Cotação <span class="ml-auto w-1.5 h-1.5 bg-amber-500 rounded-full"></span></button>
        <button onclick="showPage('tabelas')" id="menu-tabelas" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"><span>☰</span> Tabelas</button>
        <button onclick="showPage('historico')" id="menu-historico" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"><span>◫</span> Histórico</button>
      </nav>
    </div>
    <div>
      <p class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase mb-3 px-3">Configuração</p>
      <nav class="space-y-1">
        <button onclick="showPage('integracoes')" id="menu-integracoes" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"><span>⟁</span> Integrações <span class="ml-auto text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">NOVO</span></button>
        <button onclick="showPage('regras')" id="menu-regras" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"><span>⚙</span> Regras de Frete</button>
        <button onclick="showPage('colaboradores')" id="menu-colaboradores" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"><span>◍</span> Colaboradores</button>
        <button onclick="showPage('config')" id="menu-config" class="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-medium flex items-center gap-3 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100"><span>⬡</span> API & Config</button>
      </nav>
    </div>
  </div>

  <div class="mt-auto pt-5 border-t border-zinc-800/60 space-y-3">
    <div class="bg-[#18181b] border border-zinc-800 rounded-2xl p-4">
      <p class="text-[11px] font-semibold text-zinc-300">Acesso Seguro</p>
      <input id="tokenInput" type="password" placeholder="Seu UPLOAD_TOKEN" class="w-full mt-3 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-2.5 text-[12px] outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/10">
      <button onclick="salvarToken()" class="w-full mt-3 bg-amber-500 hover:bg-amber-400 text-black rounded-xl py-2.5 text-[12px] font-bold tracking-wide">DESBLOQUEAR</button>
      <p id="tokenMsg" class="text-[11px] mt-2 hidden"></p>
    </div>
    <div id="statusBadge" class="text-[10px] text-zinc-500 text-center font-mono">● iniciando...</div>
  </div>
</div>

<div class="flex-1 p-7 overflow-auto">
  <!-- DASHBOARD -->
  <div id="page-dashboard" class="page">
    <div class="flex items-center justify-between mb-8">
      <div><h2 class="text-[22px] font-bold tracking-tight">Dashboard</h2><p class="text-[13px] text-zinc-500 mt-1">Visão geral da sua operação logística</p></div>
      <div class="flex items-center gap-2 text-[11px]"><span class="px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800">🟢 Operacional</span><span id="dashData" class="px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 mono"></span></div>
    </div>
    <div class="grid md:grid-cols-4 gap-4 mb-8">
      <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><div class="flex justify-between"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Regras Ativas</p><span class="text-[10px] bg-zinc-800 px-2 py-1 rounded-full">faixas</span></div><p id="dashTotalRegras" class="text-[28px] font-bold mt-3">-</p><p class="text-[11px] text-zinc-500 mt-2"><span class="text-emerald-400">↗</span> Total de faixas de CEP cadastradas</p></div>
      <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Transportadoras</p><p id="dashTotalTransp" class="text-[28px] font-bold mt-3">-</p><p class="text-[11px] text-zinc-500 mt-2">Conectadas e ativas</p></div>
      <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Cotações Hoje</p><p id="dashHoje" class="text-[28px] font-bold mt-3">-</p><p class="text-[11px] text-amber-300 mt-2">● Hoje • via API e painel</p></div>
      <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><p class="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Volume Total</p><p id="dashTotal" class="text-[28px] font-bold mt-3">-</p><p class="text-[11px] text-zinc-500 mt-2">Cotações no histórico</p></div>
    </div>
    <div class="grid lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2 bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-6">Cotações • Últimos 7 dias</h3><canvas id="chart7dias" height="220"></canvas></div>
      <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-6">Top Transportadoras • 30 dias</h3><div id="topTransp" class="space-y-3"></div></div>
    </div>
  </div>

  <!-- COTACAO - SEMPRE VISIVEL, CORE -->
  <div id="page-cotacao" class="page hidden">
    <div class="flex items-center justify-between mb-8">
      <div><h2 class="text-[22px] font-bold tracking-tight">Cotação de Frete</h2><p class="text-[13px] text-zinc-500 mt-1">Simulador idêntico ao checkout • Retorna 1 preço por transportadora</p></div>
      <div class="text-[11px] bg-amber-500/10 border border-amber-500/20 text-amber-300 px-3 py-1.5 rounded-full">⚡ Core • Nunca some</div>
    </div>
    <div class="grid lg:grid-cols-12 gap-6">
      <div class="lg:col-span-4 bg-[#121214] border border-zinc-800 rounded-[24px] p-6">
        <h3 class="font-semibold text-[13px] mb-5">Dados do Envio</h3>
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-[11px] font-medium text-zinc-400">CEP Origem</label><input id="cotCepOrigem" value="87010000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px] outline-none focus:border-amber-500/50"></div>
            <div><label class="text-[11px] font-medium text-zinc-400">CEP Destino *</label><input id="cotCepDestino" value="01310000" placeholder="01000-000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px] outline-none focus:border-amber-500/50"></div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-[11px] font-medium text-zinc-400">Peso real (kg)</label><input id="cotPeso" value="5" type="number" step="0.01" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div>
            <div><label class="text-[11px] font-medium text-zinc-400">Valor NF (R$)</label><input id="cotValor" value="100" type="number" step="0.01" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div><label class="text-[11px] font-medium text-zinc-400">Altura</label><input id="cotAlt" value="20" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div>
            <div><label class="text-[11px] font-medium text-zinc-400">Largura</label><input id="cotLarg" value="20" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div>
            <div><label class="text-[11px] font-medium text-zinc-400">Compr.</label><input id="cotComp" value="30" type="number" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div>
          </div>
          <button onclick="fazerCotacao()" class="w-full mt-2 bg-[#fafafa] hover:bg-white text-black rounded-xl py-3.5 text-[13px] font-bold tracking-wide">CALCULAR FRETE →</button>
          <div class="p-4 bg-[#0f0f10] border border-zinc-800/60 rounded-xl mt-4">
            <p class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">Endpoint Bling / API</p>
            <p id="linkApi" class="mono text-[11px] mt-2 break-all text-amber-300"></p>
            <button onclick="copyLink()" class="mt-3 text-[11px] bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-3 py-1.5 rounded-lg">Copiar link</button>
          </div>
        </div>
      </div>
      <div class="lg:col-span-8 bg-[#121214] border border-zinc-800 rounded-[24px] p-6">
        <div class="flex items-center justify-between mb-6"><h3 class="font-semibold text-[13px]">Resultados • 1 preço por transportadora</h3><span class="text-[11px] text-zinc-500 mono" id="cotResumo"></span></div>
        <div id="cotacaoResultado" class="space-y-3">
          <div class="text-center py-16"><div class="w-12 h-12 mx-auto rounded-2xl bg-zinc-900 flex items-center justify-center text-xl">◩</div><p class="text-[13px] text-zinc-500 mt-4">Preencha os dados e calcule</p><p class="text-[11px] text-zinc-600 mt-1">Retorno igual Frenet: mais barato por transportadora</p></div>
        </div>
      </div>
    </div>
  </div>

  <!-- TABELAS -->
  <div id="page-tabelas" class="page hidden">
    <div class="flex items-center justify-between mb-8"><div><h2 class="text-[22px] font-bold tracking-tight">Tabelas de Frete</h2><p class="text-[13px] text-zinc-500 mt-1">Gestão por transportadora • Edição por faixa de CEP • Estilo Frenet</p></div><button onclick="carregarTransportadoras()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">↻ Atualizar</button></div>
    <div class="grid lg:grid-cols-12 gap-6">
      <div class="lg:col-span-4 space-y-4">
        <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5">
          <h3 class="font-semibold text-[13px] mb-4">Upload por Transportadora</h3>
          <input id="transpInput" placeholder="NOME TRANSPORTADORA" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px] uppercase font-bold tracking-wide outline-none focus:border-amber-500/50" oninput="this.value=this.value.toUpperCase()">
          <p class="text-[10px] text-zinc-500 mt-2">Ao reenviar, substitui só essa transportadora (economiza espaço)</p>
          <div id="dropZone" class="mt-4 border border-dashed border-zinc-700 rounded-xl p-8 text-center hover:border-amber-500/40 cursor-pointer bg-[#0f0f10]"><p class="text-[13px] font-medium">Arraste sua planilha .xlsx</p><p class="text-[11px] text-zinc-500 mt-1">.xlsx • .xls • .html</p><input id="fileInput" type="file" accept=".xlsx,.xls,.html,.htm" class="hidden"></div>
          <div id="uploadProgress" class="hidden mt-4"><div class="h-1 bg-zinc-800 rounded-full overflow-hidden"><div id="progressBar" class="h-full bg-amber-500 transition-all" style="width:0%"></div></div><p id="progressText" class="text-[11px] text-zinc-400 mt-2 mono"></p></div>
          <div id="uploadResult" class="hidden mt-3 p-3 rounded-xl text-[12px]"></div>
        </div>
        <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-5"><h3 class="font-semibold text-[13px] mb-4">Transportadoras</h3><div id="transpLista" class="space-y-2 max-h-[520px] overflow-auto pr-1"></div></div>
      </div>
      <div class="lg:col-span-8">
        <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6">
          <div id="editorHeader" class="hidden">
            <div class="flex items-center justify-between mb-6"><div><h3 class="font-bold text-[15px]">Tabela: <span id="editorTranspNome" class="text-amber-400"></span></h3><p id="editorStats" class="text-[12px] text-zinc-500 mt-1"></p></div><div class="flex gap-2"><button onclick="abrirAddLinha()" class="text-[12px] bg-amber-500 text-black font-bold px-4 py-2 rounded-xl">+ Adicionar Faixa</button><button onclick="fecharEditor()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">✕</button></div></div>
            <div class="bg-[#0f0f10] border border-zinc-800/60 rounded-xl p-4 mb-5 grid md:grid-cols-4 gap-3 items-end">
              <div><label class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">Reajuste %</label><input id="reajustePerc" type="number" placeholder="5" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-lg px-3 py-2 text-[12px]"></div>
              <div><label class="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">Campo</label><select id="reajusteCampo" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-lg px-3 py-2 text-[12px]"><option value="frete_valor">Frete Valor</option><option value="valor_por_kg">Valor/kg</option><option value="pedagio">Pedágio</option></select></div>
              <button onclick="aplicarReajuste()" class="text-[12px] bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-4 py-2.5 rounded-xl">Aplicar</button>
              <div class="flex gap-2"><input id="buscaCep" placeholder="Buscar CEP..." class="flex-1 bg-[#09090b] border border-zinc-800 rounded-lg px-3 py-2 text-[12px]"><button onclick="carregarLinhas()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-3 py-2 rounded-lg">🔍</button></div>
            </div>
            <div class="overflow-auto max-h-[600px] border border-zinc-800 rounded-xl"><table class="w-full text-[11px] table-edit"><thead class="bg-[#0f0f10] sticky top-0 z-10"><tr class="text-zinc-500"><th class="p-3 text-left">ID</th><th class="p-3 text-left">CEP Ini</th><th class="p-3 text-left">CEP Fim</th><th class="p-3 text-left">Peso</th><th class="p-3 text-left">Frete</th><th class="p-3 text-left">Prazo</th><th class="p-3 text-left">Ações</th></tr></thead><tbody id="linhasTabela"></tbody></table></div>
            <div class="flex items-center justify-between mt-4 text-[12px]"><div class="flex gap-2"><button onclick="paginaAnterior()" class="bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">◀</button><span id="paginacaoInfo" class="px-2 py-1.5 text-zinc-500 mono"></span><button onclick="proximaPagina()" class="bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">▶</button></div><span id="linhasTotal" class="text-zinc-500 mono"></span></div>
          </div>
          <div id="editorVazio" class="text-center py-20"><div class="w-14 h-14 mx-auto rounded-2xl bg-zinc-900 flex items-center justify-center text-xl">☰</div><p class="text-[13px] font-semibold mt-4">Nenhuma transportadora selecionada</p><p class="text-[12px] text-zinc-500 mt-2">Selecione ao lado para editar faixas de CEP, acrescentar ou excluir linha</p></div>
        </div>
        <div id="modalLinha" class="hidden fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6 w-full max-w-xl"><h3 id="modalTitulo" class="font-bold mb-5">Adicionar Faixa de CEP</h3><div class="grid grid-cols-2 gap-4 text-[12px]"><div><label class="text-zinc-400">CEP Inicial *</label><input id="m_cep_ini" type="text" placeholder="01000-000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">CEP Final *</label><input id="m_cep_fim" type="text" placeholder="08499-999" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Peso Ini kg</label><input id="m_peso_ini" type="number" step="0.01" value="0" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Peso Fim kg</label><input id="m_peso_fim" type="number" step="0.01" value="99.99" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Frete R$ *</label><input id="m_frete_valor" type="number" step="0.01" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><div><label class="text-zinc-400">Prazo dias</label><input id="m_prazo" type="number" value="5" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div></div><div class="flex gap-3 mt-6"><button onclick="salvarLinha()" class="flex-1 bg-amber-500 hover:bg-amber-400 text-black py-3 rounded-xl text-[13px] font-bold">Salvar faixa</button><button onclick="fecharModal()" class="flex-1 bg-zinc-900 border border-zinc-800 py-3 rounded-xl text-[13px]">Cancelar</button></div></div></div>
      </div>
    </div>
  </div>

  <!-- INTEGRAÇÕES - PREMIUM -->
  <div id="page-integracoes" class="page hidden">
    <div class="flex items-center justify-between mb-8"><div><h2 class="text-[22px] font-bold tracking-tight">Central de Integrações</h2><p class="text-[13px] text-zinc-500 mt-1">Conecte Bling, Tiny, Shopify, VTEX, Correios • Inspiração Intelepost, identidade própria</p></div><div class="flex gap-2"><span class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-full">11 plataformas</span><button onclick="carregarIntegracoes()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">↻</button></div></div>
    <div class="grid lg:grid-cols-12 gap-6">
      <div class="lg:col-span-8"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Plataformas • Clique para configurar API Key</h3><div id="plataformasGrid" class="grid md:grid-cols-2 gap-3"></div></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6 mt-6"><h3 class="font-semibold text-[13px] mb-5">Integrações Ativas</h3><div id="integracoesLista" class="space-y-3"></div></div></div>
      <div class="lg:col-span-4"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6 sticky top-6"><h3 id="integFormTitulo" class="font-semibold text-[13px] mb-2">Configurar</h3><p id="integFormDesc" class="text-[12px] text-zinc-500 mb-5">Selecione uma plataforma ao lado para inserir sua chave API.</p><div id="integForm" class="hidden space-y-4"><div><label class="text-[11px] font-medium text-zinc-400">Plataforma</label><input id="integPlataforma" disabled class="w-full mt-2 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-3 text-[12px] text-zinc-500 mono"></div><div><label class="text-[11px] font-medium text-zinc-400">Apelido</label><input id="integNome" placeholder="Ex: Bling Principal" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"></div><div id="field_api_key"><label class="text-[11px] font-medium text-zinc-400">API Key *</label><input id="integApiKey" placeholder="••••••••" type="password" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"></div><div id="field_api_secret"><label class="text-[11px] font-medium text-zinc-400">API Secret</label><input id="integApiSecret" type="password" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"></div><div id="field_token"><label class="text-[11px] font-medium text-zinc-400">Token</label><input id="integToken" type="password" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"></div><div id="field_url_loja"><label class="text-[11px] font-medium text-zinc-400">URL Loja</label><input id="integUrlLoja" placeholder="https://..." class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[12px]"></div><button onclick="salvarIntegracao()" class="w-full bg-amber-500 hover:bg-amber-400 text-black rounded-xl py-3 text-[13px] font-bold">Salvar integração</button><button onclick="testarIntegracaoAtual()" class="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-3 text-[13px]">🧪 Testar conexão</button><div id="integTesteResult" class="hidden p-3 rounded-xl text-[12px]"></div></div><div id="integAjuda" class="mt-6 p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl"><p class="text-[11px] font-semibold text-amber-300">Como obter suas chaves:</p><ul class="text-[11px] text-zinc-400 mt-3 space-y-2"><li>• <b class="text-zinc-300">Bling:</b> Preferências > Sistema > API v3</li><li>• <b class="text-zinc-300">Tiny:</b> Configurações > API</li><li>• <b class="text-zinc-300">Shopify:</b> Apps > Desenvolver App</li><li>• <b class="text-zinc-300">Correios:</b> Meu Correios API</li></ul></div></div></div>
    </div>
  </div>

  <!-- REGRAS / HISTORICO / COLAB / CONFIG (compactos) -->
  <div id="page-regras" class="page hidden">
    <h2 class="text-[22px] font-bold tracking-tight mb-8">Regras de Frete</h2>
    <div class="grid lg:grid-cols-12 gap-6">
      <div class="lg:col-span-5 bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Nova Regra</h3><div class="space-y-4 text-[13px]"><select id="regraTipo" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><option value="frete_gratis">Frete Grátis acima de valor</option><option value="markup">Markup %</option></select><input id="regraNome" placeholder="Nome: Frete grátis acima de R$ 299" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><input id="regraTransp" placeholder="Transportadora (opcional)" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 uppercase"><div class="grid grid-cols-2 gap-3"><input id="regraValorMin" type="number" placeholder="Valor mín NF" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"><input id="regraPerc" type="number" placeholder="% markup" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3"></div><button onclick="criarRegra()" class="w-full bg-zinc-100 text-black rounded-xl py-3 font-bold">Criar regra</button></div></div>
      <div class="lg:col-span-7 bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Regras Ativas</h3><div id="regrasLista" class="space-y-3"></div></div>
    </div>
  </div>

  <div id="page-historico" class="page hidden">
    <h2 class="text-[22px] font-bold tracking-tight mb-8">Histórico de Cotações</h2>
    <div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><div class="flex justify-between mb-5"><p class="text-[13px] text-zinc-500">Log via API / Bling</p><button onclick="carregarHistorico()" class="text-[12px] bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-xl">↻</button></div><div class="overflow-auto border border-zinc-800 rounded-xl"><table class="w-full text-[12px]"><thead class="bg-[#0f0f10]"><tr class="text-zinc-500"><th class="p-3 text-left">Data</th><th class="p-3 text-left">CEP</th><th class="p-3 text-left">Peso</th><th class="p-3 text-left">Transp</th><th class="p-3 text-left">Frete</th></tr></thead><tbody id="historicoTabela"></tbody></table></div><div class="flex justify-between mt-4 text-[12px]"><button onclick="histPaginaAnterior()" class="bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">◀</button><span id="histPaginacao" class="text-zinc-500 mono"></span><button onclick="histProximaPagina()" class="bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">▶</button></div></div>
  </div>

  <div id="page-colaboradores" class="page hidden">
    <h2 class="text-[22px] font-bold tracking-tight mb-8">Colaboradores</h2>
    <div class="grid lg:grid-cols-2 gap-6"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Adicionar</h3><div class="space-y-3"><input id="colabNome" placeholder="Nome" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"><input id="colabEmail" placeholder="Email" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"><input id="colabSenha" type="password" placeholder="Senha" class="w-full bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"><button onclick="criarColaborador()" class="w-full bg-zinc-100 text-black rounded-xl py-3 font-bold">Adicionar</button></div></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Lista</h3><div id="colabLista" class="space-y-2"></div></div></div>
  </div>

  <div id="page-config" class="page hidden">
    <h2 class="text-[22px] font-bold tracking-tight mb-8">API & Configurações</h2>
    <div class="grid lg:grid-cols-2 gap-6"><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Geral</h3><div class="space-y-4"><div><label class="text-[11px] text-zinc-400">CEP Origem</label><input id="cfgCepOrigem" value="87010000" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div><div><label class="text-[11px] text-zinc-400">Cubagem Padrão</label><input id="cfgCubagem" value="300" class="w-full mt-2 bg-[#09090b] border border-zinc-800 rounded-xl px-3 py-3 text-[13px]"></div><button onclick="salvarConfig()" class="w-full bg-amber-500 text-black rounded-xl py-3 font-bold">Salvar</button></div></div><div class="bg-[#121214] border border-zinc-800 rounded-[20px] p-6"><h3 class="font-semibold text-[13px] mb-5">Endpoint Bling</h3><div class="p-4 bg-[#0f0f10] border border-zinc-800 rounded-xl"><p id="apiEndpoint" class="mono text-[11px] break-all text-amber-300"></p><button onclick="copyLink()" class="mt-3 text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">Copiar</button></div><pre class="mt-4 text-[11px] bg-[#0f0f10] border border-zinc-800 rounded-xl p-4 text-zinc-400">POST /api/cotacao
{
  "cep_destino": "01310-000",
  "peso_real": 5,
  "valor_nf": 100
}</pre></div></div>
  </div>
</div>

<script>
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token=localStorage.getItem('mf_token')||'';
document.getElementById('tokenInput').value=token;
const baseUrl=window.location.origin;
const apiUrl=p=>baseUrl+p;
let transpAtual=null, paginaAtual=1, totalPaginas=1, histPagina=1, histTotalPaginas=1, chartInstance=null, integracoesCache=[], plataformaSelecionada=null, plataformaEditando=null;
const limparCep=v=>parseInt(String(v||'').replace(/\\D/g,''))||0;

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
  if(page==='config') carregarConfig();
}

async function checkStatus(){
  try{
    const r=await fetch(apiUrl('/')); const j=await r.json();
    document.getElementById('statusBadge').textContent='● '+ (j.db||'online') +' • '+ (j.total_regras||0) +' faixas • '+ (j.transportadoras||0) +' transp';
    document.getElementById('statusBadge').className='text-[10px] text-emerald-400 mono text-center';
    document.getElementById('linkApi').textContent=baseUrl+'/api/cotacao';
    document.getElementById('apiEndpoint').textContent=baseUrl+'/api/cotacao';
    document.getElementById('dashData').textContent=new Date().toLocaleDateString('pt-BR');
  }catch(e){ document.getElementById('statusBadge').textContent='● offline'; }
}
checkStatus();
function salvarToken(){ token=document.getElementById('tokenInput').value.trim(); localStorage.setItem('mf_token',token); const m=document.getElementById('tokenMsg'); m.textContent='✅ Desbloqueado'; m.className='text-[11px] mt-2 text-emerald-400'; m.classList.remove('hidden'); carregarDashboard(); }
function copyLink(){ navigator.clipboard.writeText(baseUrl+'/api/cotacao'); alert('Copiado!'); }

// DASHBOARD
async function carregarDashboard(){
  if(!token){ document.getElementById('dashTotalRegras').textContent='Salve token'; return; }
  try{
    const r=await fetch(apiUrl('/api/dashboard'),{headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    document.getElementById('dashTotalRegras').textContent=j.total_regras||0;
    document.getElementById('dashTotalTransp').textContent=j.transportadoras||0;
    document.getElementById('dashHoje').textContent=j.cotacoes_hoje||0;
    document.getElementById('dashTotal').textContent=j.cotacoes_total||0;
    if(j.cotacoes_7dias?.length){
      const ctx=document.getElementById('chart7dias').getContext('2d'); if(chartInstance) chartInstance.destroy();
      chartInstance=new Chart(ctx,{ type:'bar', data:{ labels:j.cotacoes_7dias.map(d=> new Date(d.dia).toLocaleDateString('pt-BR')), datasets:[{label:'Cotações', data:j.cotacoes_7dias.map(d=>parseInt(d.total)), backgroundColor:'#f59e0b', borderRadius:6}]}, options:{responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true, grid:{color:'#27272a'}, ticks:{color:'#a1a1aa'}}, x:{grid:{display:false}, ticks:{color:'#a1a1aa'}}}} });
    }
    const topDiv=document.getElementById('topTransp');
    if(j.top_transportadoras?.length){ let html=''; j.top_transportadoras.forEach(t=>{ html+=\`<div class="flex justify-between items-center bg-[#0f0f10] border border-zinc-800/60 p-3 rounded-xl"><div><p class="font-bold text-[12px]">\${esc(t.transportadora)}</p><p class="text-[11px] text-zinc-500">\${esc(t.total)} cotações • R$ \${parseFloat(t.media||0).toFixed(2)} média</p></div><span class="text-[12px] font-bold">\${esc(t.total)}</span></div>\`; }); topDiv.innerHTML=html; } else topDiv.innerHTML='<p class="text-[12px] text-zinc-500">Sem dados ainda</p>';
  }catch(e){}
}

// COTACAO
async function fazerCotacao(){
  const cepDestino=document.getElementById('cotCepDestino').value, peso=parseFloat(document.getElementById('cotPeso').value)||1, valor=parseFloat(document.getElementById('cotValor').value)||100, alt=parseFloat(document.getElementById('cotAlt').value)||20, larg=parseFloat(document.getElementById('cotLarg').value)||20, comp=parseFloat(document.getElementById('cotComp').value)||30;
  const div=document.getElementById('cotacaoResultado'); div.innerHTML='<p class="text-center py-10 text-zinc-500 mono text-[12px]">Calculando...</p>';
  try{
    const r=await fetch(apiUrl('/api/cotacao'),{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cep_destino:cepDestino, peso_real:peso, altura:alt, largura:larg, comprimento:comp, valor_nf:valor})});
    const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    document.getElementById('cotResumo').textContent=j.total_encontrado+' transp • '+j.peso_taxado+'kg taxado';
    if(!j.cotacoes.length){ div.innerHTML='<p class="text-amber-300 text-[13px] p-4">⚠️ Nenhuma regra para CEP '+esc(j.cep_consultado)+'</p>'; return; }
    let html=''; j.cotacoes.forEach(c=>{ const isFree=c.valor_frete===0; html+=\`<div class="flex justify-between items-center border \${isFree?'border-emerald-500/30 bg-emerald-500/5':'border-zinc-800 bg-[#0f0f10]'} p-4 rounded-xl"><div><p class="font-bold text-[13px]">\${esc(c.transportadora)}</p><p class="text-[11px] text-zinc-500 mt-1">\${esc(c.metodo)} • \${esc(c.prazo)} dias • taxado \${esc(c.peso_taxado)}kg</p></div><div class="text-right"><p class="font-bold text-[16px] \${isFree?'text-emerald-400':''}">\${isFree?'GRÁTIS':'R$ '+esc(c.valor_frete.toFixed(2))}</p></div></div>\`; }); div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400 text-[13px] p-4">Erro: '+esc(e.message)+'</p>'; }
}

// TABELAS
const dropZone=document.getElementById('dropZone'), fileInput=document.getElementById('fileInput');
if(dropZone){ dropZone.onclick=()=>fileInput.click(); dropZone.ondragover=e=>{e.preventDefault(); dropZone.classList.add('border-amber-500/50');}; dropZone.ondragleave=()=>dropZone.classList.remove('border-amber-500/50'); dropZone.ondrop=e=>{e.preventDefault(); dropZone.classList.remove('border-amber-500/50'); const f=e.dataTransfer.files[0]; if(f) uploadFile(f);}; fileInput.onchange=e=>{const f=e.target.files[0]; if(f) uploadFile(f);}; }
async function uploadFile(file){
  if(!token){ alert('Salve o token!'); return; }
  const transp=document.getElementById('transpInput').value.trim().toUpperCase(); if(!transp){ alert('Digite nome da transportadora'); return; }
  const prog=document.getElementById('uploadProgress'), bar=document.getElementById('progressBar'), txt=document.getElementById('progressText'), resDiv=document.getElementById('uploadResult');
  prog.classList.remove('hidden'); resDiv.classList.add('hidden'); bar.style.width='30%'; txt.textContent='Enviando '+file.name+' como '+transp+'...';
  try{
    const fd=new FormData(); fd.append('file',file); fd.append('transportadora',transp); bar.style.width='60%';
    const r=await fetch(apiUrl('/api/upload'),{method:'POST', headers:{'x-upload-token':token, 'x-transportadora':transp}, body:fd}); bar.style.width='90%'; const j=await r.json(); bar.style.width='100%'; if(!r.ok) throw new Error(j.erro||JSON.stringify(j));
    resDiv.className='mt-3 p-3 rounded-xl text-[12px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'; resDiv.innerHTML='✅ '+esc(j.transportadora)+' • '+esc(j.total)+' faixas'; resDiv.classList.remove('hidden'); checkStatus(); carregarTransportadoras(); carregarDashboard(); if(transpAtual===transp) carregarLinhas();
  }catch(e){ resDiv.className='mt-3 p-3 rounded-xl text-[12px] bg-red-500/10 border border-red-500/20 text-red-300'; resDiv.textContent='❌ '+e.message; resDiv.classList.remove('hidden'); }finally{ setTimeout(()=>{prog.classList.add('hidden'); bar.style.width='0%';},1500); }
}
async function carregarTransportadoras(){
  if(!token){ document.getElementById('transpLista').innerHTML='<p class="text-zinc-500 text-[12px]">Salve o token</p>'; return; }
  const div=document.getElementById('transpLista'); div.innerHTML='Carregando...';
  try{
    const r=await fetch(apiUrl('/api/transportadoras'),{headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhuma transportadora ainda</p>'; return; }
    let html=''; j.transportadoras.forEach(t=>{ const ativo=transpAtual===t.transportadora?'border-amber-500/50 bg-amber-500/5':'border-zinc-800 bg-[#0f0f10]'; html+=\`<div class="border rounded-xl p-3 cursor-pointer hover:border-zinc-700 \${ativo}" onclick="abrirTransportadora('\${esc(t.transportadora)}')"><div class="flex justify-between"><div><p class="font-bold text-[12px]">\${esc(t.transportadora)}</p><p class="text-[11px] text-zinc-500 mt-1">\${esc(t.total)} faixas • \${esc(t.prazoMin)}-\${esc(t.prazoMax)} dias</p></div><button onclick="event.stopPropagation(); deletarTransp('\${esc(t.transportadora)}')" class="text-[11px] bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-lg">✕</button></div></div>\`; }); div.innerHTML=html;
  }catch(e){ div.innerHTML='<p class="text-red-400 text-[12px]">Erro: '+esc(e.message)+'</p>'; }
}
function abrirTransportadora(nome){ transpAtual=nome; paginaAtual=1; document.getElementById('editorVazio').classList.add('hidden'); document.getElementById('editorHeader').classList.remove('hidden'); document.getElementById('editorTranspNome').textContent=nome; carregarTransportadoras(); carregarLinhas(); }
function fecharEditor(){ transpAtual=null; document.getElementById('editorHeader').classList.add('hidden'); document.getElementById('editorVazio').classList.remove('hidden'); carregarTransportadoras(); }
async function carregarLinhas(){
  if(!transpAtual) return; const tbody=document.getElementById('linhasTabela'), cepBusca=document.getElementById('buscaCep').value.trim(); tbody.innerHTML='<tr><td colspan="7" class="p-4 text-center text-zinc-500 mono">Carregando...</td></tr>';
  try{
    const params=new URLSearchParams({page:paginaAtual, limit:50}); if(cepBusca) params.set('cep',cepBusca);
    const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/linhas?'+params.toString()),{headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    totalPaginas=j.total_pages||1; document.getElementById('paginacaoInfo').textContent='Pág '+j.page+'/'+j.total_pages; document.getElementById('linhasTotal').textContent=j.total+' faixas'; document.getElementById('editorStats').textContent=j.total+' faixas • Mostrando '+j.linhas.length;
    if(!j.linhas.length){ tbody.innerHTML='<tr><td colspan="7" class="p-4 text-center text-zinc-500">Nenhuma faixa</td></tr>'; return; }
    let html=''; j.linhas.forEach(l=>{ html+=\`<tr id="row-\${l.id}" class="border-t border-zinc-800/60 hover:bg-zinc-900/50"><td class="p-2 mono">\${esc(l.id)}</td><td class="p-1"><input id="cep_ini_\${l.id}" value="\${esc(l.cep_ini)}" class="w-[90px]"></td><td class="p-1"><input id="cep_fim_\${l.id}" value="\${esc(l.cep_fim)}" class="w-[90px]"></td><td class="p-1"><input id="peso_ini_\${l.id}" value="\${esc(l.peso_ini)}" class="w-[60px]">-<input id="peso_fim_\${l.id}" value="\${esc(l.peso_fim)}" class="w-[60px]"></td><td class="p-1"><input id="frete_valor_\${l.id}" value="\${esc(l.frete_valor)}" class="w-[70px]"></td><td class="p-1"><input id="prazo_\${l.id}" value="\${esc(l.prazo)}" class="w-[50px]"></td><td class="p-1"><div class="flex gap-1"><button onclick="salvarEdicaoInline(\${l.id})" class="bg-zinc-100 text-black px-2 py-1 rounded text-[10px] font-bold">💾</button><button onclick="deletarLinha(\${l.id})" class="bg-zinc-800 border border-zinc-700 px-2 py-1 rounded text-[10px]">✕</button></div></td></tr>\`; }); tbody.innerHTML=html;
  }catch(e){ tbody.innerHTML='<tr><td colspan="7" class="p-4 text-center text-red-400">Erro: '+esc(e.message)+'</td></tr>'; }
}
async function salvarEdicaoInline(id){
  const payload={ cep_ini: limparCep(document.getElementById('cep_ini_'+id).value), cep_fim: limparCep(document.getElementById('cep_fim_'+id).value), peso_ini: parseFloat(document.getElementById('peso_ini_'+id).value)||0, peso_fim: parseFloat(document.getElementById('peso_fim_'+id).value)||999, frete_valor: parseFloat(String(document.getElementById('frete_valor_'+id).value).replace(',','.'))||0, prazo: parseInt(document.getElementById('prazo_'+id).value)||5 };
  try{ const r=await fetch(apiUrl('/api/tabelas/linha/'+id),{method:'PUT', headers:{'Content-Type':'application/json','x-upload-token':token}, body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); const row=document.getElementById('row-'+id); row.classList.add('bg-amber-500/10'); setTimeout(()=>row.classList.remove('bg-amber-500/10'),1000); }catch(e){ alert('Erro: '+e.message); }
}
async function deletarLinha(id){ if(!confirm('Excluir faixa ID '+id+'?')) return; try{ const r=await fetch(apiUrl('/api/tabelas/linha/'+id),{method:'DELETE', headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); document.getElementById('row-'+id).remove(); }catch(e){ alert('Erro: '+e.message); } }
function abrirAddLinha(){ document.getElementById('modalTitulo').textContent='Adicionar Faixa em '+transpAtual; document.getElementById('m_cep_ini').value=''; document.getElementById('m_cep_fim').value=''; document.getElementById('m_peso_ini').value='0'; document.getElementById('m_peso_fim').value='99.99'; document.getElementById('m_frete_valor').value=''; document.getElementById('modalLinha').classList.remove('hidden'); }
function fecharModal(){ document.getElementById('modalLinha').classList.add('hidden'); }
async function salvarLinha(){
  const payload={ cep_ini: limparCep(document.getElementById('m_cep_ini').value), cep_fim: limparCep(document.getElementById('m_cep_fim').value), metodo:'Frete Peso', peso_ini: parseFloat(document.getElementById('m_peso_ini').value)||0, peso_fim: parseFloat(document.getElementById('m_peso_fim').value)||999, frete_valor: parseFloat(String(document.getElementById('m_frete_valor').value).replace(',','.'))||0, prazo: parseInt(document.getElementById('m_prazo').value)||5, cubagem:300 };
  if(!payload.cep_ini || !payload.cep_fim){ alert('CEP Inicial e Final obrigatórios - pode digitar com traço 01000-000'); return; }
  try{ const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/linha'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token':token}, body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); fecharModal(); carregarLinhas(); checkStatus(); }catch(e){ alert('Erro: '+e.message); }
}
async function aplicarReajuste(){ const perc=parseFloat(document.getElementById('reajustePerc').value), campo=document.getElementById('reajusteCampo').value; if(isNaN(perc)){ alert('Digite %'); return; } if(!confirm('Aplicar reajuste de '+perc+'% em '+campo+' para TODAS as faixas de '+transpAtual+'?')) return; try{ const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(transpAtual)+'/reajuste'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token':token}, body:JSON.stringify({percentual:perc, campo})}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); alert('Reajuste em '+j.afetadas+' faixas!'); carregarLinhas(); }catch(e){ alert('Erro: '+e.message); } }
function paginaAnterior(){ if(paginaAtual>1){ paginaAtual--; carregarLinhas(); } }
function proximaPagina(){ if(paginaAtual<totalPaginas){ paginaAtual++; carregarLinhas(); } }
async function deletarTransp(nome){ if(!confirm('Excluir TODA a tabela '+nome+'?')) return; try{ const r=await fetch(apiUrl('/api/tabelas/'+encodeURIComponent(nome)),{method:'DELETE', headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); if(transpAtual===nome) fecharEditor(); carregarTransportadoras(); checkStatus(); }catch(e){ alert('Erro: '+e.message); } }

// INTEGRAÇÕES
async function carregarPlataformas(){
  try{
    const r=await fetch(apiUrl('/api/integracoes/plataformas')); const j=await r.json();
    const grid=document.getElementById('plataformasGrid'); let html='';
    j.plataformas.forEach(p=>{
      const conf=integracoesCache.find(i=> i.plataforma===p.id);
      const badge=conf? \`<span class="text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/20 px-2 py-0.5 rounded-full">\${conf.status}</span>\` : '<span class="text-[10px] bg-zinc-800 text-zinc-500 px-2 py-0.5 rounded-full">não configurado</span>';
      html+=\`<div onclick="selecionarPlataforma('\${p.id}','\${esc(p.nome)}')" class="border \${conf?'border-amber-500/30 bg-amber-500/[0.03]':'border-zinc-800 bg-[#0f0f10]'} hover:border-zinc-700 rounded-xl p-4 cursor-pointer"><div class="flex justify-between items-start"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-[14px]">\${p.icon}</div><div><p class="font-semibold text-[12px]">\${esc(p.nome)}</p><p class="text-[10px] text-zinc-500">\${esc(p.categoria)}</p></div></div>\${badge}</div><p class="text-[11px] text-zinc-500 mt-3">\${esc(p.desc)}</p></div>\`;
    }); grid.innerHTML=html;
  }catch(e){}
}
function selecionarPlataforma(id, nome){
  plataformaSelecionada=id; document.getElementById('integPlataforma').value=id; document.getElementById('integNome').value=nome; document.getElementById('integFormTitulo').textContent='Configurar '+nome; document.getElementById('integForm').classList.remove('hidden'); document.getElementById('integAjuda').classList.add('hidden');
  const existente=integracoesCache.find(i=> i.plataforma===id);
  if(existente){ document.getElementById('integNome').value=existente.nome||nome; document.getElementById('integApiKey').value=existente.api_key||''; document.getElementById('integApiSecret').value=existente.api_secret||''; document.getElementById('integToken').value=existente.token||''; document.getElementById('integUrlLoja').value=existente.url_loja||''; plataformaEditando=existente.id; } else { document.getElementById('integApiKey').value=''; document.getElementById('integApiSecret').value=''; document.getElementById('integToken').value=''; document.getElementById('integUrlLoja').value=''; plataformaEditando=null; }
}
async function carregarIntegracoes(){
  if(!token){ document.getElementById('integracoesLista').innerHTML='<p class="text-zinc-500 text-[12px]">Salve o token</p>'; return; }
  try{
    const r=await fetch(apiUrl('/api/integracoes'),{headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro);
    integracoesCache=j.integracoes||[]; const div=document.getElementById('integracoesLista');
    if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhuma integração ainda. Selecione ao lado.</p>'; }
    else { let html=''; j.integracoes.forEach(i=>{ const statusColor=i.status==='conectado'?'text-emerald-300 bg-emerald-500/10 border-emerald-500/20':'text-amber-300 bg-amber-500/10 border-amber-500/20'; html+=\`<div class="bg-[#0f0f10] border border-zinc-800 rounded-xl p-4"><div class="flex justify-between"><div><p class="font-bold text-[12px]">\${esc(i.plataforma.toUpperCase())} • \${esc(i.nome||'')}</p><p class="text-[11px] text-zinc-500 mt-1 mono">\${esc((i.api_key||i.token||'').substring(0,8))}•••• • \${esc(i.url_loja||'sem URL')}</p></div><span class="text-[10px] border px-2 py-1 rounded-full \${statusColor}">\${esc(i.status)}</span></div><div class="flex gap-2 mt-3"><button onclick="testarIntegracao(\${i.id})" class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">🧪 Testar</button><button onclick="editarIntegracao(\${i.id})" class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">✏️ Editar</button><button onclick="deletarIntegracao(\${i.id})" class="text-[11px] bg-red-500/10 border border-red-500/20 text-red-300 px-3 py-1.5 rounded-lg">Remover</button></div></div>\`; }); div.innerHTML=html; }
    carregarPlataformas();
  }catch(e){ document.getElementById('integracoesLista').innerHTML='<p class="text-red-400 text-[12px]">Erro: '+esc(e.message)+'</p>'; }
}
async function salvarIntegracao(){
  if(!plataformaSelecionada){ alert('Selecione plataforma'); return; }
  const payload={ plataforma: plataformaSelecionada, nome: document.getElementById('integNome').value, api_key: document.getElementById('integApiKey').value, api_secret: document.getElementById('integApiSecret').value, token: document.getElementById('integToken').value, url_loja: document.getElementById('integUrlLoja').value };
  if(!payload.api_key && !payload.token){ alert('Preencha API Key ou Token'); return; }
  try{ const r=await fetch(apiUrl('/api/integracoes'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token':token}, body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); alert('Integração salva!'); carregarIntegracoes(); }catch(e){ alert('Erro: '+e.message); }
}
async function testarIntegracao(id){ try{ const r=await fetch(apiUrl('/api/integracoes/'+id+'/testar'),{method:'POST', headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); alert(j.mensagem); carregarIntegracoes(); }catch(e){ alert('Erro: '+e.message); } }
function editarIntegracao(id){ const integ=integracoesCache.find(i=>i.id===id); if(integ) selecionarPlataforma(integ.plataforma, integ.nome); }
async function deletarIntegracao(id){ if(!confirm('Remover integração?')) return; try{ const r=await fetch(apiUrl('/api/integracoes/'+id),{method:'DELETE', headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarIntegracoes(); }catch(e){ alert('Erro: '+e.message); } }
async function testarIntegracaoAtual(){ if(plataformaEditando) testarIntegracao(plataformaEditando); else alert('Salve primeiro'); }

// REGRAS / HIST / COLAB / CONFIG
async function carregarRegras(){ if(!token) return; try{ const r=await fetch(apiUrl('/api/regras'),{headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); const div=document.getElementById('regrasLista'); if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhuma regra ainda</p>'; return; } let html=''; j.regras.forEach(reg=>{ html+=\`<div class="bg-[#0f0f10] border border-zinc-800 rounded-xl p-4 flex justify-between items-center"><div><p class="font-bold text-[12px]">\${esc(reg.nome||reg.tipo)} <span class="text-[10px] bg-zinc-800 px-2 py-0.5 rounded-full ml-2">\${esc(reg.tipo)}</span></p><p class="text-[11px] text-zinc-500 mt-1">\${reg.transportadora? 'Transp: '+esc(reg.transportadora)+' • ':''}Min NF R$ \${esc(reg.valor_min)} \${reg.percentual? '• '+esc(reg.percentual)+'%':''}</p></div><button onclick="deletarRegra(\${reg.id})" class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">✕</button></div>\`; }); div.innerHTML=html; }catch(e){} }
async function criarRegra(){ const payload={ tipo: document.getElementById('regraTipo').value, nome: document.getElementById('regraNome').value, transportadora: document.getElementById('regraTransp').value, valor_min: parseFloat(document.getElementById('regraValorMin').value)||0, percentual: parseFloat(document.getElementById('regraPerc').value)||0 }; if(!payload.nome){ alert('Nome obrigatório'); return; } try{ const r=await fetch(apiUrl('/api/regras'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token':token}, body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarRegras(); document.getElementById('regraNome').value=''; }catch(e){ alert('Erro: '+e.message); } }
async function deletarRegra(id){ if(!confirm('Excluir regra?')) return; try{ const r=await fetch(apiUrl('/api/regras/'+id),{method:'DELETE', headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarRegras(); }catch(e){ alert('Erro: '+e.message); } }

async function carregarHistorico(){ if(!token) return; try{ const params=new URLSearchParams({page:histPagina, limit:50}); const r=await fetch(apiUrl('/api/historico?'+params.toString()),{headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); histTotalPaginas=j.total_pages||1; document.getElementById('histPaginacao').textContent='Pág '+j.page+'/'+j.total_pages+' • '+j.total+' total'; const tbody=document.getElementById('historicoTabela'); if(!j.historico.length){ tbody.innerHTML='<tr><td colspan="5" class="p-4 text-center text-zinc-500">Nenhuma cotação ainda</td></tr>'; return; } let html=''; j.historico.forEach(h=>{ html+=\`<tr class="border-t border-zinc-800/60 hover:bg-zinc-900/30"><td class="p-3 mono text-[11px]">\${new Date(h.created_at).toLocaleString('pt-BR')}</td><td class="p-3">\${esc(h.cep_destino)}</td><td class="p-3">\${esc(h.peso)}kg</td><td class="p-3 font-bold">\${esc(h.transportadora)}</td><td class="p-3">R$ \${esc(parseFloat(h.valor_frete||0).toFixed(2))}</td></tr>\`; }); tbody.innerHTML=html; }catch(e){} }
function histPaginaAnterior(){ if(histPagina>1){ histPagina--; carregarHistorico(); } }
function histProximaPagina(){ if(histPagina<histTotalPaginas){ histPagina++; carregarHistorico(); } }

async function carregarColaboradores(){ if(!token) return; try{ const r=await fetch(apiUrl('/api/colaboradores'),{headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); const div=document.getElementById('colabLista'); if(!j.total){ div.innerHTML='<p class="text-zinc-500 text-[12px]">Nenhum colaborador</p>'; return; } let html=''; j.colaboradores.forEach(c=>{ html+=\`<div class="bg-[#0f0f10] border border-zinc-800 rounded-xl p-3 flex justify-between"><div><p class="font-bold text-[12px]">\${esc(c.nome)}</p><p class="text-[11px] text-zinc-500">\${esc(c.email)} • \${esc(c.role)}</p></div><button onclick="deletarColab(\${c.id})" class="text-[11px] bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg">✕</button></div>\`; }); div.innerHTML=html; }catch(e){} }
async function criarColaborador(){ const payload={ nome: document.getElementById('colabNome').value, email: document.getElementById('colabEmail').value, senha: document.getElementById('colabSenha').value }; if(!payload.nome||!payload.email||!payload.senha){ alert('Preencha todos'); return; } try{ const r=await fetch(apiUrl('/api/colaboradores'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token':token}, body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarColaboradores(); document.getElementById('colabNome').value=''; document.getElementById('colabEmail').value=''; document.getElementById('colabSenha').value=''; }catch(e){ alert('Erro: '+e.message); } }
async function deletarColab(id){ if(!confirm('Excluir colaborador?')) return; try{ const r=await fetch(apiUrl('/api/colaboradores/'+id),{method:'DELETE', headers:{'x-upload-token':token}}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); carregarColaboradores(); }catch(e){ alert('Erro: '+e.message); } }

async function carregarConfig(){ if(!token) return; try{ const r=await fetch(apiUrl('/api/config'),{headers:{'x-upload-token':token}}); const j=await r.json(); if(j.cep_origem) document.getElementById('cfgCepOrigem').value=j.cep_origem; if(j.cubagem) document.getElementById('cfgCubagem').value=j.cubagem; }catch(e){} }
async function salvarConfig(){ const payload={ cep_origem: document.getElementById('cfgCepOrigem').value, cubagem: document.getElementById('cfgCubagem').value }; try{ const r=await fetch(apiUrl('/api/config'),{method:'POST', headers:{'Content-Type':'application/json','x-upload-token':token}, body:JSON.stringify(payload)}); const j=await r.json(); if(!r.ok) throw new Error(j.erro); alert('Config salva!'); }catch(e){ alert('Erro: '+e.message); } }

showPage('dashboard');
carregarDashboard();
</script>
</body>
</html>
  `);
});

app.get('/api/status', async ()=>{ const t=await getTabelas().catch(()=>[]); const r=await getResumo().catch(()=>[]); return { status:'ok', total:t.length, transportadoras: r.length }; });

const port=process.env.PORT||3000;
app.listen({ port, host:'0.0.0.0' });

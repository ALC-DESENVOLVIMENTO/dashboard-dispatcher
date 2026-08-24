from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
from collections import defaultdict
import re, json, unicodedata
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
path=Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\Rotas 1 a 31 Julho DDS preenchida.xlsx')
reserve_path=Path(r'C:\Users\Wesley\Downloads\Pasta1.xlsx')
def norm(s): return ''.join(c for c in unicodedata.normalize('NFD',str(s or '').upper()) if unicodedata.category(c)!='Mn')
def plate_norm(s): return re.sub(r'[^A-Z0-9]', '', norm(s))
def base_match(reserve_base, dds_base):
 return norm(dds_base).startswith(norm(reserve_base)) or norm(reserve_base).startswith(norm(dds_base))
def read_reserve(path):
 out=[]
 if not path.exists(): return out
 with ZipFile(path) as rz:
  shared=[]
  if 'xl/sharedStrings.xml' in rz.namelist():
   sroot=ET.fromstring(rz.read('xl/sharedStrings.xml'))
   for si in sroot.findall('m:si',NS): shared.append(''.join(t.text or '' for t in si.iter('{%s}t'%NS['m'])))
  xml=ET.fromstring(rz.read('xl/worksheets/sheet1.xml')); rows=[]
  for row in xml.findall('.//m:sheetData/m:row',NS):
   d={}
   for c in row.findall('m:c',NS):
    ref=c.attrib.get('r',''); col=re.sub(r'\d','',ref); v=c.find('m:v',NS); val=v.text if v is not None else ''
    if c.attrib.get('t')=='s' and val: val=shared[int(val)]
    if c.attrib.get('t')=='inlineStr': val=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
    d[col]=val
   rows.append(d)
  for r in rows[1:]:
   if r.get('F'): out.append({'date_serial':r.get('A',''),'placa_ff':r.get('B',''),'base':r.get('C',''),'reserva':r.get('E',''),'placa2':r.get('F','')})
 return out
reserve_records=read_reserve(reserve_path)
reserve_by_date_plate={}
for rr in reserve_records: reserve_by_date_plate.setdefault((str(rr['date_serial']).strip(),plate_norm(rr['placa2'])),[]).append(rr)
with ZipFile(path) as z:
 xml=ET.fromstring(z.read('xl/worksheets/sheet1.xml')); rows=[]
 for row in xml.findall('.//m:sheetData/m:row',NS):
  d={}
  for c in row.findall('m:c',NS):
   ref=c.attrib.get('r',''); col=re.sub(r'\d','',ref); v=c.find('m:v',NS); val=v.text if v is not None else ''
   if c.attrib.get('t')=='inlineStr': val=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
   d[col]=val
  rows.append(d)
 headers=rows[0]; data=rows[1:]
 agg=defaultdict(lambda:{'base':'','total':0,'ff':0,'ambulance':0,'ff_ds_sum':0,'ff_ds_n':0,'all_ds_sum':0,'all_ds_n':0})
 ff_routes=[]
 for r in data:
  if not r.get('A'): continue
  date_serial=str(r.get('B','')).strip(); plate=plate_norm(r.get('C')); base=r.get('A','')
  reserve_hit=bool(reserve_by_date_plate.get((date_serial,plate)))
  if norm(r.get('F')) != 'RENTALS' and not reserve_hit: continue
  base=r.get('A'); a=agg[base];a['base']=base;a['total']+=1
  obs=norm(r.get('AH')); cluster=norm(r.get('K')); vehicle=norm(r.get('AI') or r.get('H'))
  amb=cluster=='ROTA'
  if amb:a['ambulance']+=1
  try: ds=float(str(r.get('AB','')).replace(',','.'))
  except: ds=None
  if ds is not None:a['all_ds_sum']+=ds;a['all_ds_n']+=1
  is_ff=True
  if is_ff and not amb:
   a['ff']+=1
   if ds is not None:a['ff_ds_sum']+=ds;a['ff_ds_n']+=1
   ff_routes.append({'base':base,'data_serial':r.get('B',''),'placa':r.get('C',''),'rota':r.get('J',''),'cluster':r.get('K',''),'veiculo':r.get('AI') or r.get('H'),'ds':ds if ds is not None else 0,'contrato':r.get('F',''),'source_type':'RESERVA FF' if reserve_hit and norm(r.get('F'))!='RENTALS' else 'RENTALS','observacao':r.get('AH','')})
 out=[]
 for a in agg.values():
  a['ff_share']=a['ff']/a['total'] if a['total'] else 0
  a['ff_ds']=a['ff_ds_sum']/a['ff_ds_n'] if a['ff_ds_n'] else 0
  a['all_ds']=a['all_ds_sum']/a['all_ds_n'] if a['all_ds_n'] else 0
  out.append(a)
 out.sort(key=lambda x:x['ff_share'],reverse=True)
 print(json.dumps({'bases':len(out),'rows':len(data),'ff_rows':sum(a['ff'] for a in out),'ambulance':sum(a['ambulance'] for a in out),'top':out[:10],'bottom':out[-10:]},ensure_ascii=False,indent=2))
 Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\ff_summary.json').write_text(json.dumps(out,ensure_ascii=False),encoding='utf-8')
 Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\ff_routes.json').write_text(json.dumps(ff_routes,ensure_ascii=False),encoding='utf-8')
 spot_agg=defaultdict(lambda:{'base':'','total':0,'ff':0,'ambulance':0,'ff_ds_sum':0,'ff_ds_n':0,'all_ds_sum':0,'all_ds_n':0})
 spot_routes=[]
 for r in data:
  if not r.get('A'): continue
  date_serial=str(r.get('B','')).strip(); plate=plate_norm(r.get('C')); reserve_hit=bool(reserve_by_date_plate.get((date_serial,plate)))
  cluster=norm(r.get('K'))
  if (norm(r.get('F')) == 'RENTALS' and not reserve_hit) or cluster == 'ROTA': continue
  base=r.get('A'); a=spot_agg[base]; a['base']=base; a['total']+=1; a['ff']+=1
  try: ds=float(str(r.get('AB','')).replace(',','.'))
  except: ds=None
  if ds is not None: a['ff_ds_sum']+=ds; a['ff_ds_n']+=1; a['all_ds_sum']+=ds; a['all_ds_n']+=1
  spot_routes.append({'base':base,'data_serial':r.get('B',''),'placa':r.get('C',''),'rota':r.get('J',''),'cluster':r.get('K',''),'veiculo':r.get('AI') or r.get('H'),'ds':ds if ds is not None else 0,'contrato':r.get('F',''),'source_type':'SPOT','observacao':r.get('AH','')})
 spot_out=[]
 for a in spot_agg.values():
  a['ff_share']=1 if a['total'] else 0; a['ff_ds']=a['ff_ds_sum']/a['ff_ds_n'] if a['ff_ds_n'] else 0; a['all_ds']=a['all_ds_sum']/a['all_ds_n'] if a['all_ds_n'] else 0; spot_out.append(a)
 spot_out.sort(key=lambda x:x['ff_ds'],reverse=True)
 Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\spot_summary.json').write_text(json.dumps(spot_out,ensure_ascii=False),encoding='utf-8')
 Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\spot_routes.json').write_text(json.dumps(spot_routes,ensure_ascii=False),encoding='utf-8')
 Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\reserve_lookup.json').write_text(json.dumps(reserve_records,ensure_ascii=False),encoding='utf-8')

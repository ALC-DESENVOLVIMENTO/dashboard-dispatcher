from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
from collections import Counter
import re, unicodedata
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
path=Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\Rotas 1 a 31 Julho DDS preenchida.xlsx')
def norm(s): return ''.join(c for c in unicodedata.normalize('NFD',str(s or '').upper()) if unicodedata.category(c)!='Mn')
with ZipFile(path) as z:
 xml=ET.fromstring(z.read('xl/worksheets/sheet1.xml')); shared=[]
 rows=[]
 for row in xml.findall('.//m:sheetData/m:row',NS):
  d={}
  for c in row.findall('m:c',NS):
   ref=c.attrib.get('r',''); col=re.sub(r'\d','',ref); v=c.find('m:v',NS); val=v.text if v is not None else ''
   if c.attrib.get('t')=='inlineStr': val=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
   d[col]=val
  rows.append(d)
 data=rows[1:]
 clusters=Counter(norm(r.get('K')) for r in data)
 rota=[r for r in data if norm(r.get('K'))=='ROTA']
 print('Clusters mais frequentes:',clusters.most_common(30))
 print('Cluster=ROTA:',len(rota))
 print('ROTA por base:',Counter(r.get('A') for r in rota).most_common())
 print('ROTA FF vehicle:',sum('FROTA FIXA' in norm(r.get('AI') or r.get('H')) for r in rota))

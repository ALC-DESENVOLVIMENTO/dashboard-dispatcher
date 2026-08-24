from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
from collections import Counter, defaultdict
import re
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
path=Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\Rotas 1 a 31 Julho DDS preenchida.xlsx')
with ZipFile(path) as z:
 shared=[]
 if 'xl/sharedStrings.xml' in z.namelist():
  root=ET.fromstring(z.read('xl/sharedStrings.xml'))
  for si in root.findall('m:si',NS): shared.append(''.join(t.text or '' for t in si.iter('{%s}t'%NS['m'])))
 xml=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
 rows=[]
 for row in xml.findall('.//m:sheetData/m:row',NS):
  d={}
  for c in row.findall('m:c',NS):
   ref=c.attrib.get('r',''); col=re.sub(r'\d','',ref); v=c.find('m:v',NS); val=v.text if v is not None else ''
   if c.attrib.get('t')=='s' and val!='': val=shared[int(val)]
   if c.attrib.get('t')=='inlineStr': val=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
   d[col]=val
  rows.append(d)
 headers=rows[0]; data=rows[1:]
 print('rows',len(data),'headers',headers)
 for col in ['A','F','H','AI','AF','AH','AE']:
  c=Counter(r.get(col,'') for r in data)
  print('\nCOL',headers.get(col), 'unique',len(c))
  print(c.most_common(30))
 for token in ['AMBUL','RESERV','FIXA','SPOT']:
  hits=[r for r in data if token in ' '.join(str(v or '') for v in r.values()).upper()]
  print('\nTOKEN',token,'hits',len(hits))
  for r in hits[:10]: print({headers.get(k,k):r.get(k,'') for k in ['A','B','C','F','H','AI','AF','AH','J','AB']})

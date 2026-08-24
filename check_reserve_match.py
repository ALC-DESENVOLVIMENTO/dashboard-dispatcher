from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import re
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def get_rows(path):
    with ZipFile(path) as z:
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            sroot=ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in sroot.findall('m:si',NS): shared.append(''.join(t.text or '' for t in si.iter('{%s}t'%NS['m'])))
        xml=ET.fromstring(z.read('xl/worksheets/sheet1.xml')); rows=[]
        for row in xml.findall('.//m:sheetData/m:row',NS):
            d={}
            for c in row.findall('m:c',NS):
                ref=c.attrib.get('r',''); col=re.sub(r'\d','',ref); v=c.find('m:v',NS); d[col]=v.text if v is not None else ''
                if c.attrib.get('t')=='s' and d[col]: d[col]=shared[int(d[col])]
                if c.attrib.get('t')=='inlineStr': d[col]=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
            rows.append(d)
        return rows[1:]
src=get_rows(Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\Rotas 1 a 31 Julho DDS preenchida.xlsx'))
res=get_rows(Path(r'C:\Users\Wesley\Downloads\Pasta1.xlsx'))
plates={r.get('F') for r in res if r.get('F')}; source={r.get('C') for r in src if r.get('C')}
print('reserve plates',len(plates),'source plates',len(source),'intersection',len(plates&source),sorted(list(plates&source))[:30])
print('reserve sample',sorted(list(plates))[:20])
print('source sample',sorted(list(source))[:20])
for p in sorted(list(plates&source))[:5]:
    print('P',p,'res',[(r.get('A'),r.get('C'),r.get('F')) for r in res if r.get('F')==p][:3],'src',[(r.get('B'),r.get('A'),r.get('C'),r.get('F')) for r in src if r.get('C')==p][:3])
all_source_values={v for r in src for v in r.values()}
print('any-cell intersection',len(plates & all_source_values),sorted(list(plates & all_source_values))[:20])

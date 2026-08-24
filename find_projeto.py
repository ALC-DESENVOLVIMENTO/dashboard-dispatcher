from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import re
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
p=Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\Rotas 1 a 31 Julho DDS preenchida.xlsx')
with ZipFile(p) as z:
    wb=ET.fromstring(z.read('xl/workbook.xml')); rel=ET.fromstring(z.read('xl/_rels/workbook.xml.rels')); relmap={x.attrib['Id']:x.attrib['Target'].lstrip('/') for x in rel}
    for s in wb.find('m:sheets',NS):
        target=relmap[s.attrib['{%s}id'%NS['r']]]
        xml=ET.fromstring(z.read(target))
        vals=[]
        for row in xml.findall('.//m:sheetData/m:row',NS):
            for c in row.findall('m:c',NS):
                v=c.find('m:v',NS); txt=v.text if v is not None else ''
                if c.attrib.get('t')=='inlineStr': txt=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
                if 'PROJ' in str(txt).upper(): vals.append((c.attrib.get('r'),txt))
        if vals: print(s.attrib['name'], vals[:20])

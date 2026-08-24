from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import re, json

NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships','p':'http://schemas.openxmlformats.org/package/2006/relationships'}
path=Path(r'C:\Users\Wesley\Documents\Dev Alc\Projetos\bonificacao-dispatcher\outputs\thread-01\Rotas 1 a 31 Julho DDS preenchida.xlsx')
with ZipFile(path) as z:
    shared=[]
    if 'xl/sharedStrings.xml' in z.namelist():
        root=ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si',NS): shared.append(''.join(t.text or '' for t in si.iter('{%s}t'%NS['m'])))
    wb=ET.fromstring(z.read('xl/workbook.xml'))
    rel=ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    relmap={x.attrib['Id']:x.attrib['Target'] for x in rel}
    sheets=[]
    for s in wb.find('m:sheets',NS):
        target=relmap[s.attrib['{%s}id'%NS['r']]].lstrip('/')
        if not target.startswith('xl/'): target='xl/'+target
        sheets.append((s.attrib['name'],target))
    print('SHEETS',len(sheets),[x[0] for x in sheets])
    for name,target in sheets[:4]:
        xml=ET.fromstring(z.read(target))
        dim=xml.find('m:dimension',NS)
        print('\n---',name,'dimension',dim.attrib.get('ref') if dim is not None else None,'---')
        rows=[]
        for row in xml.findall('.//m:sheetData/m:row',NS)[:12]:
            vals=[]
            for c in row.findall('m:c',NS):
                ref=c.attrib.get('r',''); col=re.sub(r'\d','',ref); v=c.find('m:v',NS); val=v.text if v is not None else ''
                if c.attrib.get('t')=='s' and val!='': val=shared[int(val)]
                elif c.attrib.get('t')=='inlineStr': val=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
                vals.append(f'{col}={val}')
            rows.append(' | '.join(vals))
        print('\n'.join(rows))

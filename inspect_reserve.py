from zipfile import ZipFile
from xml.etree import ElementTree as ET
import re
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
p=r'C:\Users\Wesley\Downloads\Pasta1.xlsx'
with ZipFile(p) as z:
    shared=[]
    if 'xl/sharedStrings.xml' in z.namelist():
        root=ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si',NS): shared.append(''.join(t.text or '' for t in si.iter('{%s}t'%NS['m'])))
    xml=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    for row in xml.findall('.//m:sheetData/m:row',NS)[:20]:
        values=[]
        for c in row.findall('m:c',NS):
            ref=c.attrib.get('r',''); col=re.sub(r'\d','',ref); v=c.find('m:v',NS); value=v.text if v is not None else ''
            if c.attrib.get('t')=='s' and value: value=shared[int(value)]
            if c.attrib.get('t')=='inlineStr': value=''.join(t.text or '' for t in c.iter('{%s}t'%NS['m']))
            values.append(f'{col}={value}')
        print(' | '.join(values))

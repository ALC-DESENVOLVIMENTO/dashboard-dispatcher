import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const files = [
  'C:/Users/Wesley/Downloads/Rotas 1 a 31 Julho DDS.xlsx',
  'C:/Users/Wesley/Downloads/Rotas 1 a 31 Julho.xlsx',
];

for (const file of files) {
  const wb = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
  console.log(`FILE ${file}`);
  console.log((await wb.inspect({ kind: 'workbook,sheet,table', maxChars: 12000, tableMaxRows: 8, tableMaxCols: 40, tableMaxCellChars: 100 })).ndjson);
  for (const ws of wb.worksheets.items) {
    const used = ws.getUsedRange();
    console.log(`SHEET ${ws.name} USED ${used?.address ?? 'none'}`);
    if (used) {
      console.log((await wb.inspect({ kind: 'table', sheetId: ws.name, range: used.address, include: 'values,formulas', tableMaxRows: 10, tableMaxCols: 35, tableMaxCellChars: 80, maxChars: 18000 })).ndjson);
      const preview = await wb.render({ sheetName: ws.name, autoCrop: 'all', scale: 0.5, format: 'png' });
      const out = `outputs/thread-01/${file.split('/').pop().replace(/\.xlsx$/,'')}-${ws.name.replace(/[^A-Za-z0-9_-]/g,'_')}.png`;
      const fs = await import('node:fs/promises');
      await fs.writeFile(out, new Uint8Array(await preview.arrayBuffer()));
      console.log(`RENDER ${out}`);
    }
  }
}

import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const inputPath = 'C:/Users/Wesley/Documents/Dev Alc/Projetos/bonificacao-dispatcher/outputs/thread-01/Rotas 1 a 31 Julho DDS preenchida.xlsx';
const outDir = 'C:/Users/Wesley/Documents/Dev Alc/Projetos/bonificacao-dispatcher/outputs/thread-01/inspection';
await fs.mkdir(outDir, {recursive:true});
const input = await FileBlob.load(inputPath);
const wb = await SpreadsheetFile.importXlsx(input);
const summary = await wb.inspect({kind:'workbook,sheet,table', maxChars:12000, tableMaxRows:8, tableMaxCols:18, tableMaxCellChars:120});
console.log(summary.ndjson);
for (const sheet of wb.worksheets.items) {
  console.log(`---SHEET:${sheet.name}---`);
  const used = sheet.getUsedRange();
  console.log('USED', used?.address ?? 'none');
  if (used) {
    const region = await wb.inspect({kind:'region', sheetId:sheet.name, range:used.address, maxChars:12000});
    console.log(region.ndjson);
    const preview = await wb.render({sheetName:sheet.name, autoCrop:'all', scale:1, format:'png'});
    await fs.writeFile(`${outDir}/${sheet.name.replace(/[^a-z0-9]/gi,'_')}.png`, new Uint8Array(await preview.arrayBuffer()));
  }
}

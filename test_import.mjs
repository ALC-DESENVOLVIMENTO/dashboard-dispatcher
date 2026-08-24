import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';
console.log('START');
const input = await FileBlob.load('C:/Users/Wesley/Downloads/Rotas 1 a 31 Julho DDS.xlsx');
console.log('LOADED');
const wb = await SpreadsheetFile.importXlsx(input);
console.log('IMPORTED', wb.worksheets.items.length);

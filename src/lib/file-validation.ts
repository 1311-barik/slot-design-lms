import { unzipSync, strFromU8 } from 'fflate';
import { AppError } from './contract';
import sharp from 'sharp';

export async function inspectContent(name: string, bytes: Buffer) {
  const meta = inspectFile(name, bytes);
  if (meta.mime.startsWith('image/')) {
    try {
      // Проверяем декодирование, а не только сигнатуру. Исходный файл не изменяется.
      await sharp(bytes, { failOn: 'warning' }).resize(1,1).raw().timeout({ seconds: 5 }).toBuffer();
    } catch { throw new AppError('file_format', 'This image cannot be read. Export it again as PNG, JPEG or WebP.'); }
  }
  return meta;
}
export function inspectFile(name: string, bytes: Buffer) {
  if (!bytes.length) throw new AppError('empty_file', 'An empty file cannot be uploaded.');
  if (bytes.length > 50_000_000) throw new AppError('file_size', 'Each file must be 50 MB or smaller.', 413);
  if (name.length > 240 || /[\x00-\x1f/\\]/.test(name)) throw new AppError('file_name', 'Use a shorter filename without path separators.');
  const ext = name.split('.').pop()?.toLowerCase();
  const invalid = () => new AppError('file_format', 'The file format does not match its extension.');
  let mime: string;
  switch (ext) {
    case 'txt': case 'md': case 'csv': {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AppError('file_encoding', 'Text files must use UTF-8.'); }
      if (bytes.includes(0)) throw invalid();
      mime = ext === 'csv' ? 'text/csv' : 'text/plain'; break;
    }
    case 'vtt': {
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AppError('file_encoding', 'Subtitle files must use UTF-8.'); }
      if (bytes.includes(0) || !/^\uFEFF?WEBVTT(?:\r?\n|[ \t])/.test(content)) throw invalid();
      mime = 'text/vtt'; break;
    }
    case 'pdf': if (!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) throw invalid(); mime = 'application/pdf'; break;
    case 'mp4': {
      // ISO BMFF: проверяем контейнер, границы атомов и наличие данных с метаданными.
      if (bytes.length < 16 || bytes.subarray(4,8).toString() !== 'ftyp') throw invalid();
      const brand = bytes.subarray(8,12).toString('ascii');
      if (!['isom','iso2','mp41','mp42','avc1','M4V '].includes(brand)) throw invalid();
      let offset = 0; const found = new Set<string>();
      while (offset + 8 <= bytes.length) {
        let size = bytes.readUInt32BE(offset);
        const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
        let header = 8;
        if (size === 1) { if (offset + 16 > bytes.length) throw invalid(); size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
        if (size === 0) size = bytes.length - offset;
        if (offset === 0 && size < 16) throw invalid();
        if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length) throw invalid();
        found.add(type); offset += size;
      }
      if (offset !== bytes.length || !found.has('moov') || !found.has('mdat')) throw invalid();
      mime = 'video/mp4'; break;
    }
    case 'png': if (bytes.length < 24 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12,16).toString() !== 'IHDR') throw invalid(); mime = 'image/png'; break;
    case 'jpg': case 'jpeg': if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw invalid(); mime = 'image/jpeg'; break;
    case 'webp': if (bytes.length < 16 || bytes.subarray(0,4).toString() !== 'RIFF' || bytes.subarray(8,12).toString() !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid(); mime = 'image/webp'; break;
    case 'docx': case 'pptx': case 'xlsx': {
      let names: string[] = []; let total = 0; let content = '';
      try {
        const entries = unzipSync(bytes, { filter: file => {
          names.push(file.name); total += file.originalSize;
          if (names.length > 5000 || total > 250_000_000 || file.originalSize > 100_000_000) throw new Error('archive too large');
          return file.name === '[Content_Types].xml' && file.originalSize <= 100_000;
        } });
        if (entries['[Content_Types].xml']) content = strFromU8(entries['[Content_Types].xml']);
      } catch { throw invalid(); }
      if (names.some(n => /vbaproject|macros/i.test(n)) || /macroEnabled/i.test(content)) throw new AppError('macros', 'Office files with macros are not accepted.');
      const root = ext === 'docx' ? 'word/document.xml' : ext === 'pptx' ? 'ppt/presentation.xml' : 'xl/workbook.xml';
      if (!content || !names.includes(root)) throw invalid();
      mime = `application/vnd.openxmlformats-officedocument.${ext === 'docx' ? 'wordprocessingml.document' : ext === 'pptx' ? 'presentationml.presentation' : 'spreadsheetml.sheet'}`;
      break;
    }
    default: throw new AppError('unsupported_file', 'Use PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, PNG, JPEG, WebP, MP4 or VTT.');
  }
  return { mime, size: bytes.length };
}

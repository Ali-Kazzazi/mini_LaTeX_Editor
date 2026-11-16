// Keep the viewer and its worker on PDF.js's compatibility builds so that
// browsers without recent built-ins (such as Uint8Array.toHex) can open PDFs.
export { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';

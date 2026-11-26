(function () {
  'use strict';
  // The Excel reader (SheetJS) is large, so it loads only when an Excel file is dropped in.
  const XLSX_URL = 'vendor/xlsx.full.min.js';
  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading) {
      xlsxLoading = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = XLSX_URL;
        el.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('the Excel reader did not load')));
        el.onerror = () => { xlsxLoading = null; reject(new Error('could not load the Excel reader. Check the connection, or export the report as CSV instead')); };
        document.head.appendChild(el);
      });
    }
    return xlsxLoading;
  }

  // First sheet of a workbook as CSV text, using the cells' displayed values (dates stay dates).
  async function excelToCsv(buffer) {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error('has no sheets.');
    return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  }

  async function readStatement(file) {
    if (!file) return '';
    if (file.size > 8 * 1024 * 1024) throw new Error('Export a smaller report (up to 8 MB).');
    if (/\.xlsx?$/i.test(file.name)) return excelToCsv(await file.arrayBuffer());
    if (/\.csv$/i.test(file.name)) return file.text();
    throw new Error('Choose a CSV or Excel report.');
  }

  window.LedgerFiles = { excelToCsv, readStatement };
})();

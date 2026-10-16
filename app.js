(() => {
  const DATABASE_NAME = 'school-monitor-mooe';
  const DATABASE_VERSION = 1;
  const RECORDS_STORE = 'records';
  const SETTINGS_STORE = 'settings';
  const PHOTO_DIRECTORY_SETTING = 'photoDirectory';
  const fields = ['schoolId', 'schoolName', 'district', 'schoolType', 'contactPerson', 'status', 'jevNumber', 'remarks'];
  const validStatuses = ['Checked', 'Pending', 'Not Started'];
  const initialRecords = window.schoolMonitoringData.records.map((row, index) => Object.fromEntries(fields.map((field, position) => [field, row[position] || '']).concat([['_key', `initial-${index}`]])));
  let records = [];
  let database;
  let photoDirectory;
  let activeKey = null;
  let draftKey = null;
  let pendingPhoto = '';
  let photoReadPending = false;
  let photoReadToken = 0;
  let previewObjectUrl = '';
  let viewerObjectUrl = '';
  let toastTimer;

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function createRecordKey() {
    return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function isValidPhoto(photo) {
    return /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo) || /^file:[^/\\]+$/.test(photo);
  }

  function normaliseRecord(record) {
    if (!record || typeof record !== 'object') throw new Error('A school record must be a valid object.');
    if (!validStatuses.includes(record.status)) throw new Error('A school record has an invalid status.');
    const photo = record.photo ?? '';
    if (typeof photo !== 'string' || (photo && !isValidPhoto(photo))) throw new Error('A school photo in this record is not a supported image format.');
    return Object.fromEntries(fields.map((field) => [field, String(record[field] ?? '')]).concat([['_key', String(record._key || createRecordKey())], ['photo', photo]]));
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let inQuotes = false;
    let quoteClosed = false;
    const finishRow = () => {
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = '';
      quoteClosed = false;
    };

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (inQuotes) {
        if (character === '"' && text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else if (character === '"') {
          inQuotes = false;
          quoteClosed = true;
        } else {
          value += character;
        }
      } else if (character === ',' || character === '\n' || character === '\r') {
        if (character === ',') {
          row.push(value);
          value = '';
          quoteClosed = false;
        } else {
          if (character === '\r' && text[index + 1] === '\n') index += 1;
          finishRow();
        }
      } else if (character === '"') {
        if (value || quoteClosed) throw new Error('CSV contains a quote in an invalid position.');
        inQuotes = true;
      } else if (quoteClosed) {
        if (character !== ' ' && character !== '\t') throw new Error('CSV contains unexpected text after a quoted value.');
      } else {
        value += character;
      }
    }
    if (inQuotes) throw new Error('CSV has an unclosed quoted value.');
    if (value || row.length || quoteClosed) finishRow();
    return rows;
  }

  function parseCsvRecords(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('CSV file is empty.');
    const headerNames = rows[0].map((header) => header.replace(/^\uFEFF/, '').trim().toLocaleLowerCase().replace(/\s+/g, ' '));
    const columnAliases = {
      schoolId: ['school id', 'schoolid'],
      schoolName: ['school name', 'schoolname'],
      district: ['district'],
      schoolType: ['school type', 'schooltype', 'type'],
      contactPerson: ['contact person', 'contactperson'],
      status: ['status'],
      jevNumber: ['jev number', 'jevnumber'],
      remarks: ['remarks/notes', 'remarks', 'notes']
    };
    const columns = Object.fromEntries(Object.entries(columnAliases).map(([field, aliases]) => {
      const matching = headerNames.findIndex((header) => aliases.includes(header));
      return [field, matching];
    }));
    const required = ['schoolId', 'schoolName', 'district', 'schoolType', 'status'];
    const missing = required.filter((field) => columns[field] < 0);
    if (missing.length) throw new Error(`CSV is missing required columns: ${missing.map((field) => columnAliases[field][0]).join(', ')}.`);

    const imported = [];
    rows.slice(1).forEach((cells, index) => {
      const record = Object.fromEntries(fields.map((field) => [field, columns[field] < 0 ? '' : String(cells[columns[field]] ?? '').trim()]));
      const missingValues = required.filter((field) => !record[field]);
      if (missingValues.length) throw new Error(`CSV row ${index + 2} is missing: ${missingValues.map((field) => columnAliases[field][0]).join(', ')}.`);
      const status = validStatuses.find((item) => item.toLocaleLowerCase() === record.status.toLocaleLowerCase());
      if (!status) throw new Error(`CSV row ${index + 2} has an invalid status. Use Checked, Pending, or Not Started.`);
      record.status = status;
      record._key = createRecordKey();
      record.photo = '';
      imported.push(record);
    });
    if (!imported.length) throw new Error('CSV has a header but no school records.');
    return imported;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener('upgradeneeded', () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS_STORE)) db.createObjectStore(RECORDS_STORE, { keyPath: '_key' });
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      });
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error || new Error('Could not open browser storage.')), { once: true });
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener('complete', resolve, { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error || new Error('Browser storage transaction failed.')), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error || new Error('Browser storage transaction failed.')), { once: true });
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error || new Error('Browser storage request failed.')), { once: true });
    });
  }

  async function readSetting(key) {
    const transaction = database.transaction(SETTINGS_STORE, 'readonly');
    const result = await requestResult(transaction.objectStore(SETTINGS_STORE).get(key));
    await transactionDone(transaction);
    return result?.value;
  }

  async function writeSetting(key, value) {
    const transaction = database.transaction(SETTINGS_STORE, 'readwrite');
    transaction.objectStore(SETTINGS_STORE).put({ key, value });
    await transactionDone(transaction);
  }

  async function saveRecords(nextRecords = records) {
    try {
      const transaction = database.transaction([RECORDS_STORE, SETTINGS_STORE], 'readwrite');
      const store = transaction.objectStore(RECORDS_STORE);
      store.clear();
      nextRecords.forEach((record) => store.put(record));
      transaction.objectStore(SETTINGS_STORE).put({ key: 'recordsInitialized', value: true });
      await transactionDone(transaction);
      records = nextRecords;
      render();
      return true;
    } catch (error) {
      showToast('Changes could not be saved in this browser. Export a JSON backup to preserve them.');
      console.error(error);
      return false;
    }
  }

  async function initialize() {
    database = await openDatabase();
    const transaction = database.transaction(RECORDS_STORE, 'readonly');
    const storedRecords = await requestResult(transaction.objectStore(RECORDS_STORE).getAll());
    await transactionDone(transaction);
    const recordsInitialized = await readSetting('recordsInitialized');
    if (recordsInitialized || storedRecords.length) {
      records = storedRecords.map(normaliseRecord);
    } else {
      let startingRecords = initialRecords.map(normaliseRecord);
      try {
        const legacyRecords = JSON.parse(localStorage.getItem('school-monitor-mooe-records-v3'));
        if (Array.isArray(legacyRecords) && legacyRecords.every((record) => record && fields.every((field) => field in record))) {
          startingRecords = legacyRecords.map(normaliseRecord);
        }
      } catch (error) {
        console.warn('Previous browser records could not be migrated; starting with the original workbook records.', error);
      }
      const writeTransaction = database.transaction([RECORDS_STORE, SETTINGS_STORE], 'readwrite');
      startingRecords.forEach((record) => writeTransaction.objectStore(RECORDS_STORE).put(record));
      writeTransaction.objectStore(SETTINGS_STORE).put({ key: 'recordsInitialized', value: true });
      await transactionDone(writeTransaction);
      records = startingRecords;
      try {
        localStorage.removeItem('school-monitor-mooe-records-v3');
      } catch (error) {
        console.warn('Previous browser records were migrated, but the old copy could not be removed.', error);
      }
    }
    photoDirectory = await readSetting(PHOTO_DIRECTORY_SETTING);
    updatePhotoFolderStatus();
    render();
  }

  function updatePhotoFolderStatus() {
    const button = document.querySelector('[data-action="choose-photo-folder"]');
    if (button) button.textContent = photoDirectory ? 'Change photo folder' : 'Choose photo folder';
    document.querySelector('.local-indicator').innerHTML = '<i></i>Saved in this browser';
  }

  async function ensurePhotoDirectoryPermission() {
    if (!photoDirectory) throw new Error('Choose a photo folder on your computer before adding a photo.');
    let permission = await photoDirectory.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') permission = await photoDirectory.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('Permission to write to the selected photo folder was not granted. Choose the folder again to restore access.');
    return photoDirectory;
  }

  async function resolvePhoto(photo) {
    if (!photo) return '';
    if (photo.startsWith('data:')) return photo;
    const directory = await ensurePhotoDirectoryPermission();
    const file = await (await directory.getFileHandle(photo.slice(5))).getFile();
    return URL.createObjectURL(file);
  }

  async function savePhotoFile(file) {
    const directory = await ensurePhotoDirectoryPermission();
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type];
    const safeId = String(byId('school-form').elements.schoolId.value || 'school').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const filename = `school-${safeId}-${draftKey}-${createRecordKey()}.${extension}`;
    const fileHandle = await directory.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
    return `file:${filename}`;
  }

  async function removePhotoFile(photo) {
    if (!photo || !photo.startsWith('file:')) return;
    const directory = await ensurePhotoDirectoryPermission();
    await directory.removeEntry(photo.slice(5));
  }

  function getCounts() {
    const counts = { total: records.length, Checked: 0, Pending: 0, 'Not Started': 0 };
    records.forEach((record) => { counts[record.status] = (counts[record.status] || 0) + 1; });
    return counts;
  }

  function currentFilters() {
    const query = byId('search-input').value.trim().toLocaleLowerCase();
    const status = byId('status-filter').value;
    const district = byId('district-filter').value;
    const schoolType = byId('type-filter').value;
    return records.filter((record) => {
      const matchesQuery = !query || fields.some((field) => record[field].toLocaleLowerCase().includes(query));
      return matchesQuery && (!status || record.status === status) && (!district || record.district === district) && (!schoolType || record.schoolType === schoolType);
    }).sort((a, b) => a.schoolName.localeCompare(b.schoolName));
  }

  function renderOverview() {
    const counts = getCounts();
    byId('metric-total').textContent = counts.total;
    byId('metric-checked').textContent = counts.Checked || 0;
    byId('metric-pending').textContent = counts.Pending || 0;
    byId('metric-not-started').textContent = counts['Not Started'] || 0;
    byId('legend-checked').textContent = counts.Checked || 0;
    byId('legend-pending').textContent = counts.Pending || 0;
    byId('legend-not-started').textContent = counts['Not Started'] || 0;
    const percentage = counts.total ? Math.round((counts.Checked / counts.total) * 100) : 0;
    byId('completion-rate').textContent = `${percentage}%`;
    byId('progress-fill').style.width = `${percentage}%`;
    byId('district-list').innerHTML = window.schoolMonitoringData.districts.map((district) => {
      const count = records.filter((record) => record.district === district).length;
      const width = counts.total ? Math.round((count / counts.total) * 100) : 0;
      return `<div class="district-row"><span class="district-name" title="${escapeHtml(district)}">${escapeHtml(district)}</span><span class="district-track"><span class="district-fill" style="display:block;width:${width}%"></span></span><span class="district-count">${count}</span></div>`;
    }).join('');
    const attention = records.filter((record) => record.status !== 'Checked').sort((a, b) => (a.status === 'Pending' ? -1 : 1) - (b.status === 'Pending' ? -1 : 1)).slice(0, 6);
    byId('attention-list').innerHTML = attention.length ? attention.map((record) => `
      <div class="attention-item">
        <i class="attention-dot ${record.status === 'Pending' ? 'pending' : 'not-started'}"></i>
        <div class="attention-main"><strong>${escapeHtml(record.schoolName)}</strong><small>${escapeHtml(record.district)} · ${escapeHtml(record.status)}</small>${record.remarks ? `<span class="attention-remark">${escapeHtml(record.remarks)}</span>` : ''}</div>
        <button class="attention-review" type="button" data-edit="${escapeHtml(record._key)}">Review</button>
      </div>`).join('') : `<p class="no-attention">${records.length ? 'All school records have been checked.' : 'No school records are available.'}</p>`;
  }

  function renderFilterOptions() {
    const districtFilter = byId('district-filter');
    const typeFilter = byId('type-filter');
    const selectedDistrict = districtFilter.value;
    const selectedType = typeFilter.value;
    const districts = [...new Set([...window.schoolMonitoringData.districts, ...records.map((record) => record.district).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
    const types = [...new Set([...window.schoolMonitoringData.schoolTypes, ...records.map((record) => record.schoolType).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
    districtFilter.innerHTML = '<option value="">All districts</option>' + districts.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
    typeFilter.innerHTML = '<option value="">All types</option>' + types.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
    districtFilter.value = selectedDistrict;
    typeFilter.value = selectedType;
  }

  function renderTable() {
    const filtered = currentFilters();
    byId('result-count').textContent = `Showing ${filtered.length} of ${records.length} records`;
    byId('empty-state').hidden = filtered.length > 0;
    byId('school-table-body').innerHTML = filtered.map((record) => {
      const statusClass = record.status === 'Checked' ? 'checked' : record.status === 'Pending' ? 'pending' : 'not-started';
      return `<tr>
        <td class="id-cell">${escapeHtml(record.schoolId)}</td>
        <td class="school-name-cell"><button class="cell-ellipsis school-name-link" type="button" title="${escapeHtml(record.schoolName)}" data-edit="${escapeHtml(record._key)}">${escapeHtml(record.schoolName)}</button></td>
        <td>${escapeHtml(record.district)}</td>
        <td><span class="cell-ellipsis" title="${escapeHtml(record.schoolType)}">${escapeHtml(record.schoolType)}</span></td>
        <td class="contact-cell"><span class="cell-ellipsis" title="${escapeHtml(record.contactPerson)}">${escapeHtml(record.contactPerson)}</span></td>
        <td><span class="status-badge status-${statusClass}">${escapeHtml(record.status)}</span></td>
        <td class="jev-cell">${escapeHtml(record.jevNumber)}</td>
        <td class="remarks-cell"><span class="cell-ellipsis" title="${escapeHtml(record.remarks)}">${escapeHtml(record.remarks)}</span></td>
      </tr>`;
    }).join('');
  }

  function render() {
    renderOverview();
    renderFilterOptions();
    renderTable();
  }

  function populateSelect(select, options, selected, placeholder) {
    const values = [...new Set([...options, selected].filter(Boolean))];
    select.innerHTML = (placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : '') + values.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
    select.value = selected || '';
  }

  function openEditor(record) {
    const form = byId('school-form');
    photoReadToken += 1;
    photoReadPending = false;
    form.querySelector('[type="submit"]').disabled = false;
    activeKey = record?._key || null;
    draftKey = record?._key || createRecordKey();
    byId('dialog-title').textContent = record ? 'Edit school' : 'Add school';
    byId('dialog-kicker').textContent = record ? 'SCHOOL RECORD' : 'NEW RECORD';
    form.elements.schoolId.value = record?.schoolId || '';
    form.elements.schoolName.value = record?.schoolName || '';
    populateSelect(form.elements.district, [...window.schoolMonitoringData.districts, ...records.map((item) => item.district)], record?.district || '', 'Choose district');
    populateSelect(form.elements.schoolType, [...window.schoolMonitoringData.schoolTypes, ...records.map((item) => item.schoolType)], record?.schoolType || '', 'Choose school type');
    form.elements.contactPerson.value = record?.contactPerson || '';
    form.elements.status.value = record?.status || 'Not Started';
    form.elements.jevNumber.value = record?.jevNumber || '';
    form.elements.remarks.value = record?.remarks || '';
    pendingPhoto = record?.photo || '';
    byId('photo-input').value = '';
    updatePhotoPreview();
    document.querySelector('[data-action="delete"]').hidden = !record;
    byId('school-dialog').showModal();
    form.elements.schoolId.focus();
  }

  function updatePhotoPreview() {
    const previewButton = byId('photo-preview-button');
    const removeButton = byId('remove-photo-button');
    previewButton.hidden = !pendingPhoto;
    removeButton.hidden = !pendingPhoto;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = '';
    const image = byId('photo-preview');
    if (!pendingPhoto) {
      image.removeAttribute('src');
      return;
    }
    const photo = pendingPhoto;
    resolvePhoto(pendingPhoto).then((url) => {
      if (pendingPhoto === photo) {
        previewObjectUrl = url.startsWith('blob:') ? url : '';
        image.src = url;
      } else if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }).catch((error) => {
      showToast(error.message || 'Could not open the saved school photo.');
      console.error(error);
    });
  }

  async function openPhotoViewer(photo, schoolName) {
    if (!photo) return;
    try {
      const url = await resolvePhoto(photo);
      if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
      viewerObjectUrl = url.startsWith('blob:') ? url : '';
      byId('photo-dialog-title').textContent = schoolName;
      const image = byId('photo-viewer-image');
      image.src = url;
      image.alt = `Photo of ${schoolName}`;
      byId('photo-dialog').showModal();
    } catch (error) {
      showToast(error.message || 'Could not open the saved school photo.');
      console.error(error);
    }
  }

  function showToast(message) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportExcel() {
    const exportedRecords = currentFilters();
    const counts = { Checked: 0, Pending: 0, 'Not Started': 0 };
    exportedRecords.forEach((record) => { counts[record.status] += 1; });
    const headers = ['School ID', 'School Name', 'District', 'School Type', 'Contact Person', 'Status', 'JEV Number', 'Remarks / Notes'];
    const columns = ['90px', '210px', '130px', '120px', '170px', '100px', '120px', '250px'];
    const reportDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
    const cell = (value, style = '') => `<td style="${style}">${escapeHtml(value)}</td>`;
    const columnWidths = columns.map((width) => `<col width="${width}">`).join('');
    const headerRow = headers.map((label) => cell(label, 'background-color:#173c32;color:#ffffff;font-weight:bold;padding:10px 8px;border:1px solid #dce4db;')).join('');
    const dataRows = exportedRecords.map((record, index) => {
      const background = index % 2 ? '#f2f5ef' : '#ffffff';
      const values = fields.map((field) => {
        const baseStyle = `background-color:${background};color:#27342d;padding:8px;border:1px solid #e1e7df;mso-number-format:"\\@";vertical-align:top;`;
        if (field === 'status') {
          const statusColors = {
            Checked: ['#e6f1e9', '#286549'],
            Pending: ['#fbf0db', '#916116'],
            'Not Started': ['#f9e8e2', '#a34d3d']
          };
          const [statusBackground, statusColor] = statusColors[record.status];
          return cell(record.status, `${baseStyle}background-color:${statusBackground};color:${statusColor};font-weight:bold;`);
        }
        return cell(record[field], baseStyle);
      }).join('');
      return `<tr>${values}</tr>`;
    }).join('');
    const report = `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
  <meta charset="utf-8">
  <meta name="ProgId" content="Excel.Sheet">
  <meta name="Generator" content="School Monitoring">
  <style>
    body { font-family: Calibri, Arial, sans-serif; color: #27342d; }
    table { border-collapse: collapse; }
    .title { background: #173c32; color: #ffffff; font-size: 20pt; font-weight: bold; padding: 18px 14px 6px; }
    .subtitle { background: #173c32; color: #dce8dc; font-size: 10pt; padding: 0 14px 16px; }
    .summary-label { background: #eaf0e8; color: #526257; font-size: 9pt; font-weight: bold; padding: 9px 8px 3px; }
    .summary-value { background: #eaf0e8; color: #173c32; font-size: 16pt; font-weight: bold; padding: 2px 8px 10px; }
    .spacer { height: 12px; }
  </style>
</head>
<body>
  <table>
    <colgroup>${columnWidths}</colgroup>
    <tr><td class="title" colspan="8">SCHOOL MONITORING</td></tr>
    <tr><td class="subtitle" colspan="8">MOOE Disbursement Report &nbsp; | &nbsp; Generated ${escapeHtml(reportDate)} &nbsp; | &nbsp; ${exportedRecords.length} records</td></tr>
    <tr><td class="spacer" colspan="8"></td></tr>
    <tr>
      <td class="summary-label" colspan="2">TOTAL SCHOOLS</td>
      <td class="summary-label" colspan="2">CHECKED</td>
      <td class="summary-label" colspan="2">PENDING</td>
      <td class="summary-label" colspan="2">NOT STARTED</td>
    </tr>
    <tr>
      <td class="summary-value" colspan="2">${exportedRecords.length}</td>
      <td class="summary-value" colspan="2">${counts.Checked}</td>
      <td class="summary-value" colspan="2">${counts.Pending}</td>
      <td class="summary-value" colspan="2">${counts['Not Started']}</td>
    </tr>
    <tr><td class="spacer" colspan="8"></td></tr>
    <tr>${headerRow}</tr>
    ${dataRows}
  </table>
</body>
</html>`;
    download('school-mooe-disbursements.xls', '\ufeff' + report, 'application/vnd.ms-excel;charset=utf-8');
    showToast(`Excel report downloaded (${exportedRecords.length} records).`);
  }

  async function exportJson() {
    try {
      const backupRecords = await Promise.all(records.map(async (record) => {
        if (!record.photo || record.photo.startsWith('data:')) return record;
        const directory = await ensurePhotoDirectoryPermission();
        const file = await (await directory.getFileHandle(record.photo.slice(5))).getFile();
        const photo = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener('load', () => resolve(reader.result));
          reader.addEventListener('error', () => reject(new Error(`Could not read photo for ${record.schoolName}.`)));
          reader.readAsDataURL(file);
        });
        return { ...record, photo };
      }));
      const backup = { source: window.schoolMonitoringData.source, exportedAt: new Date().toISOString(), records: backupRecords };
      download('school-mooe-backup.json', JSON.stringify(backup, null, 2), 'application/json');
      showToast('JSON backup downloaded.');
    } catch (error) {
      showToast(error.message || 'Could not create the JSON backup.');
      console.error(error);
    }
  }

  function setView(view) {
    const showTracker = view === 'tracker';
    byId('overview-view').hidden = showTracker;
    byId('tracker-view').hidden = !showTracker;
    byId('breadcrumb-current').textContent = showTracker ? 'School tracker' : 'Overview';
    document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  }

  document.addEventListener('click', async (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) setView(viewButton.dataset.view);
    const editButton = event.target.closest('[data-edit]');
    if (editButton) openEditor(records.find((record) => record._key === editButton.dataset.edit));
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    switch (actionButton.dataset.action) {
      case 'add': openEditor(null); break;
      case 'export-excel': exportExcel(); break;
      case 'export-json': await exportJson(); break;
      case 'import': byId('backup-input').click(); break;
      case 'choose-photo-folder':
        if (!window.showDirectoryPicker) {
          showToast('Saving photos directly to a folder requires a recent version of Chrome or Edge.');
          break;
        }
        try {
          const selectedDirectory = await window.showDirectoryPicker({ mode: 'readwrite' });
          await writeSetting(PHOTO_DIRECTORY_SETTING, selectedDirectory);
          photoDirectory = selectedDirectory;
          updatePhotoFolderStatus();
          showToast('Photo folder selected. New photos will be saved there.');
        } catch (error) {
          if (error.name !== 'AbortError') {
            showToast(error.message || 'Could not select a photo folder.');
            console.error(error);
          }
        }
        break;
      case 'close-dialog':
        byId('school-dialog').close();
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = '';
        break;
      case 'close-photo-viewer':
        byId('photo-dialog').close();
        if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
        viewerObjectUrl = '';
        break;
      case 'view-form-photo': {
        const schoolName = byId('school-form').elements.schoolName.value.trim() || 'School photo';
        await openPhotoViewer(pendingPhoto, schoolName);
        break;
      }
      case 'remove-photo':
        photoReadToken += 1;
        photoReadPending = false;
        byId('school-form').querySelector('[type="submit"]').disabled = false;
        pendingPhoto = '';
        byId('photo-input').value = '';
        updatePhotoPreview();
        break;
      case 'clear-filters':
        byId('search-input').value = '';
        byId('status-filter').value = '';
        byId('district-filter').value = '';
        byId('type-filter').value = '';
        renderTable();
        break;
      case 'reset':
        if (window.confirm(`Restore the ${initialRecords.length} original records? This will remove local edits and additions.`)) {
          if (await saveRecords(initialRecords.map(normaliseRecord))) showToast('Original workbook records restored.');
        }
        break;
      case 'delete': {
        const record = records.find((item) => item._key === activeKey);
        if (record && window.confirm(`Delete ${record.schoolName} from this browser?`)) {
          if (await saveRecords(records.filter((item) => item._key !== activeKey))) {
            let photoRemovalError;
            if (record.photo?.startsWith('file:') && !records.some((item) => item.photo === record.photo)) {
              try {
                await removePhotoFile(record.photo);
              } catch (error) {
                photoRemovalError = error;
                console.error(error);
              }
            }
            byId('school-dialog').close();
            showToast(photoRemovalError ? `Record deleted, but its photo could not be removed: ${photoRemovalError.message}` : 'Record deleted.');
          }
        }
        break;
      }
    }
  });

  byId('school-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (photoReadPending) return;
    const form = event.currentTarget;
    const record = Object.fromEntries(fields.map((field) => [field, String(form.elements[field].value).trim()]));
    record._key = activeKey || draftKey;
    record.photo = pendingPhoto;
    const previousPhoto = activeKey ? records.find((item) => item._key === activeKey)?.photo : '';
    const nextRecords = activeKey
      ? records.map((item) => item._key === activeKey ? record : item)
      : [record, ...records];
    if (await saveRecords(nextRecords)) {
      let photoRemovalError;
      if (previousPhoto?.startsWith('file:') && previousPhoto !== pendingPhoto && !nextRecords.some((item) => item.photo === previousPhoto)) {
        try {
          await removePhotoFile(previousPhoto);
        } catch (error) {
          photoRemovalError = error;
          console.error(error);
        }
      }
      byId('school-dialog').close();
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = '';
      showToast(photoRemovalError
        ? `Record saved, but its previous photo could not be removed: ${photoRemovalError.message}`
        : activeKey ? 'School record updated.' : 'School added to the tracker.');
    }
  });

  byId('photo-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const token = ++photoReadToken;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      photoReadPending = false;
      byId('school-form').querySelector('[type="submit"]').disabled = false;
      showToast('Choose a JPG, PNG, WebP, or GIF image.');
      event.target.value = '';
      return;
    }
    if (file.size > 1024 * 1024) {
      photoReadPending = false;
      byId('school-form').querySelector('[type="submit"]').disabled = false;
      showToast('Photo must be 1 MB or smaller.');
      event.target.value = '';
      return;
    }
    photoReadPending = true;
    byId('school-form').querySelector('[type="submit"]').disabled = true;
    try {
      if (token !== photoReadToken) return;
      const photo = await savePhotoFile(file);
      if (token !== photoReadToken) return;
      pendingPhoto = photo;
      updatePhotoPreview();
    } catch (error) {
      if (token === photoReadToken) {
        showToast(error.message || 'Could not read this photo.');
        console.error(error);
        event.target.value = '';
      }
    } finally {
      if (token === photoReadToken) {
        photoReadPending = false;
        byId('school-form').querySelector('[type="submit"]').disabled = false;
      }
    }
  });

  byId('backup-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const contents = await file.text();
      if (file.name.toLocaleLowerCase().endsWith('.csv')) {
        const imported = parseCsvRecords(contents);
        if (!window.confirm(`Add ${imported.length} schools from this CSV to the ${records.length} existing records?`)) return;
        if (await saveRecords([...records, ...imported])) showToast(`${imported.length} schools added from CSV.`);
      } else {
        const parsed = JSON.parse(contents);
        const imported = Array.isArray(parsed) ? parsed : parsed?.records;
        if (!Array.isArray(imported) || imported.some((record) => !record || typeof record !== 'object' || fields.some((field) => typeof record[field] !== 'string') || !validStatuses.includes(record.status) || !record.schoolId.trim() || !record.schoolName.trim() || (record.photo !== undefined && typeof record.photo !== 'string'))) throw new Error('Backup format is invalid. Confirm that records include required fields and a valid status.');
        if (!window.confirm(`Replace the current tracker with ${imported.length} records from this backup?`)) return;
        if (await saveRecords(imported.map(normaliseRecord))) showToast(`${imported.length} records imported.`);
      }
    } catch (error) {
      showToast(error.message || 'Could not read this backup file.');
      console.error(error);
    } finally {
      event.target.value = '';
    }
  });

  ['search-input', 'status-filter', 'district-filter', 'type-filter'].forEach((id) => byId(id).addEventListener(id === 'search-input' ? 'input' : 'change', renderTable));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      setView('tracker');
      byId('search-input').focus();
    }
    if (event.key === 'Escape' && byId('school-dialog').open) byId('school-dialog').close();
  });

  initialize().catch((error) => {
    showToast('Could not load saved records from this browser. Check browser storage settings and reload.');
    console.error(error);
  });
})();

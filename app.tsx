const {
  useState,
  useRef,
  useEffect,
  useMemo,
  Component
} = React;

// Register Chart.js ONCE at top level (UMD build auto-registers, but be safe)
try {
  if (typeof Chart !== 'undefined' && Chart.registerables) {
    Chart.register(...Chart.registerables);
  }
} catch (e) {
  console.warn('Chart.js registration skipped:', e);
}

// ===== EVENT MARKERS PLUGIN =====
// Registered globally but only activates on charts that pass options.plugins.eventMarkers.events
Chart.register({
  id: 'eventMarkers',
  afterDraw(chart) {
    const markers = chart.config.options?.plugins?.eventMarkers?.events;
    if (!markers || !markers.length) return;
    const ctx = chart.ctx;
    const ca = chart.chartArea;
    if (!ca) return;
    ctx.save();
    markers.forEach(m => {
      const rawX = chart.scales.x.getPixelForValue(new Date(m.TimeStamp).getTime());
      const x = rawX + (m.offsetPx || 0);
      if (x < ca.left || x > ca.right) return;
      if (m.collapsedCount) {
        // Draw "+N more" label in grey
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#8b949e';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('+' + m.collapsedCount, x, ca.bottom + 22);
      } else {
        // Dashed vertical line
        ctx.strokeStyle = m.color;
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, ca.top);
        ctx.lineTo(x, ca.bottom);
        ctx.stroke();
        // Triangle ▼
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.moveTo(x, ca.bottom + 6);
        ctx.lineTo(x - 5, ca.bottom + 14);
        ctx.lineTo(x + 5, ca.bottom + 14);
        ctx.closePath();
        ctx.fill();
        // Short label
        ctx.font = '9px monospace';
        ctx.fillStyle = m.color;
        ctx.textAlign = 'center';
        ctx.fillText(m.shortLabel || '', x, ca.bottom + 26);
      }
    });
    ctx.restore();
  }
});

// Error boundary to prevent white-screen-of-death
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }
  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error
    };
  }
  componentDidCatch(error, info) {
    console.error('React error boundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return React.createElement('div', {
        style: {
          padding: '32px',
          color: '#f85149',
          background: '#161b22',
          border: '1px solid #f85149',
          borderRadius: '8px',
          margin: '24px'
        }
      }, React.createElement('h3', null, 'Something went wrong'), React.createElement('pre', {
        style: {
          fontSize: '12px',
          marginTop: '8px',
          color: '#8b949e',
          whiteSpace: 'pre-wrap'
        }
      }, String(this.state.error)), React.createElement('button', {
        onClick: () => this.setState({
          hasError: false,
          error: null
        }),
        style: {
          marginTop: '12px',
          padding: '6px 14px',
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: '6px',
          color: '#e6edf3',
          cursor: 'pointer'
        }
      }, 'Retry'));
    }
    return this.props.children;
  }
}

// ===== TAR PARSER (OPFS-backed streaming — low memory, works on iOS Safari) =====
class TarParser {
  static isGzipped(file) {
    return file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz');
  }

  static async extract(file, onProgress) {
    // If plain .tar, assume it's a wrapper containing a .tar.gz — find and extract the inner archive
    if (!TarParser.isGzipped(file)) {
      return TarParser._extractWrapper(file, onProgress);
    }
    return TarParser._extractGz(file, onProgress);
  }

  static async _extractWrapper(file, onProgress) {
    // Scan the plain tar for a nested .tar.gz/.tgz entry, write it to OPFS, then extract that
    const opfsRoot = await navigator.storage.getDirectory();
    const decoder = new TextDecoder();
    const reader = file.stream().getReader();
    let buffer = new Uint8Array(0);
    let offset = 0;
    let found = false;
    const totalSize = file.size;

    onProgress(2, 'Scanning wrapper tar...');

    // Read enough to find the first .tar.gz entry header
    const readMore = async (needed) => {
      while (buffer.length - offset < needed) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Unexpected end of tar wrapper');
        const combined = new Uint8Array(buffer.length - offset + value.length);
        combined.set(buffer.subarray(offset));
        combined.set(value, buffer.length - offset);
        buffer = combined;
        offset = 0;
      }
    };

    // Parse tar headers until we find a .tar.gz
    while (true) {
      await readMore(512);
      const header = buffer.subarray(offset, offset + 512);
      // Check null block
      let allZero = true;
      for (let i = 0; i < 512; i++) { if (header[i] !== 0) { allZero = false; break; } }
      if (allZero) break;

      const name = decoder.decode(header.subarray(0, 100)).split('\0')[0];
      const sizeStr = decoder.decode(header.subarray(124, 136)).split('\0')[0].trim();
      const entrySize = sizeStr ? parseInt(sizeStr, 8) || 0 : 0;
      const prefix = decoder.decode(header.subarray(345, 500)).split('\0')[0];
      const fullName = (prefix ? prefix + '/' + name : name).replace(/\0+$/, '');
      offset += 512;

      if (fullName.endsWith('.tar.gz') || fullName.endsWith('.tgz')) {
        // Stream this entry's data to an OPFS file
        onProgress(5, 'Extracting inner archive...');
        const innerName = '_sysdiagnose_inner_' + Date.now() + '.tar.gz';
        const innerHandle = await opfsRoot.getFileHandle(innerName, { create: true });
        const writable = await innerHandle.createWritable();
        let remaining = entrySize;
        // Write whatever we already have buffered
        const buffered = Math.min(remaining, buffer.length - offset);
        if (buffered > 0) {
          await writable.write(buffer.subarray(offset, offset + buffered));
          remaining -= buffered;
          offset += buffered;
        }
        // Stream the rest directly from the file reader
        while (remaining > 0) {
          const { done, value } = await reader.read();
          if (done) break;
          const toWrite = value.subarray(0, Math.min(value.length, remaining));
          await writable.write(toWrite);
          remaining -= toWrite.length;
          const pct = 5 + ((entrySize - remaining) / entrySize) * 40;
          onProgress(Math.min(45, pct), 'Extracting inner archive...');
        }
        await writable.close();
        // Now extract the inner .tar.gz via OPFS
        const innerFile = await innerHandle.getFile();
        const innerBlob = new File([innerFile], fullName.split('/').pop());
        const result = await TarParser._extractGz(innerBlob, onProgress);
        try { await opfsRoot.removeEntry(innerName); } catch (_) {}
        return result;
      }

      // Skip this entry's data
      const dataBlocks = Math.ceil(entrySize / 512) * 512;
      // Discard buffered data for this entry
      const bufferedData = buffer.length - offset;
      if (bufferedData >= dataBlocks) {
        offset += dataBlocks;
      } else {
        // Need to read and discard from stream
        let toSkip = dataBlocks - bufferedData;
        offset = buffer.length; // consumed all buffer
        while (toSkip > 0) {
          const { done, value } = await reader.read();
          if (done) break;
          toSkip -= value.length;
        }
        buffer = new Uint8Array(0);
        offset = 0;
      }
      onProgress(Math.min(10, (offset / totalSize) * 10), 'Scanning wrapper tar...');
    }

    throw new Error('No .tar.gz sysdiagnose found inside wrapper tar');
  }

  static async _extractGz(file, onProgress) {
    // Stream decompress .tar.gz → OPFS temp file (never holds full tar in RAM)
    const opfsRoot = await navigator.storage.getDirectory();
    const tempName = '_sysdiagnose_temp_' + Date.now() + '.tar';
    const tempHandle = await opfsRoot.getFileHandle(tempName, { create: true });
    const writable = await tempHandle.createWritable();
    let totalWritten = 0;
    const compressedSize = file.size;

    try {
      const inputStream = file.stream().pipeThrough(new DecompressionStream('gzip'));
      const reader = inputStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        totalWritten += value.length;
        const est = Math.min(48, totalWritten / (compressedSize * 3.5) * 50);
        onProgress(est, 'Decompressing to disk...');
      }
      await writable.close();
    } catch (e) {
      try { await writable.close(); } catch (_) {}
      try { await opfsRoot.removeEntry(tempName); } catch (_) {}
      throw e;
    }

    onProgress(50, 'Parsing tar archive...');

    // Parse tar entries using chunked buffered reads (avoids excessive file.slice calls)
    const tarFile = await tempHandle.getFile();
    const tarSize = tarFile.size;
    const decoder = new TextDecoder();

    // Buffered reader: reads large chunks to minimize file resource calls
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
    let chunkBuf = null;
    let chunkStart = -1; // file offset where chunkBuf starts
    let chunkLen = 0;

    const ensureBuffered = async (fileOffset, needed) => {
      // If the requested range is within our current buffer, no-op
      if (chunkBuf && fileOffset >= chunkStart && fileOffset + needed <= chunkStart + chunkLen) {
        return;
      }
      // Read a new chunk from the file
      const readSize = Math.max(CHUNK_SIZE, needed);
      const end = Math.min(fileOffset + readSize, tarSize);
      const blob = tarFile.slice(fileOffset, end);
      chunkBuf = new Uint8Array(await blob.arrayBuffer());
      chunkStart = fileOffset;
      chunkLen = chunkBuf.length;
    };

    const readBytes = async (fileOffset, length) => {
      await ensureBuffered(fileOffset, length);
      const localOffset = fileOffset - chunkStart;
      return chunkBuf.subarray(localOffset, localOffset + length);
    };

    const readStr = (buf, start, len) => {
      return decoder.decode(buf.slice(start, start + len)).split('\0')[0];
    };

    const readOctal = (buf, start, len) => {
      const s = readStr(buf, start, len).trim();
      return s ? parseInt(s, 8) || 0 : 0;
    };

    const isNullBlock = (buf) => {
      for (let i = 0; i < 512; i++) {
        if (buf[i] !== 0) return false;
      }
      return true;
    };

    const entries = [];
    let offset = 0;
    let entryCount = 0;

    while (offset < tarSize - 512) {
      const headerBuf = await readBytes(offset, 512);

      if (isNullBlock(headerBuf)) {
        offset += 512;
        if (offset < tarSize - 512) {
          const nextBuf = await readBytes(offset, 512);
          if (isNullBlock(nextBuf)) break; // double null = end of archive
        } else break;
        continue;
      }

      const name = readStr(headerBuf, 0, 100);
      const size = readOctal(headerBuf, 124, 12);
      const typeFlag = readStr(headerBuf, 156, 1);
      const prefix = readStr(headerBuf, 345, 155);
      const fullName = (prefix ? prefix + '/' + name : name).replace(/\0+$/, '');
      offset += 512; // past header

      const isFileEntry = typeFlag === '0' || typeFlag === '' || (!typeFlag && size > 0);
      const isDir = typeFlag === '5' || fullName.endsWith('/');
      const baseName = fullName.split('/').pop() || '';

      // Skip macOS resource fork files
      if (!baseName.startsWith('._') && fullName && fullName !== 'pax_global_header') {
        const entry = {
          name: fullName,
          size,
          isFile: isFileEntry && !isDir,
          data: null
        };
        const isPLSQL = fullName.endsWith('.PLSQL') || fullName.endsWith('.EPSQL');
        const maxSize = isPLSQL ? 200 * 1024 * 1024 : 2 * 1024 * 1024;
        if (isFileEntry && !isDir && size > 0 && size < maxSize) {
          // Read file data from buffered chunks — no extra file.slice per entry
          const fileData = await readBytes(offset, size);
          // Must copy since readBytes returns a subarray of the shared chunk buffer
          const copied = new Uint8Array(size);
          copied.set(fileData);
          entry.data = isPLSQL ? copied : copied.buffer.slice(copied.byteOffset, copied.byteOffset + copied.byteLength);
          entry.isPLSQL = isPLSQL;
        }
        entries.push(entry);
        entryCount++;
      }

      // Advance past data blocks (512-byte aligned)
      const dataBlocks = Math.ceil(size / 512);
      offset += dataBlocks * 512;
      if (entryCount % 200 === 0) {
        const pct = 52 + (offset / tarSize) * 48;
        onProgress(Math.min(99, pct), `Parsing entries... (${entryCount} found)`);
        await new Promise(r => setTimeout(r, 0)); // yield to UI
      }
    }

    // Clean up OPFS temp file
    try { await opfsRoot.removeEntry(tempName); } catch (_) {}

    onProgress(100, 'Complete');
    return entries;
  }
}

// ===== CSV PARSER =====
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx];
    });
    rows.push(row);
  }
  return rows;
}

// ===== PLSQL (SQLite) PARSER =====
let sqlJsInitPromise = null;
function getSqlJs() {
  if (!sqlJsInitPromise) {
    sqlJsInitPromise = initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });
  }
  return sqlJsInitPromise;
}
async function parsePLSQL(fileData) {
  try {
    const SQL = await getSqlJs();
    const buf = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : fileData;
    const db = new SQL.Database(buf);
    const result = {
      cpmsData: [],
      batteryEvents: []
    };

    // Query CPMSControlState for sysCap data
    try {
      const cpmsRows = db.exec(`
                        SELECT timestamp, sysCap0, sysCap1, sysCap2,
                               brownoutRiskEngaged, peakPowerPressureLevel, mode
                        FROM PLBatteryAgent_EventPoint_CPMSControlState
                        ORDER BY timestamp ASC
                    `);
      if (cpmsRows.length > 0) {
        const cols = cpmsRows[0].columns;
        result.cpmsData = cpmsRows[0].values.map(row => {
          const obj = {};
          cols.forEach((c, i) => obj[c] = row[i]);
          // Convert Unix timestamp to ISO string
          obj.TimeStamp = new Date(obj.timestamp * 1000).toISOString();
          return obj;
        });
      }
    } catch (e) {
      console.warn('CPMSControlState query failed:', e.message);
    }

    // Query Battery events for voltage/amperage/temp timeline
    try {
      const batRows = db.exec(`
                        SELECT timestamp, Temperature, Voltage, InstantAmperage, Level
                        FROM PLBatteryAgent_EventBackward_Battery
                        ORDER BY timestamp ASC
                    `);
      if (batRows.length > 0) {
        const cols = batRows[0].columns;
        result.batteryEvents = batRows[0].values.map(row => {
          const obj = {};
          cols.forEach((c, i) => obj[c] = row[i]);
          obj.TimeStamp = new Date(obj.timestamp * 1000).toISOString();
          return obj;
        });
      }
    } catch (e) {
      console.warn('Battery events query failed:', e.message);
    }
    db.close();
    return result;
  } catch (e) {
    console.error('PLSQL parse error:', e);
    return {
      cpmsData: [],
      batteryEvents: []
    };
  }
}

// ===== IndexedDB PERSISTENCE =====
const DB_NAME = 'sysdiagnose-explorer';
const DB_VERSION = 1;
const STORE_NAME = 'archives';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {
          keyPath: 'id'
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveToIndexedDB(archiveName, files) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Serialize: store file metadata + data as transferable
    const serialized = files.map(f => ({
      name: f.name,
      size: f.size,
      isFile: f.isFile,
      data: f.data ? new Uint8Array(f.data) : null
    }));
    store.put({
      id: archiveName,
      name: archiveName,
      savedAt: new Date().toISOString(),
      fileCount: files.filter(f => f.isFile).length,
      totalSize: files.reduce((s, f) => s + f.size, 0),
      files: serialized
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('Failed to save to IndexedDB:', e);
  }
}
async function listSavedArchives() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        db.close();
        // Return metadata only (no files array) for listing
        resolve((req.result || []).map(r => ({
          id: r.id,
          name: r.name,
          savedAt: r.savedAt,
          fileCount: r.fileCount,
          totalSize: r.totalSize
        })));
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch (e) {
    console.warn('Failed to list archives:', e);
    return [];
  }
}
async function loadFromIndexedDB(archiveId) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(archiveId);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      db.close();
      if (!req.result) {
        resolve(null);
        return;
      }
      // Reconvert Uint8Arrays back to ArrayBuffers
      const files = req.result.files.map(f => ({
        ...f,
        data: f.data ? f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) : null
      }));
      resolve({
        name: req.result.name,
        files
      });
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}
async function deleteSavedArchive(archiveId) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(archiveId);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ===== UTILITY FUNCTIONS =====
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
function getSectionFiles(files, prefixes) {
  if (Array.isArray(prefixes)) {
    return files.filter(f => f.isFile && prefixes.some(p => f.name.startsWith(p)));
  }
  return files.filter(f => f.isFile && f.name.startsWith(prefixes));
}
function filterByTimeRange(data, range, refDate) {
  if (range === 'all' || data.length === 0) return data;

  // Use provided reference date, or latest timestamp in data, or now
  const now = refDate ? new Date(refDate) : data.length > 0 ? new Date(data[data.length - 1].TimeStamp) : new Date();
  let cutoffDate;
  if (range === '1y') cutoffDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());else if (range === '6m') cutoffDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());else if (range === '3m') cutoffDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());else if (range === '1m') cutoffDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());else if (range === '28d') cutoffDate = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);else if (range === '7d') cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);else if (range === '3d') cutoffDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);else if (range === '1d') cutoffDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);else if (range === '12h') cutoffDate = new Date(now.getTime() - 12 * 60 * 60 * 1000);else if (range === '3h') cutoffDate = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return data.filter(row => new Date(row.TimeStamp) >= cutoffDate);
}
function hasColumn(data, column) {
  return data.length > 0 && column in data[0];
}

// ===== FILE PREVIEW COMPONENT =====
function FilePreview({
  file,
  onClose
}) {
  const [content, setContent] = useState('');
  useEffect(() => {
    try {
      if (file.data && file.size < 2 * 1024 * 1024) {
        const decoder = new TextDecoder('utf-8', {
          fatal: false
        });
        const buf = file.data instanceof ArrayBuffer ? new Uint8Array(file.data) : file.data;
        let text = decoder.decode(buf);
        if (text.length > 100000) text = text.slice(0, 100000) + '\n\n... (truncated) ...';
        setContent(text);
      } else {
        setContent('File too large to preview (> 2 MB) or no data available');
      }
    } catch (e) {
      setContent('Error reading file: ' + e.message);
    }
  }, [file]);
  return /*#__PURE__*/React.createElement("div", {
    className: "preview-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "preview-header"
  }, /*#__PURE__*/React.createElement("span", null, file.name), /*#__PURE__*/React.createElement("span", {
    className: "preview-close",
    onClick: onClose,
    style: {
      cursor: 'pointer'
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    className: "preview-content"
  }, content));
}

// ===== Shared sidebar styles (matching Unified Log) =====
const CHART_SIDEBAR_WIDTH = '210px';
const CHART_TIME_RANGES = ['28D', '7D', '3D', '1D', '12H', '3H'];

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return mobile;
}

function getChartSidebarStyle(mobile) {
  return mobile ? {
    width: '100%',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: '8px',
    paddingBottom: '8px'
  } : {
    width: CHART_SIDEBAR_WIDTH,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    paddingRight: '12px'
  };
}

function getChartLayoutStyle(mobile) {
  return {
    display: 'flex',
    flexDirection: mobile ? 'column' : 'row',
    gap: 0,
    minHeight: mobile ? 'auto' : '400px'
  };
}

// Keep for backward compat with non-mobile-aware components
const chartSidebarStyle = {
  width: CHART_SIDEBAR_WIDTH,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  paddingRight: '12px'
};
const chartPanelStyle = {
  backgroundColor: '#161b22',
  border: '1px solid #30363d',
  borderRadius: '8px',
  padding: '10px'
};
const chartPanelHeaderStyle = {
  fontSize: '11px',
  fontWeight: 700,
  color: '#8b949e',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '6px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center'
};
const chartCheckRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '3px 0',
  cursor: 'pointer',
  fontSize: '12px',
  color: '#e6edf3',
  whiteSpace: 'nowrap'
};
const chartSwatchStyle = color => ({
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  backgroundColor: color,
  flexShrink: 0
});
const chartLinkStyle = {
  color: '#58a6ff',
  cursor: 'pointer',
  fontSize: '10px',
  fontWeight: 400,
  letterSpacing: 0
};
const chartZoomOptions = {
  zoom: {
    wheel: {
      enabled: true
    },
    pinch: {
      enabled: true
    },
    mode: 'x'
  },
  pan: {
    enabled: true,
    mode: 'x'
  },
  limits: {
    x: {
      minRange: 60 * 60 * 1000
    }
  }
};

// ===== BATTERY HEALTH CHART =====
function BatteryHealthChart({
  data
}) {
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState('all');
  const HEALTH_TIME_RANGES = ['All', '1Y', '6M', '3M', '1M'];
  const HEALTH_METRIC_DEFS = [{
    key: 'maxCapacity',
    label: 'Max Capacity %',
    color: '#58a6ff',
    col: 'MaxCapacityPercent',
    axis: 'y-left'
  }, {
    key: 'cycleCount',
    label: 'Cycle Count',
    color: '#3fb950',
    col: 'CycleCount',
    axis: 'y-left'
  }, {
    key: 'weightedRa',
    label: 'Weighted Ra',
    color: '#d29922',
    col: 'WeightedRa',
    axis: 'y-right'
  }, {
    key: 'nominalCharge',
    label: 'Nominal Charge (mAh)',
    color: '#f85149',
    col: 'NominalChargeCapacity',
    axis: 'y-right'
  }, {
    key: 'qmax',
    label: 'Qmax',
    color: '#bc8cff',
    col: 'Qmax0',
    axis: 'y-right'
  }, {
    key: 'voltage',
    label: 'Charging Voltage (V)',
    color: '#f778ba',
    col: 'ChargingVoltage',
    axis: 'y-voltage',
    parse: v => parseFloat(v) / 1000 || null
  }];
  const [selectedMetrics, setSelectedMetrics] = useState(new Set(['maxCapacity', 'cycleCount']));
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const filteredData = useMemo(() => filterByTimeRange(data, timeRange, null), [data, timeRange]);
  const toggleMetric = key => {
    setSelectedMetrics(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }
    if (!chartRef.current || filteredData.length === 0) return;
    try {
      const datasets = [];
      const activeMetrics = HEALTH_METRIC_DEFS.filter(m => selectedMetrics.has(m.key) && hasColumn(filteredData, m.col));
      activeMetrics.forEach(m => {
        const parseFn = m.parse || (v => parseFloat(v) || null);
        datasets.push({
          label: m.label,
          data: filteredData.map(row => ({
            x: new Date(row.TimeStamp).getTime(),
            y: parseFn(row[m.col])
          })),
          borderColor: m.color,
          backgroundColor: 'transparent',
          borderWidth: 2,
          yAxisID: m.axis,
          parsing: false,
          tension: 0.1,
          pointRadius: 0
        });
      });
      if (datasets.length === 0) return;
      const hasVoltage = activeMetrics.some(m => m.axis === 'y-voltage');
      const ctx = chartRef.current.getContext('2d');
      chartInstance.current = new Chart(ctx, {
        type: 'line',
        data: {
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            intersect: false,
            mode: 'index'
          },
          plugins: {
            legend: {
              labels: {
                color: '#e6edf3',
                usePointStyle: true,
                padding: 16
              }
            },
            zoom: chartZoomOptions
          },
          scales: {
            x: {
              type: 'time',
              time: {
                unit: 'day'
              },
              grid: {
                color: '#30363d',
                drawBorder: false
              },
              ticks: {
                color: '#8b949e'
              }
            },
            'y-left': {
              type: 'linear',
              position: 'left',
              grid: {
                color: '#30363d',
                drawBorder: false
              },
              ticks: {
                color: '#8b949e'
              }
            },
            'y-right': {
              type: 'linear',
              position: 'right',
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#8b949e'
              }
            },
            'y-voltage': {
              type: 'linear',
              position: 'right',
              min: 0,
              max: 4.7,
              display: hasVoltage,
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#f778ba',
                callback: v => v + 'V'
              }
            }
          }
        }
      });
    } catch (e) {
      console.error('BatteryHealthChart error:', e);
    }
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [filteredData, selectedMetrics]);
  return /*#__PURE__*/React.createElement("div", {
    style: getChartLayoutStyle(mobile)
  }, /*#__PURE__*/React.createElement("div", {
    style: getChartSidebarStyle(mobile)
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Time Range")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px'
    }
  }, HEALTH_TIME_RANGES.map(label => /*#__PURE__*/React.createElement("button", {
    key: label,
    className: `time-button ${timeRange === label.toLowerCase() ? 'active' : ''}`,
    onClick: () => setTimeRange(label.toLowerCase())
  }, label)))), /*#__PURE__*/React.createElement("div", {
    style: chartPanelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Metrics"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: chartLinkStyle,
    onClick: () => setSelectedMetrics(new Set(HEALTH_METRIC_DEFS.filter(m => hasColumn(data, m.col)).map(m => m.key)))
  }, "all"), ' · ', /*#__PURE__*/React.createElement("span", {
    style: chartLinkStyle,
    onClick: () => setSelectedMetrics(new Set())
  }, "clear"))), HEALTH_METRIC_DEFS.map(m => /*#__PURE__*/React.createElement("label", {
    key: m.key,
    style: chartCheckRowStyle
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: selectedMetrics.has(m.key),
    onChange: () => toggleMetric(m.key),
    style: {
      accentColor: m.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: chartSwatchStyle(m.color)
  }), m.label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: '8px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '14px',
      fontWeight: 600,
      color: '#e6edf3'
    }
  }, "Battery Health Over Time"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '11px',
      color: '#484f58',
      marginLeft: '12px'
    }
  }, "Scroll to zoom \xB7 drag to pan")), /*#__PURE__*/React.createElement("div", {
    className: "chart-container"
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: chartRef
  }))));
}

// ===== BATTERY STATE CHART =====
function BatteryStateChart({
  data
}) {
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState('3d');
  const METRIC_DEFS = [{
    key: 'soc',
    label: 'State of Charge %',
    color: '#58a6ff',
    col: 'StateOfCharge',
    axis: 'y-left',
    parse: v => parseFloat(v) || null
  }, {
    key: 'temp',
    label: 'Temperature (°C)',
    color: '#3fb950',
    col: 'Temperature',
    axis: 'y-right',
    parse: v => parseFloat(v) / 100 || null
  }, {
    key: 'voltage',
    label: 'Voltage (V)',
    color: '#d29922',
    col: 'Voltage',
    axis: 'y-voltage',
    parse: v => parseFloat(v) / 1000 || null
  }, {
    key: 'amperage',
    label: 'Amperage (mA)',
    color: '#f85149',
    col: 'Amperage',
    axis: 'y-right',
    parse: v => parseFloat(v) || null
  }, {
    key: 'capacity',
    label: 'Current Capacity %',
    color: '#bc8cff',
    col: 'CurrentCapacity',
    axis: 'y-right',
    parse: v => parseFloat(v) || null
  }, {
    key: 'watts',
    label: 'Power (W)',
    color: '#f778ba',
    col: 'Watts',
    axis: 'y-right',
    parse: v => parseFloat(v) || null
  }, {
    key: 'rss',
    label: 'Impedance (RSS)',
    color: '#f47067',
    col: 'RSS',
    axis: 'y-rss',
    parse: v => parseFloat(v) || null
  }];
  const [selectedMetrics, setSelectedMetrics] = useState(new Set(['soc', 'temp']));
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const filteredData = useMemo(() => filterByTimeRange(data, timeRange, null), [data, timeRange]);
  const toggleMetric = key => {
    setSelectedMetrics(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }
    if (!chartRef.current || filteredData.length === 0) return;
    try {
      const datasets = [];
      const activeMetrics = METRIC_DEFS.filter(m => selectedMetrics.has(m.key) && hasColumn(filteredData, m.col));
      activeMetrics.forEach(m => {
        datasets.push({
          label: m.label,
          data: filteredData.map(row => ({
            x: new Date(row.TimeStamp).getTime(),
            y: m.parse(row[m.col])
          })),
          borderColor: m.color,
          backgroundColor: 'transparent',
          borderWidth: 2,
          yAxisID: m.axis,
          parsing: false,
          tension: 0.1,
          pointRadius: 0
        });
      });
      if (datasets.length === 0) return;
      const hasVoltage = activeMetrics.some(m => m.axis === 'y-voltage');
      const hasRss = activeMetrics.some(m => m.axis === 'y-rss');
      const ctx = chartRef.current.getContext('2d');
      chartInstance.current = new Chart(ctx, {
        type: 'line',
        data: {
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            intersect: false,
            mode: 'index'
          },
          plugins: {
            legend: {
              labels: {
                color: '#e6edf3',
                usePointStyle: true,
                padding: 16
              }
            },
            zoom: chartZoomOptions
          },
          scales: {
            x: {
              type: 'time',
              time: {
                unit: 'hour'
              },
              grid: {
                color: '#30363d',
                drawBorder: false
              },
              ticks: {
                color: '#8b949e'
              }
            },
            'y-left': {
              type: 'linear',
              position: 'left',
              grid: {
                color: '#30363d',
                drawBorder: false
              },
              ticks: {
                color: '#8b949e'
              }
            },
            'y-right': {
              type: 'linear',
              position: 'right',
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#8b949e'
              }
            },
            'y-voltage': {
              type: 'linear',
              position: 'right',
              min: 0,
              max: 4.7,
              display: hasVoltage,
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#d29922',
                callback: v => v + 'V'
              }
            },
            'y-rss': {
              type: 'linear',
              position: 'right',
              display: hasRss,
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#f47067'
              },
              title: {
                display: true,
                text: 'RSS',
                color: '#f47067'
              }
            }
          }
        }
      });
    } catch (e) {
      console.error('BatteryStateChart error:', e);
    }
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [filteredData, selectedMetrics]);
  return /*#__PURE__*/React.createElement("div", {
    style: getChartLayoutStyle(mobile)
  }, /*#__PURE__*/React.createElement("div", {
    style: getChartSidebarStyle(mobile)
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Time Range")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px'
    }
  }, CHART_TIME_RANGES.map(label => /*#__PURE__*/React.createElement("button", {
    key: label,
    className: `time-button ${timeRange === label.toLowerCase() ? 'active' : ''}`,
    onClick: () => setTimeRange(label.toLowerCase())
  }, label)))), /*#__PURE__*/React.createElement("div", {
    style: chartPanelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Metrics"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: chartLinkStyle,
    onClick: () => setSelectedMetrics(new Set(METRIC_DEFS.filter(m => hasColumn(data, m.col)).map(m => m.key)))
  }, "all"), ' · ', /*#__PURE__*/React.createElement("span", {
    style: chartLinkStyle,
    onClick: () => setSelectedMetrics(new Set())
  }, "clear"))), METRIC_DEFS.map(m => {
    const avail = hasColumn(data, m.col);
    return /*#__PURE__*/React.createElement("label", {
      key: m.key,
      style: {
        ...chartCheckRowStyle,
        opacity: avail ? 1 : 0.4,
        cursor: avail ? 'pointer' : 'default'
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: selectedMetrics.has(m.key),
      disabled: !avail,
      onChange: () => avail && toggleMetric(m.key),
      style: {
        margin: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: chartSwatchStyle(m.color)
    }), /*#__PURE__*/React.createElement("span", null, m.label));
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column'
    }
  }, selectedMetrics.size === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: '#8b949e',
      fontSize: '14px'
    }
  }, "Select metrics from the sidebar to begin") : /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: '420px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: chartRef
  }))));
}

// ===== PERFORMANCE MANAGEMENT CHART =====
function PerformanceManagementChart({
  cpmsData,
  batteryEvents,
  sbcData
}) {
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState('3d');
  const METRIC_DEFS = [{
    key: 'sysCap0',
    label: 'sysCap0 (Total)',
    color: '#f85149',
    source: 'cpms',
    field: 'sysCap0',
    axis: 'y-cap',
    fill: true
  }, {
    key: 'sysCap1',
    label: 'sysCap1 (Sustained)',
    color: '#d29922',
    source: 'cpms',
    field: 'sysCap1',
    axis: 'y-cap',
    fill: true
  }, {
    key: 'sysCap2',
    label: 'sysCap2 (Burst)',
    color: '#58a6ff',
    source: 'cpms',
    field: 'sysCap2',
    axis: 'y-cap',
    fill: true
  }, {
    key: 'rss',
    label: 'RSS (mΩ)',
    color: '#f47067',
    source: 'sbc',
    field: 'RSS',
    axis: 'y-rss'
  }, {
    key: 'resscale',
    label: 'ResScale',
    color: '#e3b341',
    source: 'sbc',
    field: 'ResScale',
    axis: 'y-resscale',
    dash: [4, 2]
  }, {
    key: 'temp',
    label: 'Battery Temp (°C)',
    color: '#3fb950',
    source: 'bat',
    field: 'Temperature',
    axis: 'y-temp',
    dash: [4, 2]
  }, {
    key: 'voltage',
    label: 'Voltage (mV)',
    color: '#bc8cff',
    source: 'bat',
    field: 'Voltage',
    axis: 'y-voltage'
  }, {
    key: 'amperage',
    label: 'Amperage (mA)',
    color: '#f778ba',
    source: 'bat',
    field: 'Amperage',
    axis: 'y-amp'
  }];
  const [selectedMetrics, setSelectedMetrics] = useState(new Set(['sysCap0', 'sysCap1', 'sysCap2', 'rss']));
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const filteredCpms = useMemo(() => filterByTimeRange(cpmsData, timeRange, null), [cpmsData, timeRange]);
  const filteredBat = useMemo(() => filterByTimeRange(batteryEvents, timeRange, null), [batteryEvents, timeRange]);
  const filteredSbc = useMemo(() => filterByTimeRange(sbcData || [], timeRange, null), [sbcData, timeRange]);
  const toggleMetric = key => {
    setSelectedMetrics(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const hasData = m => {
    if (m.source === 'cpms') return filteredCpms.length > 0;
    if (m.source === 'sbc') return filteredSbc.length > 0;
    return filteredBat.length > 0;
  };
  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }
    if (!chartRef.current || (filteredCpms.length === 0 && filteredSbc.length === 0 && filteredBat.length === 0)) return;
    try {
      const datasets = [];
      const activeMetrics = METRIC_DEFS.filter(m => selectedMetrics.has(m.key) && hasData(m));
      activeMetrics.forEach(m => {
        const source = m.source === 'cpms' ? filteredCpms : m.source === 'sbc' ? filteredSbc : filteredBat;
        datasets.push({
          label: m.label,
          data: source.map(row => ({
            x: new Date(row.TimeStamp).getTime(),
            y: typeof row[m.field] === 'number' ? row[m.field] : parseFloat(row[m.field])
          })),
          borderColor: m.color,
          backgroundColor: m.fill ? m.color + '1a' : 'transparent',
          borderWidth: m.dash ? 1.5 : 2,
          borderDash: m.dash || [],
          yAxisID: m.axis,
          parsing: false,
          tension: 0.2,
          pointRadius: 0,
          fill: !!m.fill
        });
      });
      if (datasets.length === 0) return;
      const hasVoltage = activeMetrics.some(m => m.axis === 'y-voltage');
      const hasAmp = activeMetrics.some(m => m.axis === 'y-amp');
      const hasTemp = activeMetrics.some(m => m.axis === 'y-temp');
      const hasRss = activeMetrics.some(m => m.axis === 'y-rss');
      const hasResScale = activeMetrics.some(m => m.axis === 'y-resscale');
      const ctx = chartRef.current.getContext('2d');
      chartInstance.current = new Chart(ctx, {
        type: 'line',
        data: {
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            intersect: false,
            mode: 'index'
          },
          plugins: {
            legend: {
              labels: {
                color: '#e6edf3',
                usePointStyle: true,
                padding: 16
              }
            },
            zoom: chartZoomOptions,
            tooltip: {
              callbacks: {
                label: ctx => {
                  const v = ctx.parsed.y;
                  if (ctx.dataset.label.includes('Temp')) return `${ctx.dataset.label}: ${v.toFixed(1)}°C`;
                  if (ctx.dataset.label.includes('RSS')) return `${ctx.dataset.label}: ${v} mΩ`;
                  if (ctx.dataset.label.includes('ResScale')) return `${ctx.dataset.label}: ${v}`;
                  return `${ctx.dataset.label}: ${v.toLocaleString()}`;
                }
              }
            }
          },
          scales: {
            x: {
              type: 'time',
              time: {
                unit: 'hour'
              },
              grid: {
                color: '#30363d',
                drawBorder: false
              },
              ticks: {
                color: '#8b949e'
              }
            },
            'y-cap': {
              type: 'linear',
              position: 'left',
              title: {
                display: true,
                text: 'System Capacity (sysCap)',
                color: '#8b949e'
              },
              grid: {
                color: '#30363d',
                drawBorder: false
              },
              ticks: {
                color: '#8b949e',
                callback: v => v.toLocaleString()
              }
            },
            'y-temp': {
              type: 'linear',
              position: 'right',
              display: hasTemp,
              title: {
                display: true,
                text: '°C',
                color: '#3fb950'
              },
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#3fb950'
              }
            },
            'y-voltage': {
              type: 'linear',
              position: 'right',
              display: hasVoltage,
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#bc8cff',
                callback: v => v + 'mV'
              }
            },
            'y-amp': {
              type: 'linear',
              position: 'right',
              display: hasAmp,
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#f778ba',
                callback: v => v + 'mA'
              }
            },
            'y-rss': {
              type: 'linear',
              position: 'right',
              display: hasRss,
              title: {
                display: true,
                text: 'RSS (mΩ)',
                color: '#f47067'
              },
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#f47067'
              }
            },
            'y-resscale': {
              type: 'linear',
              position: 'right',
              display: hasResScale,
              title: {
                display: true,
                text: 'ResScale',
                color: '#e3b341'
              },
              grid: {
                drawOnChartArea: false,
                drawBorder: false
              },
              ticks: {
                color: '#e3b341'
              }
            }
          }
        }
      });
    } catch (e) {
      console.error('PerformanceManagementChart error:', e);
    }
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [filteredCpms, filteredBat, filteredSbc, selectedMetrics]);
  return /*#__PURE__*/React.createElement("div", {
    style: getChartLayoutStyle(mobile)
  }, /*#__PURE__*/React.createElement("div", {
    style: getChartSidebarStyle(mobile)
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Time Range")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px'
    }
  }, CHART_TIME_RANGES.map(label => /*#__PURE__*/React.createElement("button", {
    key: label,
    className: `time-button ${timeRange === label.toLowerCase() ? 'active' : ''}`,
    onClick: () => setTimeRange(label.toLowerCase())
  }, label)))), /*#__PURE__*/React.createElement("div", {
    style: chartPanelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: chartPanelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "Metrics"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: chartLinkStyle,
    onClick: () => setSelectedMetrics(new Set(METRIC_DEFS.filter(m => hasData(m)).map(m => m.key)))
  }, "all"), ' · ', /*#__PURE__*/React.createElement("span", {
    style: chartLinkStyle,
    onClick: () => setSelectedMetrics(new Set())
  }, "clear"))), METRIC_DEFS.map(m => /*#__PURE__*/React.createElement("label", {
    key: m.key,
    style: chartCheckRowStyle
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: selectedMetrics.has(m.key),
    onChange: () => toggleMetric(m.key),
    style: {
      accentColor: m.color
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: chartSwatchStyle(m.color)
  }), m.label))), filteredCpms.length > 0 && (() => {
    const minCap0 = Math.min(...filteredCpms.map(r => r.sysCap0));
    const maxCap0 = Math.max(...filteredCpms.map(r => r.sysCap0));
    const dropPct = ((maxCap0 - minCap0) / maxCap0 * 100).toFixed(1);
    return /*#__PURE__*/React.createElement("div", {
      style: chartPanelStyle
    }, /*#__PURE__*/React.createElement("div", {
      style: chartPanelHeaderStyle
    }, /*#__PURE__*/React.createElement("span", null, "Summary")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '11px',
        color: '#e6edf3',
        lineHeight: '1.6'
      }
    }, /*#__PURE__*/React.createElement("div", null, "sysCap0: ", minCap0.toLocaleString(), " \u2013 ", maxCap0.toLocaleString()), /*#__PURE__*/React.createElement("div", null, "Max drop: ", /*#__PURE__*/React.createElement("span", {
      style: {
        color: dropPct > 10 ? '#f85149' : '#3fb950'
      }
    }, dropPct, "%")), /*#__PURE__*/React.createElement("div", null, "Points: ", filteredCpms.length), /*#__PURE__*/React.createElement("div", null, "Brownout: ", filteredCpms.some(r => r.brownoutRiskEngaged) ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#f85149'
      }
    }, "ENGAGED") : /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#3fb950'
      }
    }, "None"))));
  })()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: '8px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '14px',
      fontWeight: 600,
      color: '#e6edf3'
    }
  }, "CPMS Power Budget Over Time"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '11px',
      color: '#484f58',
      marginLeft: '12px'
    }
  }, "Scroll to zoom \xB7 drag to pan")), /*#__PURE__*/React.createElement("div", {
    className: "chart-container"
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: chartRef
  }))));
}

// ===== POWER & BATTERY DASHBOARD =====
function PowerBatteryDashboard({
  files,
  sectionFiles
}) {
  const [bdcDailyData, setBdcDailyData] = useState([]);
  const [bdcSbcData, setBdcSbcData] = useState([]);
  const [cpmsData, setCpmsData] = useState([]);
  const [batteryEvents, setBatteryEvents] = useState([]);
  const [activeTab, setActiveTab] = useState('sbc');
  const [selectedFile, setSelectedFile] = useState(null);
  useEffect(() => {
    try {
      const dailyFiles = files.filter(f => f.name.includes('BDC_Daily_') && f.name.endsWith('.csv') && f.data);
      const sbcFiles = files.filter(f => f.name.includes('BDC_SBC_') && f.name.endsWith('.csv') && f.data);
      const safeDecodeFile = f => {
        try {
          const decoder = new TextDecoder('utf-8', {
            fatal: false
          });
          // Handle both ArrayBuffer and Uint8Array (from IndexedDB round-trip)
          const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
          return decoder.decode(buf);
        } catch (e) {
          console.warn('Failed to decode file:', f.name, e);
          return '';
        }
      };
      let allDailyRows = [];
      dailyFiles.forEach(f => {
        const text = safeDecodeFile(f);
        if (text) {
          const rows = parseCSV(text);
          allDailyRows = allDailyRows.concat(rows);
        }
      });
      let allSbcRows = [];
      sbcFiles.forEach(f => {
        const text = safeDecodeFile(f);
        if (text) {
          const rows = parseCSV(text);
          allSbcRows = allSbcRows.concat(rows);
        }
      });
      const dailyMap = new Map();
      allDailyRows.forEach(row => {
        if (row.TimeStamp) {
          dailyMap.set(row.TimeStamp, row);
        }
      });
      const sortedDaily = Array.from(dailyMap.values()).sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
      const sbcMap = new Map();
      allSbcRows.forEach(row => {
        if (row.TimeStamp) {
          sbcMap.set(row.TimeStamp, row);
        }
      });
      const sortedSbc = Array.from(sbcMap.values()).sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
      setBdcDailyData(sortedDaily);
      setBdcSbcData(sortedSbc);

      // Parse PLSQL extracted data (stored as synthetic JSON file)
      const plsqlJsonFile = files.find(f => f.name === 'logs/powerlogs/_parsed_plsql.json' && f.data);
      if (plsqlJsonFile) {
        try {
          const decoder = new TextDecoder('utf-8', {
            fatal: false
          });
          const buf = plsqlJsonFile.data instanceof ArrayBuffer ? new Uint8Array(plsqlJsonFile.data) : plsqlJsonFile.data;
          const parsed = JSON.parse(decoder.decode(buf));
          if (parsed.cpmsData) setCpmsData(parsed.cpmsData);
          if (parsed.batteryEvents) setBatteryEvents(parsed.batteryEvents);
        } catch (e) {
          console.warn('Failed to parse PLSQL JSON:', e);
        }
      }
    } catch (e) {
      console.error('Error parsing battery data:', e);
    }
  }, [files]);
  const hasCpmsData = cpmsData.length > 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tab-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: `tab ${activeTab === 'daily' ? 'active' : ''}`,
    onClick: () => setActiveTab('daily')
  }, "Battery Health (Long-term)"), /*#__PURE__*/React.createElement("div", {
    className: `tab ${activeTab === 'sbc' ? 'active' : ''}`,
    onClick: () => setActiveTab('sbc')
  }, "Battery State (Recent)"), (hasCpmsData || bdcSbcData.length > 0) && /*#__PURE__*/React.createElement("div", {
    className: `tab ${activeTab === 'perf' ? 'active' : ''}`,
    onClick: () => setActiveTab('perf')
  }, "Performance Mgmt")), activeTab === 'daily' && /*#__PURE__*/React.createElement(BatteryHealthChart, {
    data: bdcDailyData
  }), activeTab === 'sbc' && /*#__PURE__*/React.createElement(BatteryStateChart, {
    data: bdcSbcData
  }), activeTab === 'perf' && (hasCpmsData || bdcSbcData.length > 0) && /*#__PURE__*/React.createElement(PerformanceManagementChart, {
    cpmsData: cpmsData,
    batteryEvents: batteryEvents,
    sbcData: bdcSbcData
  }), /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}
function CollapsibleFileList({
  files,
  selectedFile,
  setSelectedFile
}) {
  const [filesExpanded, setFilesExpanded] = useState(false);
  return /*#__PURE__*/React.createElement("div", {
    className: "file-list"
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => setFilesExpanded(!filesExpanded),
    style: {
      fontSize: '12px',
      color: '#8b949e',
      marginBottom: filesExpanded ? '12px' : 0,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      userSelect: 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      transition: 'transform 0.2s',
      transform: filesExpanded ? 'rotate(90deg)' : 'rotate(0deg)'
    }
  }, "\u203A"), "Files in this section (", files.length, ")"), filesExpanded && files.map((file, idx) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: idx
  }, /*#__PURE__*/React.createElement("div", {
    className: "file-item",
    onClick: () => setSelectedFile(selectedFile === idx ? null : idx)
  }, /*#__PURE__*/React.createElement("span", {
    className: "file-item-name"
  }, file.name), /*#__PURE__*/React.createElement("span", {
    className: "file-item-size"
  }, formatBytes(file.size))), selectedFile === idx && /*#__PURE__*/React.createElement(FilePreview, {
    file: file,
    onClose: () => setSelectedFile(null)
  }))));
}

// ===== SYSTEM PERFORMANCE DASHBOARD =====
function SystemPerformanceDashboard({
  files,
  sectionFiles
}) {
  const [vmStats, setVmStats] = useState(null);
  const [topMemory, setTopMemory] = useState([]);
  const [topCpu, setTopCpu] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedFile, setSelectedFile] = useState(null);
  const memChartRef = useRef(null);
  const memChartInstance = useRef(null);
  const cpuChartRef = useRef(null);
  const cpuChartInstance = useRef(null);
  const vmChartRef = useRef(null);
  const vmChartInstance = useRef(null);
  useEffect(() => {
    try {
      const decoder = new TextDecoder('utf-8', {
        fatal: false
      });
      const decodeFile = f => {
        const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
        return decoder.decode(buf);
      };

      // Parse vm_stat.txt
      const vmFile = files.find(f => f.name === 'vm_stat.txt' && f.data);
      if (vmFile) {
        const text = decodeFile(vmFile);
        const lines = text.trim().split('\n');
        // Header line has column names, data line has values
        if (lines.length >= 3) {
          const headers = lines[1].trim().split(/\s+/);
          const values = lines[2].trim().split(/\s+/).map(Number);
          const pageSize = 16384;
          const toMB = pages => Math.round(pages * pageSize / (1024 * 1024));
          const stats = {};
          headers.forEach((h, i) => {
            stats[h] = values[i] || 0;
          });
          setVmStats({
            free: toMB(stats['free'] || 0),
            active: toMB(stats['active'] || 0),
            inactive: toMB(stats['inactive'] || 0),
            speculative: toMB(stats['specul'] || 0),
            wired: toMB(stats['wired'] || 0),
            compressed: toMB(stats['cmprssed'] || 0),
            purgeable: toMB(stats['prgable'] || 0)
          });
        }
      }

      // Parse jetsam_priority.csv for top memory
      const jetsamFile = files.find(f => f.name === 'jetsam_priority.csv' && f.data);
      if (jetsamFile) {
        const text = decodeFile(jetsamFile);
        const rows = parseCSV(text);
        const sorted = rows.map(r => ({
          name: r.name || 'unknown',
          footprint: parseInt(r.footprint) || 0,
          footprintPeak: parseInt(r.footprint_peak) || 0,
          pid: r.pid,
          priority: r.priority_name
        })).sort((a, b) => b.footprint - a.footprint).slice(0, 20);
        setTopMemory(sorted);
      }

      // Parse ps.txt for top CPU
      const psFile = files.find(f => f.name === 'ps.txt' && f.data);
      if (psFile) {
        const text = decodeFile(psFile);
        const lines = text.trim().split('\n');
        if (lines.length > 1) {
          const header = lines[0].trim().split(/\s+/);
          const cpuIdx = header.indexOf('%CPU');
          const memIdx = header.indexOf('%MEM');
          const rssIdx = header.indexOf('RSS');
          const cmdIdx = header.indexOf('COMMAND');
          const pidIdx = header.indexOf('PID');
          const procs = [];
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            if (parts.length > cmdIdx) {
              const cmd = parts.slice(cmdIdx).join(' ');
              const shortCmd = cmd.split('/').pop().split(' ')[0];
              procs.push({
                name: shortCmd,
                cpu: parseFloat(parts[cpuIdx]) || 0,
                mem: parseFloat(parts[memIdx]) || 0,
                rss: parseInt(parts[rssIdx]) || 0,
                pid: parts[pidIdx]
              });
            }
          }
          const sorted = procs.sort((a, b) => b.cpu - a.cpu).slice(0, 20);
          setTopCpu(sorted);
        }
      }
    } catch (e) {
      console.error('SystemPerformanceDashboard error:', e);
    }
  }, [files]);

  // VM Memory breakdown chart
  useEffect(() => {
    if (vmChartInstance.current) {
      vmChartInstance.current.destroy();
      vmChartInstance.current = null;
    }
    if (!vmChartRef.current || !vmStats || activeTab !== 'overview') return;
    const labels = ['Free', 'Active', 'Inactive', 'Wired', 'Compressed', 'Purgeable', 'Speculative'];
    const data = [vmStats.free, vmStats.active, vmStats.inactive, vmStats.wired, vmStats.compressed, vmStats.purgeable, vmStats.speculative];
    const colors = ['#3fb950', '#58a6ff', '#8b949e', '#f85149', '#d29922', '#bc8cff', '#6e7681'];
    vmChartInstance.current = new Chart(vmChartRef.current.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors,
          borderColor: '#0d1117',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#e6edf3',
              padding: 12,
              usePointStyle: true
            }
          },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.label}: ${ctx.parsed} MB`
            }
          }
        }
      }
    });
    return () => {
      if (vmChartInstance.current) {
        vmChartInstance.current.destroy();
        vmChartInstance.current = null;
      }
    };
  }, [vmStats, activeTab]);

  // Top Memory chart
  useEffect(() => {
    if (memChartInstance.current) {
      memChartInstance.current.destroy();
      memChartInstance.current = null;
    }
    if (!memChartRef.current || topMemory.length === 0 || activeTab !== 'memory') return;
    memChartInstance.current = new Chart(memChartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: topMemory.map(p => p.name),
        datasets: [{
          label: 'Footprint (KB)',
          data: topMemory.map(p => p.footprint),
          backgroundColor: '#58a6ff',
          borderRadius: 4
        }, {
          label: 'Peak (KB)',
          data: topMemory.map(p => p.footprintPeak),
          backgroundColor: '#30363d',
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: '#e6edf3',
              usePointStyle: true,
              padding: 12
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: '#30363d',
              drawBorder: false
            },
            ticks: {
              color: '#8b949e',
              callback: v => v >= 1024 ? (v / 1024).toFixed(0) + ' MB' : v + ' KB'
            }
          },
          y: {
            grid: {
              display: false
            },
            ticks: {
              color: '#e6edf3',
              font: {
                size: 11
              }
            }
          }
        }
      }
    });
    return () => {
      if (memChartInstance.current) {
        memChartInstance.current.destroy();
        memChartInstance.current = null;
      }
    };
  }, [topMemory, activeTab]);

  // Top CPU chart
  useEffect(() => {
    if (cpuChartInstance.current) {
      cpuChartInstance.current.destroy();
      cpuChartInstance.current = null;
    }
    if (!cpuChartRef.current || topCpu.length === 0 || activeTab !== 'cpu') return;
    cpuChartInstance.current = new Chart(cpuChartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: topCpu.map(p => p.name),
        datasets: [{
          label: '%CPU',
          data: topCpu.map(p => p.cpu),
          backgroundColor: '#f85149',
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: '#e6edf3',
              usePointStyle: true,
              padding: 12
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: '#30363d',
              drawBorder: false
            },
            ticks: {
              color: '#8b949e',
              callback: v => v + '%'
            }
          },
          y: {
            grid: {
              display: false
            },
            ticks: {
              color: '#e6edf3',
              font: {
                size: 11
              }
            }
          }
        }
      }
    });
    return () => {
      if (cpuChartInstance.current) {
        cpuChartInstance.current.destroy();
        cpuChartInstance.current = null;
      }
    };
  }, [topCpu, activeTab]);
  const totalMem = vmStats ? vmStats.free + vmStats.active + vmStats.inactive + vmStats.wired + vmStats.compressed + vmStats.purgeable + vmStats.speculative : 0;
  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tab-bar"
  }, ['overview', 'memory', 'cpu'].map(tab => /*#__PURE__*/React.createElement("div", {
    key: tab,
    className: `tab ${activeTab === tab ? 'active' : ''}`,
    onClick: () => setActiveTab(tab)
  }, tab === 'overview' ? 'Memory Overview' : tab === 'memory' ? 'Top Memory (Jetsam)' : 'Top CPU (ps)'))), activeTab === 'overview' && vmStats && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '12px',
      marginBottom: '16px'
    }
  }, [{
    label: 'Total',
    value: totalMem + ' MB',
    color: '#e6edf3'
  }, {
    label: 'Free',
    value: vmStats.free + ' MB',
    color: '#3fb950'
  }, {
    label: 'Active',
    value: vmStats.active + ' MB',
    color: '#58a6ff'
  }, {
    label: 'Wired',
    value: vmStats.wired + ' MB',
    color: '#f85149'
  }, {
    label: 'Compressed',
    value: vmStats.compressed + ' MB',
    color: '#d29922'
  }, {
    label: 'Inactive',
    value: vmStats.inactive + ' MB',
    color: '#8b949e'
  }].map(s => /*#__PURE__*/React.createElement("div", {
    key: s.label,
    style: {
      padding: '8px 14px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px',
      minWidth: '100px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#8b949e',
      marginBottom: '2px'
    }
  }, s.label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '16px',
      fontWeight: 600,
      color: s.color
    }
  }, s.value)))), /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: '300px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: vmChartRef
  }))), activeTab === 'memory' && /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: Math.max(400, topMemory.length * 28) + 'px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: memChartRef
  })), activeTab === 'cpu' && /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: Math.max(400, topCpu.length * 28) + 'px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: cpuChartRef
  })), /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}

// ===== CRASHES & DIAGNOSTICS DASHBOARD =====

// ============================================================================
// CrashDetailView - Enhanced crash .ips file parser and viewer
// Supports JSON + header-line fallback, all-threads view, exception codes,
// coalition info, and plaintext .ips fallback parsing
// ============================================================================
function CrashDetailView({ fileData, crashInfo }) {
  const [detail, setDetail] = useState(null);
  const [showAllThreads, setShowAllThreads] = useState(false);

  useEffect(() => {
    if (!fileData) { setDetail(null); return; }
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const buf = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : fileData;
      const text = decoder.decode(buf);
      const parsed: any = {};

      // Try JSON parse (most IPS files are JSON or have JSON after a header line)
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // Some .ips files have a header line then JSON
        const nlIdx = text.indexOf('\n');
        if (nlIdx > 0) {
          try { json = JSON.parse(text.substring(nlIdx + 1)); } catch (_2) {}
        }
      }

      if (json) {
        parsed.exception_type = (json.exception && json.exception.type) || '';
        parsed.exception_subtype = (json.exception && json.exception.subtype) || '';
        parsed.exception_message = (json.exception && json.exception.message) || '';
        parsed.exception_codes = (json.exception && json.exception.codes) || '';
        parsed.termination_reason = (json.termination && json.termination.reason) || '';
        parsed.termination_namespace = (json.termination && json.termination.namespace) || '';
        parsed.faulting_thread = json.faultingThread !== undefined ? json.faultingThread : '';
        parsed.bug_type = json.bug_type || '';
        parsed.process = json.procName || json.processName || '';
        parsed.pid = json.pid || '';
        parsed.os_version = json.osVersion || '';
        parsed.incident_id = json.incident || '';
        parsed.hardware_model = json.modelCode || '';
        parsed.parentProcess = json.parentProc || '';
        parsed.coalitionName = json.coalitionName || '';

        // Extract all thread stack traces
        parsed.threads = [];
        if (json.threads && Array.isArray(json.threads)) {
          json.threads.forEach((thread, idx) => {
            parsed.threads.push({
              index: idx,
              name: thread.name || ('Thread ' + idx),
              triggered: thread.triggered || false,
              isFaulting: idx === json.faultingThread,
              frames: (thread.frames || []).map(fr => ({
                imageOffset: fr.imageOffset,
                imageName: fr.imageName || '',
                symbol: fr.symbol || '',
                symbolLocation: fr.symbolLocation || 0,
                address: fr.address || ''
              }))
            });
          });
        }

        // Extract faulting thread frames separately for easy access
        if (json.threads && json.threads[json.faultingThread]) {
          const thread = json.threads[json.faultingThread];
          parsed.thread_name = thread.name || ('Thread ' + json.faultingThread);
          parsed.frames = (thread.frames || []).map(fr => ({
            imageOffset: fr.imageOffset,
            imageName: fr.imageName || '',
            symbol: fr.symbol || '',
            symbolLocation: fr.symbolLocation || 0,
            address: fr.address || ''
          }));
        } else {
          parsed.frames = [];
        }
      } else {
        // Fallback: regex parse for non-JSON .ips files
        parsed.exception_type = '';
        parsed.termination_reason = '';
        parsed.process = crashInfo ? crashInfo.process : '';
        parsed.frames = [];
        parsed.threads = [];

        // Try to extract crashed thread dump text
        const threadMatch = text.match(/Thread \d+[^\n]*Crashed[^\n]*:\n([\s\S]{0,5000}?)(?:\nThread \d|\n\n)/);
        if (threadMatch) {
          parsed.raw_stack = threadMatch[1];
        }

        // Try to extract exception info from plaintext
        const excMatch = text.match(/Exception Type:\s*(.+)/);
        if (excMatch) parsed.exception_type = excMatch[1].trim();
        const termMatch = text.match(/Termination Reason:\s*(.+)/);
        if (termMatch) parsed.termination_reason = termMatch[1].trim();
        const trigMatch = text.match(/Triggered by Thread:\s*(\d+)/);
        if (trigMatch) parsed.faulting_thread = parseInt(trigMatch[1], 10);
      }

      setDetail(parsed);
    } catch (e) {
      setDetail({ error: e.message });
    }
  }, [fileData, crashInfo]);

  if (!detail) {
    return <div style={{ textAlign: 'center', padding: '48px 16px', color: '#6e7681', fontSize: '13px' }}>
      Select a crash report from the list to view details
    </div>;
  }

  if (detail.error) {
    return <div style={{ color: '#f85149', fontSize: '12px' }}>Error parsing crash: {detail.error}</div>;
  }

  return (
    <div>
      {/* Process header */}
      <div style={{ marginBottom: '12px', fontSize: '14px', fontWeight: 600, color: '#e6edf3' }}>
        {detail.process || (crashInfo && crashInfo.process)}
        {detail.pid && <span style={{ fontSize: '12px', color: '#8b949e', marginLeft: '8px' }}>PID {detail.pid}</span>}
      </div>

      {/* Metadata cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        {detail.exception_type && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Exception Type</div>
            <div style={{ fontSize: '13px', color: '#f85149', fontWeight: 600 }}>{detail.exception_type}</div>
          </div>
        )}
        {detail.exception_subtype && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Exception Subtype</div>
            <div style={{ fontSize: '13px', color: '#d29922', fontWeight: 600 }}>{detail.exception_subtype}</div>
          </div>
        )}
        {detail.exception_codes && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Exception Codes</div>
            <div style={{ fontSize: '13px', color: '#f778ba', fontWeight: 600, fontFamily: 'monospace' }}>{detail.exception_codes}</div>
          </div>
        )}
        {detail.termination_reason && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Termination Reason</div>
            <div style={{ fontSize: '13px', color: '#bc8cff', fontWeight: 600 }}>{detail.termination_reason}</div>
          </div>
        )}
        {detail.termination_namespace && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Namespace</div>
            <div style={{ fontSize: '13px', color: '#58a6ff', fontWeight: 600 }}>{detail.termination_namespace}</div>
          </div>
        )}
        {detail.faulting_thread !== '' && detail.faulting_thread !== undefined && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Faulting Thread</div>
            <div style={{ fontSize: '13px', color: '#3fb950', fontWeight: 600 }}>{detail.faulting_thread}</div>
          </div>
        )}
        {detail.bug_type && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Bug Type</div>
            <div style={{ fontSize: '13px', color: '#e6edf3', fontWeight: 600 }}>{BUG_TYPE_MAP[detail.bug_type] || detail.bug_type}</div>
          </div>
        )}
        {detail.os_version && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>OS Version</div>
            <div style={{ fontSize: '13px', color: '#8b949e', fontWeight: 600 }}>{detail.os_version}</div>
          </div>
        )}
        {detail.coalitionName && (
          <div style={{ padding: '6px 12px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' }}>
            <div style={{ fontSize: '10px', color: '#8b949e' }}>Coalition</div>
            <div style={{ fontSize: '13px', color: '#8b949e', fontWeight: 600 }}>{detail.coalitionName}</div>
          </div>
        )}
      </div>

      {/* Exception message */}
      {detail.exception_message && (
        <div style={{ ...chartPanelStyle, marginBottom: '12px' }}>
          <div style={chartPanelHeaderStyle}><span>Exception Message</span></div>
          <pre style={{ fontFamily: 'monospace', fontSize: '11px', color: '#f85149', whiteSpace: 'pre-wrap', margin: 0 }}>
            {detail.exception_message}
          </pre>
        </div>
      )}

      {/* Faulting thread stack trace */}
      {detail.frames && detail.frames.length > 0 && (
        <div style={{ ...chartPanelStyle, maxHeight: '400px', overflowY: 'auto', marginBottom: '12px' }}>
          <div style={chartPanelHeaderStyle}>
            <span>Stack Trace{detail.thread_name ? ' (' + detail.thread_name + ')' : ''}</span>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: '11px', lineHeight: '1.6' }}>
            {detail.frames.map((fr, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', padding: '2px 0', borderBottom: '1px solid #21262d' }}>
                <span style={{ color: '#6e7681', minWidth: '24px', textAlign: 'right' }}>{i}</span>
                <span style={{ color: '#58a6ff', minWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fr.imageName}</span>
                <span style={{ color: fr.symbol ? '#e6edf3' : '#6e7681', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fr.symbol ? fr.symbol + ' + ' + fr.symbolLocation : '0x' + (fr.imageOffset || 0).toString(16)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All threads toggle */}
      {detail.threads && detail.threads.length > 1 && (
        <div style={{ marginBottom: '12px' }}>
          <button
            className={'time-button ' + (showAllThreads ? 'active' : '')}
            onClick={() => setShowAllThreads(!showAllThreads)}
            style={{ fontSize: '11px' }}
          >
            {showAllThreads ? 'Hide' : 'Show'} All Threads ({detail.threads.length})
          </button>
          {showAllThreads && detail.threads.map((thread, tidx) => (
            <div key={tidx} style={{ ...chartPanelStyle, marginTop: '8px', maxHeight: '300px', overflowY: 'auto' }}>
              <div style={chartPanelHeaderStyle}>
                <span style={{ color: thread.isFaulting ? '#f85149' : '#e6edf3' }}>
                  {thread.name}{thread.isFaulting ? ' (Crashed)' : ''}
                </span>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '11px', lineHeight: '1.6' }}>
                {thread.frames.slice(0, 20).map((fr, i) => (
                  <div key={i} style={{ display: 'flex', gap: '8px', padding: '1px 0' }}>
                    <span style={{ color: '#6e7681', minWidth: '24px', textAlign: 'right' }}>{i}</span>
                    <span style={{ color: '#58a6ff', minWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fr.imageName}</span>
                    <span style={{ color: fr.symbol ? '#e6edf3' : '#6e7681', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {fr.symbol ? fr.symbol + ' + ' + fr.symbolLocation : '0x' + (fr.imageOffset || 0).toString(16)}
                    </span>
                  </div>
                ))}
                {thread.frames.length > 20 && (
                  <div style={{ color: '#6e7681', fontSize: '11px', padding: '4px 0' }}>... {thread.frames.length - 20} more frames</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Raw stack trace fallback for non-JSON */}
      {detail.raw_stack && (
        <div style={{ ...chartPanelStyle, maxHeight: '350px', overflowY: 'auto' }}>
          <div style={chartPanelHeaderStyle}><span>Stack Trace (Crashed Thread)</span></div>
          <pre style={{ fontFamily: 'monospace', fontSize: '11px', color: '#e6edf3', whiteSpace: 'pre-wrap', margin: 0 }}>
            {detail.raw_stack}
          </pre>
        </div>
      )}
    </div>
  );
}

function CrashesDashboard({
  files,
  sectionFiles
}) {
  const [crashes, setCrashes] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [selectedCrash, setSelectedCrash] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  useEffect(() => {
    const parsed = sectionFiles.map(f => {
      const basename = f.name.replace('crashes_and_spins/', '');
      // Parse: ProcessName-YYYY-MM-DD-HHMMSS.ips or Type_Process-date.ips
      const match = basename.match(/^(.+?)[-_](\d{4}-\d{2}-\d{2})[-_](\d{6})?\.ips$/);
      let process = basename,
        date = '',
        type = 'unknown';
      if (match) {
        const raw = match[1];
        date = match[2] + (match[3] ? ' ' + match[3].replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3') : '');
        // Detect type from name patterns
        if (raw.includes('.cpu_resource')) {
          type = 'CPU Resource';
          process = raw.replace('.cpu_resource', '');
        } else if (raw.includes('.diskwrites_resource')) {
          type = 'Disk Writes';
          process = raw.replace('.diskwrites_resource', '');
        } else if (raw.startsWith('ExcUserFault_')) {
          type = 'User Fault';
          process = raw.replace('ExcUserFault_', '');
        } else if (raw.startsWith('JetsamEvent')) {
          type = 'Jetsam';
          process = 'System';
        } else if (raw.startsWith('LowBatteryLog')) {
          type = 'Low Battery';
          process = 'System';
        } else if (raw.startsWith('WiFiLQM')) {
          type = 'WiFi Metrics';
          process = 'WiFi';
        } else {
          type = 'Crash';
          process = raw;
        }
      }
      return {
        name: f.name,
        basename,
        process,
        date,
        type,
        size: f.size
      };
    });
    setCrashes(parsed.sort((a, b) => b.date.localeCompare(a.date)));
  }, [sectionFiles]);

  // Type breakdown chart
  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }
    if (!chartRef.current || crashes.length === 0 || activeTab !== 'summary') return;
    const typeCounts = {};
    crashes.forEach(c => {
      typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
    });
    const labels = Object.keys(typeCounts).sort((a, b) => typeCounts[b] - typeCounts[a]);
    const data = labels.map(l => typeCounts[l]);
    const colors = ['#f85149', '#58a6ff', '#d29922', '#3fb950', '#bc8cff', '#f778ba', '#6e7681', '#e6edf3'];
    chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors.slice(0, labels.length),
          borderColor: '#0d1117',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#e6edf3',
              padding: 12,
              usePointStyle: true
            }
          }
        }
      }
    });
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [crashes, activeTab]);
  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tab-bar"
  }, ['summary', 'timeline', 'detail'].map(tab => /*#__PURE__*/React.createElement("div", {
    key: tab,
    className: `tab ${activeTab === tab ? 'active' : ''}`,
    onClick: () => setActiveTab(tab)
  }, tab === 'summary' ? 'Event Summary' : tab === 'timeline' ? 'Event Timeline' : 'Crash Detail'))), activeTab === 'summary' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '12px',
      marginBottom: '16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 14px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#8b949e'
    }
  }, "Total Events"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '20px',
      fontWeight: 600,
      color: '#f85149'
    }
  }, crashes.length)), Object.entries(crashes.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]).map(([type, count]) => /*#__PURE__*/React.createElement("div", {
    key: type,
    style: {
      padding: '8px 14px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#8b949e'
    }
  }, type), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '16px',
      fontWeight: 600,
      color: '#e6edf3'
    }
  }, count)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '16px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: '250px',
      flex: '1 1 300px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: chartRef
  })), (() => {
    const processCounts = {};
    crashes.forEach(c => {
      if (c.process && c.process !== 'System' && c.process !== 'WiFi') {
        processCounts[c.process] = (processCounts[c.process] || 0) + 1;
      }
    });
    const topProcs = Object.entries(processCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (topProcs.length === 0) return null;
    const maxCount = topProcs[0][1];
    return /*#__PURE__*/React.createElement("div", {
      style: {
        flex: '1 1 280px',
        minWidth: '250px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '13px',
        fontWeight: 600,
        color: '#e6edf3',
        marginBottom: '12px'
      }
    }, "Top Crash Sources"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      }
    }, topProcs.map(([proc, count]) => /*#__PURE__*/React.createElement("div", {
      key: proc,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        fontSize: '12px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#e6edf3',
        minWidth: '120px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
        maxWidth: '180px'
      },
      title: proc
    }, proc), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        height: '8px',
        backgroundColor: '#21262d',
        borderRadius: '4px',
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${count / maxCount * 100}%`,
        height: '100%',
        backgroundColor: count >= 5 ? '#f85149' : count >= 3 ? '#d29922' : '#58a6ff',
        borderRadius: '4px',
        transition: 'width 0.4s ease-out'
      }
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        color: count >= 5 ? '#f85149' : count >= 3 ? '#d29922' : '#8b949e',
        fontWeight: 600,
        minWidth: '20px',
        textAlign: 'right'
      }
    }, count)))));
  })())), activeTab === 'timeline' && /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: '500px',
      overflowY: 'auto'
    }
  }, crashes.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '8px 12px',
      borderBottom: '1px solid #21262d',
      fontSize: '13px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      padding: '2px 8px',
      borderRadius: '12px',
      fontSize: '11px',
      fontWeight: 600,
      backgroundColor: c.type === 'Crash' ? '#f8514922' : c.type === 'Jetsam' ? '#d2992222' : '#58a6ff22',
      color: c.type === 'Crash' ? '#f85149' : c.type === 'Jetsam' ? '#d29922' : '#58a6ff',
      whiteSpace: 'nowrap'
    }
  }, c.type), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      color: '#e6edf3',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, c.process), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#8b949e',
      fontSize: '12px',
      whiteSpace: 'nowrap'
    }
  }, c.date), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6e7681',
      fontSize: '11px'
    }
  }, formatBytes(c.size))))),
  activeTab === 'detail' && /*#__PURE__*/React.createElement("div", null,
    /*#__PURE__*/React.createElement("div", {
      style: { display: 'flex', gap: '12px', flexWrap: 'wrap' }
    },
      /*#__PURE__*/React.createElement("div", {
        style: { width: '280px', maxHeight: '500px', overflowY: 'auto', flexShrink: 0 }
      }, crashes.filter(c => c.basename.endsWith('.ips')).map((c, i) => /*#__PURE__*/React.createElement("div", {
        key: i,
        onClick: () => {
          setSelectedCrash(c);
        },
        style: {
          padding: '6px 10px',
          borderBottom: '1px solid #21262d',
          cursor: 'pointer',
          fontSize: '12px',
          backgroundColor: selectedCrash && selectedCrash.name === c.name ? '#1f2937' : 'transparent',
          borderLeft: selectedCrash && selectedCrash.name === c.name ? '2px solid #58a6ff' : '2px solid transparent'
        }
      },
        /*#__PURE__*/React.createElement("div", { style: { color: '#e6edf3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.process),
        /*#__PURE__*/React.createElement("div", { style: { color: '#8b949e', fontSize: '11px' } }, c.type, ' ', c.date)
      ))),
      /*#__PURE__*/React.createElement("div", {
        style: { flex: 1, minWidth: 0 }
      }, /*#__PURE__*/React.createElement(CrashDetailView, {
        fileData: selectedCrash ? (sectionFiles.find(f => f.name === selectedCrash.name) || {}).data : null,
        crashInfo: selectedCrash
      }))
    )
  ),
  /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}

// ===== STORAGE DASHBOARD =====
function StorageDashboard({
  files,
  sectionFiles
}) {
  const [diskInfo, setDiskInfo] = useState([]);
  const [mountInfo, setMountInfo] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  useEffect(() => {
    const decoder = new TextDecoder('utf-8', {
      fatal: false
    });
    const decode = f => {
      const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
      return decoder.decode(buf);
    };
    const disksFile = files.find(f => f.name === 'disks.txt' && f.data);
    if (disksFile) {
      const text = decode(disksFile);
      const lines = text.trim().split('\n');
      if (lines.length > 1) {
        const parsed = lines.slice(1).map(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 9) {
            return {
              filesystem: parts[0].length > 30 ? '...' + parts[0].slice(-25) : parts[0],
              size: parts[1],
              used: parts[2],
              avail: parts[3],
              capacity: parts[4],
              mounted: parts[parts.length - 1]
            };
          }
          return null;
        }).filter(Boolean);
        setDiskInfo(parsed);
      }
    }
    const mountFile = files.find(f => f.name === 'mount.txt' && f.data);
    if (mountFile) {
      const text = decode(mountFile);
      const mounts = text.trim().split('\n').map(line => {
        const m = line.match(/^(.+?) on (.+?) \((.+?)\)$/);
        if (m) {
          const flags = m[3].split(', ');
          return {
            device: m[1].length > 30 ? '...' + m[1].slice(-25) : m[1],
            mountPoint: m[2],
            fsType: flags[0],
            flags: flags.slice(1)
          };
        }
        return null;
      }).filter(Boolean);
      setMountInfo(mounts);
    }
  }, [files]);

  // Disk usage chart
  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }
    if (!chartRef.current || diskInfo.length === 0) return;
    const mainDisks = diskInfo.filter(d => d.mounted === '/' || d.mounted.startsWith('/private'));
    const labels = mainDisks.map(d => d.mounted);
    const capacities = mainDisks.map(d => parseInt(d.capacity) || 0);
    const colors = capacities.map(c => c > 90 ? '#f85149' : c > 70 ? '#d29922' : '#3fb950');
    chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Capacity %',
          data: capacities,
          backgroundColor: colors,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            max: 100,
            grid: {
              color: '#30363d'
            },
            ticks: {
              color: '#8b949e',
              callback: v => v + '%'
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: '#e6edf3',
              font: {
                size: 10
              },
              maxRotation: 45
            }
          }
        }
      }
    });
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [diskInfo]);
  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, diskInfo.length > 0 && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '13px',
      fontWeight: 600,
      color: '#e6edf3',
      marginBottom: '12px'
    }
  }, "Disk Usage"), /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: '200px',
      marginBottom: '16px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: chartRef
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      fontSize: '12px',
      borderCollapse: 'collapse'
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      borderBottom: '1px solid #30363d'
    }
  }, ['Mount', 'Size', 'Used', 'Avail', 'Capacity'].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    style: {
      padding: '6px 8px',
      textAlign: 'left',
      color: '#8b949e',
      fontWeight: 500
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, diskInfo.map((d, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    style: {
      borderBottom: '1px solid #21262d'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 8px',
      color: '#e6edf3',
      fontFamily: 'monospace'
    }
  }, d.mounted), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 8px',
      color: '#8b949e'
    }
  }, d.size), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 8px',
      color: '#8b949e'
    }
  }, d.used), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 8px',
      color: '#8b949e'
    }
  }, d.avail), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 8px',
      color: parseInt(d.capacity) > 90 ? '#f85149' : '#e6edf3'
    }
  }, d.capacity))))))), mountInfo.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: '16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '13px',
      fontWeight: 600,
      color: '#e6edf3',
      marginBottom: '12px'
    }
  }, "Mount Points (", mountInfo.length, ")"), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: '300px',
      overflowY: 'auto'
    }
  }, mountInfo.map((m, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      gap: '12px',
      padding: '6px 8px',
      borderBottom: '1px solid #21262d',
      fontSize: '12px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#58a6ff',
      fontFamily: 'monospace',
      minWidth: '150px'
    }
  }, m.mountPoint), /*#__PURE__*/React.createElement("span", {
    style: {
      padding: '1px 6px',
      borderRadius: '8px',
      backgroundColor: '#21262d',
      color: '#8b949e',
      fontSize: '11px'
    }
  }, m.fsType), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6e7681',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, m.flags.join(', ')))))), /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}


// ===== POWERLOG EXTENDED QUERIES DASHBOARD =====
function PowerLogDashboard({ files, sectionFiles }) {
  const [db, setDb] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState(null);
  const [tables, setTables] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [customSql, setCustomSql] = useState('');
  const [queryResult, setQueryResult] = useState(null);
  const [queryError, setQueryError] = useState(null);
  const [sortCol, setSortCol] = useState(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [activeTab, setActiveTab] = useState('query');
  const [selectedFile, setSelectedFile] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const PRESETS = [{ label: 'Display Brightness History', sql: "SELECT timestamp, Level as brightness FROM PLDisplayAgent_EventPoint_Display ORDER BY timestamp ASC LIMIT 2000" }, { label: 'App Usage Timeline', sql: "SELECT timestamp, BundleID as app, ScreenOn FROM PLApplicationAgent_EventForward_Application ORDER BY timestamp DESC LIMIT 500" }, { label: 'Network Activity', sql: "SELECT timestamp, RxBytes, TxBytes, DataConnectionType as type FROM PLNetworkAgent_EventPoint_NetworkInOut ORDER BY timestamp DESC LIMIT 1000" }, { label: 'Location Usage', sql: "SELECT timestamp, Client, Type, Accuracy FROM PLLocationAgent_EventForward_ClientStatus ORDER BY timestamp DESC LIMIT 500" }, { label: 'Battery Level Over Time', sql: "SELECT timestamp, Level, InstantAmperage, Voltage, Temperature FROM PLBatteryAgent_EventBackward_Battery ORDER BY timestamp ASC LIMIT 2000" }, { label: 'All Tables', sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" }];
  useEffect(() => { let database = null; (async () => { try { const plsqlFile = files.find(f => (f.name.endsWith('.PLSQL') || f.name.endsWith('.EPSQL')) && f.data); if (!plsqlFile) { setDbError('No PowerLog database found. PLSQL data may have been freed from memory - try reloading the archive.'); setDbLoading(false); return; } const SQL = await getSqlJs(); const buf = plsqlFile.data instanceof ArrayBuffer ? new Uint8Array(plsqlFile.data) : plsqlFile.data; database = new SQL.Database(buf); setDb(database); const res = database.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"); if (res.length > 0) setTables(res[0].values.map(r => r[0])); setDbLoading(false); } catch (e) { console.error('PowerLog DB error:', e); setDbError('Failed to open PowerLog database: ' + e.message); setDbLoading(false); } })(); return () => { if (database) try { database.close(); } catch (_) {} }; }, [files]);
  const runQuery = (sql) => { if (!db || !sql.trim()) return; setQueryError(null); setQueryResult(null); setSortCol(null); try { const results = db.exec(sql); if (results.length === 0) { setQueryResult({ columns: [], rows: [] }); } else { const cols = results[0].columns; const rows = results[0].values.map(row => { const obj = {}; cols.forEach((c, i) => { let val = row[i]; if (c === 'timestamp' && typeof val === 'number' && val > 1e9 && val < 2e10) { obj[c + '_raw'] = val; val = new Date(val * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''); } obj[c] = val; }); return obj; }); setQueryResult({ columns: cols, rows: rows }); } } catch (e) { setQueryError(e.message); } };
  const handlePresetChange = (idx) => { if (idx === '') { setSelectedPreset(''); return; } setSelectedPreset(idx); setCustomSql(PRESETS[idx].sql); runQuery(PRESETS[idx].sql); };
  const sortedRows = useMemo(() => { if (!queryResult || !queryResult.rows.length || sortCol === null) return queryResult ? queryResult.rows : []; const col = queryResult.columns[sortCol]; return [...queryResult.rows].sort((a, b) => { const va = a[col], vb = b[col]; if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va; return sortAsc ? String(va != null ? va : '').localeCompare(String(vb != null ? vb : '')) : String(vb != null ? vb : '').localeCompare(String(va != null ? va : '')); }); }, [queryResult, sortCol, sortAsc]);
  useEffect(() => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } if (!chartRef.current || !queryResult || queryResult.rows.length === 0 || activeTab !== 'chart') return; if (!queryResult.columns.includes('timestamp')) return; const numCols = queryResult.columns.filter(c => c !== 'timestamp' && c !== 'timestamp_raw' && queryResult.rows.some(r => typeof r[c] === 'number')); if (!numCols.length) return; const pal = ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#f778ba']; chartInstance.current = new Chart(chartRef.current.getContext('2d'), { type: 'line', data: { datasets: numCols.slice(0, 6).map((col, i) => ({ label: col, data: queryResult.rows.map(r => ({ x: r.timestamp_raw ? new Date(r.timestamp_raw * 1000) : new Date(r.timestamp), y: r[col] })), borderColor: pal[i % pal.length], backgroundColor: pal[i % pal.length] + '33', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.2 })) }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: '#e6edf3', usePointStyle: true, padding: 12 } }, zoom: chartZoomOptions }, scales: { x: { type: 'time', grid: { color: '#30363d' }, ticks: { color: '#8b949e', maxTicksLimit: 10 } }, y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e' } } } } }); return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } }; }, [queryResult, activeTab]);
  if (dbLoading) return React.createElement("div", { className: "dashboard-container" }, React.createElement("div", { style: { textAlign: 'center', padding: '32px', color: '#8b949e' } }, "Loading PowerLog database..."));
  if (dbError) return React.createElement("div", { className: "dashboard-container" }, React.createElement("div", { style: { textAlign: 'center', padding: '32px', color: '#8b949e' } }, React.createElement("div", { style: { fontSize: '32px', marginBottom: '12px', opacity: 0.5 } }, "\uD83D\uDD0C"), React.createElement("div", { style: { fontSize: '14px', color: '#d29922', marginBottom: '8px' } }, dbError)), React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
  const showChart = queryResult && queryResult.columns.includes('timestamp') && queryResult.columns.some(c => c !== 'timestamp' && c !== 'timestamp_raw' && queryResult.rows.some(r => typeof r[c] === 'number'));
  return React.createElement("div", { className: "dashboard-container" }, React.createElement("div", { style: { marginBottom: '12px' } }, React.createElement("div", { style: { fontSize: '13px', fontWeight: 600, color: '#e6edf3', marginBottom: '8px' } }, "PowerLog SQL Explorer", tables.length > 0 && React.createElement("span", { style: { fontWeight: 400, color: '#8b949e', marginLeft: '8px' } }, tables.length + " tables")), React.createElement("div", { style: { display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' } }, React.createElement("select", { value: selectedPreset, onChange: function(e) { handlePresetChange(e.target.value); }, style: { padding: '6px 10px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '6px', color: '#e6edf3', fontSize: '12px' } }, React.createElement("option", { value: '' }, "Select a preset query..."), PRESETS.map(function(p, i) { return React.createElement("option", { key: i, value: i }, p.label); }))), React.createElement("div", { style: { display: 'flex', gap: '8px' } }, React.createElement("textarea", { value: customSql, onChange: function(e) { setCustomSql(e.target.value); }, onKeyDown: function(e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runQuery(customSql); }, placeholder: "Enter SQL query... (Ctrl+Enter to run)", style: { flex: 1, padding: '8px', backgroundColor: '#0d1117', border: '1px solid #30363d', borderRadius: '6px', color: '#e6edf3', fontSize: '12px', fontFamily: 'monospace', minHeight: '60px', resize: 'vertical' } }), React.createElement("button", { onClick: function() { runQuery(customSql); }, style: { padding: '8px 16px', backgroundColor: '#238636', border: 'none', borderRadius: '6px', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' } }, "Run"))), queryError && React.createElement("div", { style: { padding: '8px 12px', backgroundColor: '#f8514922', border: '1px solid #f85149', borderRadius: '6px', color: '#f85149', fontSize: '12px', marginBottom: '12px', fontFamily: 'monospace' } }, queryError), queryResult && React.createElement("div", null, showChart && React.createElement("div", { className: "tab-bar", style: { marginBottom: '12px' } }, ['query', 'chart'].map(function(t) { return React.createElement("div", { key: t, className: "tab " + (activeTab === t ? 'active' : ''), onClick: function() { setActiveTab(t); } }, t === 'query' ? 'Table Results' : 'Time Series Chart'); })), activeTab === 'chart' && showChart && React.createElement("div", { className: "chart-container", style: { height: '300px', marginBottom: '16px' } }, React.createElement("canvas", { ref: chartRef })), (activeTab === 'query' || !showChart) && React.createElement("div", null, React.createElement("div", { style: { fontSize: '12px', color: '#8b949e', marginBottom: '8px' } }, queryResult.rows.length + " rows"), queryResult.rows.length > 0 && React.createElement("div", { style: { overflowX: 'auto', maxHeight: '400px', overflowY: 'auto' } }, React.createElement("table", { style: { width: '100%', fontSize: '11px', borderCollapse: 'collapse' } }, React.createElement("thead", null, React.createElement("tr", { style: { borderBottom: '1px solid #30363d', position: 'sticky', top: 0, backgroundColor: '#0d1117', zIndex: 1 } }, queryResult.columns.filter(function(c) { return !c.endsWith('_raw'); }).map(function(col, i) { return React.createElement("th", { key: col, onClick: function() { if (sortCol === i) setSortAsc(!sortAsc); else { setSortCol(i); setSortAsc(true); } }, style: { padding: '6px 8px', textAlign: 'left', color: '#8b949e', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' } }, col, sortCol === i ? (sortAsc ? ' \u25B2' : ' \u25BC') : ''); }))), React.createElement("tbody", null, sortedRows.slice(0, 500).map(function(row, ri) { return React.createElement("tr", { key: ri, style: { borderBottom: '1px solid #21262d' } }, queryResult.columns.filter(function(c) { return !c.endsWith('_raw'); }).map(function(col) { return React.createElement("td", { key: col, style: { padding: '4px 8px', color: '#e6edf3', fontFamily: typeof row[col] === 'number' ? 'monospace' : 'inherit', whiteSpace: 'nowrap' } }, row[col] != null ? String(row[col]) : ''); })); })))), queryResult.rows.length > 500 && React.createElement("div", { style: { fontSize: '11px', color: '#8b949e', marginTop: '8px' } }, "Showing first 500 of " + queryResult.rows.length + " rows"))), React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

// ===== PROCESS RESOURCE ANALYSIS DASHBOARD =====
function ProcessDashboard({ files, sectionFiles }) {
  const [processes, setProcesses] = useState([]);
  const [sortCol, setSortCol] = useState('cpuTotal');
  const [sortAsc, setSortAsc] = useState(false);
  const [activeTab, setActiveTab] = useState('table');
  const [selectedFile, setSelectedFile] = useState(null);
  const cpuChartRef = useRef(null); const cpuChartInstance = useRef(null);
  const memChartRef = useRef(null); const memChartInstance = useRef(null);
  useEffect(() => { const decoder = new TextDecoder('utf-8', { fatal: false }); const decode = f => { const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data; return decoder.decode(buf); }; const taskFile = files.find(f => f.name.includes('taskinfo') && f.data); if (!taskFile) return; const text = decode(taskFile); const lines = text.split('\n'); const procs = []; let cur = null; for (let i = 0; i < lines.length; i++) { const line = lines[i]; const pm = line.match(/^proc\s+\d+:\s+(.+?)\s+\[pid\s+(\d+)/); if (pm) { if (cur) procs.push(cur); cur = { name: pm[1], pid: parseInt(pm[2]), cpuUser: 0, cpuSystem: 0, cpuTotal: 0, residentMem: 0, virtualMem: 0, threads: 0 }; continue; } if (!cur) continue; const cm = line.match(/user\s+time:\s+([\d.]+)s.*system\s+time:\s+([\d.]+)s/); if (cm) { cur.cpuUser = parseFloat(cm[1]) || 0; cur.cpuSystem = parseFloat(cm[2]) || 0; cur.cpuTotal = cur.cpuUser + cur.cpuSystem; } const rm = line.match(/resident\s+size:\s+([\d]+)/i); if (rm) cur.residentMem = parseInt(rm[1]) || 0; const vm2 = line.match(/virtual\s+size:\s+([\d]+)/i); if (vm2) cur.virtualMem = parseInt(vm2[1]) || 0; const tm = line.match(/(\d+)\s+threads/); if (tm) cur.threads = parseInt(tm[1]) || 0; } if (cur) procs.push(cur); setProcesses(procs); }, [files]);
  const sorted = useMemo(() => { if (!processes.length) return []; return [...processes].sort((a, b) => { const va = a[sortCol], vb = b[sortCol]; if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va; return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va)); }); }, [processes, sortCol, sortAsc]);
  const top20Cpu = useMemo(() => [...processes].sort((a, b) => b.cpuTotal - a.cpuTotal).slice(0, 20), [processes]);
  const top20Mem = useMemo(() => [...processes].sort((a, b) => b.residentMem - a.residentMem).slice(0, 20), [processes]);
  useEffect(() => { if (cpuChartInstance.current) { cpuChartInstance.current.destroy(); cpuChartInstance.current = null; } if (!cpuChartRef.current || !top20Cpu.length || activeTab !== 'cpu') return; cpuChartInstance.current = new Chart(cpuChartRef.current.getContext('2d'), { type: 'bar', data: { labels: top20Cpu.map(p => p.name), datasets: [{ label: 'User (s)', data: top20Cpu.map(p => p.cpuUser), backgroundColor: '#58a6ff', borderRadius: 4 }, { label: 'System (s)', data: top20Cpu.map(p => p.cpuSystem), backgroundColor: '#f85149', borderRadius: 4 }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e6edf3', usePointStyle: true, padding: 12 } } }, scales: { x: { stacked: true, grid: { color: '#30363d' }, ticks: { color: '#8b949e', callback: v => v.toFixed(1) + 's' } }, y: { stacked: true, grid: { display: false }, ticks: { color: '#e6edf3', font: { size: 11 } } } } } }); return () => { if (cpuChartInstance.current) { cpuChartInstance.current.destroy(); cpuChartInstance.current = null; } }; }, [top20Cpu, activeTab]);
  useEffect(() => { if (memChartInstance.current) { memChartInstance.current.destroy(); memChartInstance.current = null; } if (!memChartRef.current || !top20Mem.length || activeTab !== 'memory') return; memChartInstance.current = new Chart(memChartRef.current.getContext('2d'), { type: 'bar', data: { labels: top20Mem.map(p => p.name), datasets: [{ label: 'Resident Memory', data: top20Mem.map(p => p.residentMem), backgroundColor: '#3fb950', borderRadius: 4 }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e6edf3', usePointStyle: true, padding: 12 } } }, scales: { x: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', callback: v => formatBytes(v) } }, y: { grid: { display: false }, ticks: { color: '#e6edf3', font: { size: 11 } } } } } }); return () => { if (memChartInstance.current) { memChartInstance.current.destroy(); memChartInstance.current = null; } }; }, [top20Mem, activeTab]);
  const pcols = [{ key: 'name', label: 'Process' }, { key: 'pid', label: 'PID' }, { key: 'cpuTotal', label: 'CPU Total (s)' }, { key: 'cpuUser', label: 'User (s)' }, { key: 'cpuSystem', label: 'System (s)' }, { key: 'residentMem', label: 'Resident Mem' }, { key: 'virtualMem', label: 'Virtual Mem' }, { key: 'threads', label: 'Threads' }];
  return React.createElement("div", { className: "dashboard-container" },
    React.createElement("div", { className: "tab-bar" }, ['table', 'cpu', 'memory'].map(tab => React.createElement("div", { key: tab, className: "tab " + (activeTab === tab ? 'active' : ''), onClick: () => setActiveTab(tab) }, tab === 'table' ? 'Process Table (' + processes.length + ')' : tab === 'cpu' ? 'Top 20 CPU' : 'Top 20 Memory'))),
    activeTab === 'table' && React.createElement("div", { style: { overflowX: 'auto', maxHeight: '500px', overflowY: 'auto' } }, processes.length === 0 ? React.createElement("div", { style: { textAlign: 'center', padding: '32px', color: '#8b949e' } }, "No process data found in taskinfo files") : React.createElement("table", { style: { width: '100%', fontSize: '11px', borderCollapse: 'collapse' } }, React.createElement("thead", null, React.createElement("tr", { style: { borderBottom: '1px solid #30363d', position: 'sticky', top: 0, backgroundColor: '#0d1117', zIndex: 1 } }, pcols.map(c => React.createElement("th", { key: c.key, onClick: () => { if (sortCol === c.key) setSortAsc(!sortAsc); else { setSortCol(c.key); setSortAsc(c.key === 'name'); } }, style: { padding: '6px 8px', textAlign: 'left', color: '#8b949e', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' } }, c.label, sortCol === c.key ? (sortAsc ? ' \u25B2' : ' \u25BC') : '')))), React.createElement("tbody", null, sorted.map((p, i) => React.createElement("tr", { key: i, style: { borderBottom: '1px solid #21262d' } }, React.createElement("td", { style: { padding: '4px 8px', color: '#e6edf3', fontFamily: 'monospace' } }, p.name), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontFamily: 'monospace' } }, p.pid), React.createElement("td", { style: { padding: '4px 8px', color: '#58a6ff', fontFamily: 'monospace' } }, p.cpuTotal.toFixed(3)), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontFamily: 'monospace' } }, p.cpuUser.toFixed(3)), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontFamily: 'monospace' } }, p.cpuSystem.toFixed(3)), React.createElement("td", { style: { padding: '4px 8px', color: '#3fb950', fontFamily: 'monospace' } }, formatBytes(p.residentMem)), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontFamily: 'monospace' } }, formatBytes(p.virtualMem)), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontFamily: 'monospace' } }, p.threads)))))),
    activeTab === 'cpu' && React.createElement("div", { className: "chart-container", style: { height: Math.max(400, top20Cpu.length * 28) + 'px' } }, React.createElement("canvas", { ref: cpuChartRef })),
    activeTab === 'memory' && React.createElement("div", { className: "chart-container", style: { height: Math.max(400, top20Mem.length * 28) + 'px' } }, React.createElement("canvas", { ref: memChartRef })),
    React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

// ===== NETWORKING DASHBOARD =====
function NetworkDashboard({ files, sectionFiles }) {
  const [interfaces, setInterfaces] = useState([]);
  const [connections, setConnections] = useState([]);
  const [connFilter, setConnFilter] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [activeTab, setActiveTab] = useState('interfaces');
  useEffect(() => { const decoder = new TextDecoder('utf-8', { fatal: false }); const decode = f => { const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data; return decoder.decode(buf); }; const ifconfigFile = files.find(f => f.name.includes('ifconfig') && f.isFile && f.data); if (ifconfigFile) { const text = decode(ifconfigFile); const blocks = text.split(/^(?=\S)/m).filter(b => b.trim()); const ifaces = []; blocks.forEach(block => { const lines = block.split('\n'); const hm = lines[0].match(/^(\S+):\s+flags=(\d+)<([^>]*)>/); if (!hm) return; const iface = { name: hm[1], flags: hm[3], ips: [], packets: { rx: 0, tx: 0 }, errors: { rx: 0, tx: 0 }, bytes: { rx: 0, tx: 0 } }; lines.forEach(line => { const im = line.match(/inet[6]?\s+(\S+)/); if (im) iface.ips.push(im[1]); const inM = line.match(/(\d+)\s+packets\s+input/); if (inM) iface.packets.rx = parseInt(inM[1]); const outM = line.match(/(\d+)\s+packets\s+output/); if (outM) iface.packets.tx = parseInt(outM[1]); const ieM = line.match(/(\d+)\s+input\s+errors/); if (ieM) iface.errors.rx = parseInt(ieM[1]); const oeM = line.match(/(\d+)\s+output\s+errors/); if (oeM) iface.errors.tx = parseInt(oeM[1]); const ibM = line.match(/(\d+)\s+bytes\s+input/); if (ibM) iface.bytes.rx = parseInt(ibM[1]); const obM = line.match(/(\d+)\s+bytes\s+output/); if (obM) iface.bytes.tx = parseInt(obM[1]); }); ifaces.push(iface); }); setInterfaces(ifaces); } const netstatFile = files.find(f => f.name.includes('netstat') && f.isFile && f.data); if (netstatFile) { const text = decode(netstatFile); const lines = text.split('\n'); const conns = []; let started = false; for (const line of lines) { if (line.match(/^(Proto|Active)\s/i)) { started = true; continue; } if (!started || !line.trim()) continue; const parts = line.trim().split(/\s+/); if (parts.length >= 4) { const proto = parts[0]; if (['tcp','tcp4','tcp6','tcp46','udp','udp4','udp6','udp46'].includes(proto.toLowerCase())) { conns.push({ proto, local: parts[3] || '', remote: parts[4] || '', state: parts[5] || '' }); } } } setConnections(conns); } }, [files]);
  const filteredConns = useMemo(() => { if (!connFilter) return connections; const f = connFilter.toLowerCase(); return connections.filter(c => c.proto.toLowerCase().includes(f) || c.local.toLowerCase().includes(f) || c.remote.toLowerCase().includes(f) || c.state.toLowerCase().includes(f)); }, [connections, connFilter]);
  const activeIfaces = interfaces.filter(i => i.packets.rx > 0 || i.packets.tx > 0 || i.ips.length > 0);
  const stateSummary = useMemo(() => { const counts = {}; connections.forEach(c => { const s = c.state || 'N/A'; counts[s] = (counts[s] || 0) + 1; }); return Object.entries(counts).sort((a, b) => b[1] - a[1]); }, [connections]);
  return React.createElement("div", { className: "dashboard-container" },
    React.createElement("div", { className: "tab-bar" }, ['interfaces', 'connections'].map(tab => React.createElement("div", { key: tab, className: "tab " + (activeTab === tab ? 'active' : ''), onClick: () => setActiveTab(tab) }, tab === 'interfaces' ? 'Interfaces (' + interfaces.length + ')' : 'Connections (' + connections.length + ')'))),
    activeTab === 'interfaces' && React.createElement("div", null, interfaces.length === 0 ? React.createElement("div", { style: { textAlign: 'center', padding: '32px', color: '#8b949e' } }, "No interface data found") : React.createElement("div", null, activeIfaces.length > 0 && React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } }, activeIfaces.slice(0, 8).map(iface => React.createElement("div", { key: iface.name, style: { padding: '10px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', minWidth: '180px', flex: '1 1 200px' } }, React.createElement("div", { style: { fontSize: '14px', fontWeight: 600, color: '#58a6ff', marginBottom: '4px' } }, iface.name), iface.ips.map((ip, j) => React.createElement("div", { key: j, style: { fontSize: '11px', color: '#e6edf3', fontFamily: 'monospace' } }, ip)), React.createElement("div", { style: { display: 'flex', gap: '12px', marginTop: '6px', fontSize: '11px' } }, React.createElement("span", { style: { color: '#3fb950' } }, "\u2191 " + formatBytes(iface.bytes.tx)), React.createElement("span", { style: { color: '#58a6ff' } }, "\u2193 " + formatBytes(iface.bytes.rx))), (iface.errors.rx > 0 || iface.errors.tx > 0) && React.createElement("div", { style: { fontSize: '11px', color: '#f85149', marginTop: '4px' } }, "Errors: RX " + iface.errors.rx + " / TX " + iface.errors.tx)))), React.createElement("div", { style: { overflowX: 'auto' } }, React.createElement("table", { style: { width: '100%', fontSize: '11px', borderCollapse: 'collapse' } }, React.createElement("thead", null, React.createElement("tr", { style: { borderBottom: '1px solid #30363d' } }, ['Interface', 'IPs', 'Flags', 'RX Pkts', 'TX Pkts', 'RX Bytes', 'TX Bytes', 'Errors'].map(h => React.createElement("th", { key: h, style: { padding: '6px 8px', textAlign: 'left', color: '#8b949e', fontWeight: 500, whiteSpace: 'nowrap' } }, h)))), React.createElement("tbody", null, interfaces.map((iface, i) => React.createElement("tr", { key: i, style: { borderBottom: '1px solid #21262d' } }, React.createElement("td", { style: { padding: '4px 8px', color: '#58a6ff', fontFamily: 'monospace', fontWeight: 500 } }, iface.name), React.createElement("td", { style: { padding: '4px 8px', color: '#e6edf3', fontFamily: 'monospace', fontSize: '10px' } }, iface.ips.join(', ') || '-'), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontSize: '10px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' } }, iface.flags), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontFamily: 'monospace' } }, iface.packets.rx.toLocaleString()), React.createElement("td", { style: { padding: '4px 8px', color: '#8b949e', fontFamily: 'monospace' } }, iface.packets.tx.toLocaleString()), React.createElement("td", { style: { padding: '4px 8px', color: '#3fb950', fontFamily: 'monospace' } }, formatBytes(iface.bytes.rx)), React.createElement("td", { style: { padding: '4px 8px', color: '#3fb950', fontFamily: 'monospace' } }, formatBytes(iface.bytes.tx)), React.createElement("td", { style: { padding: '4px 8px', color: (iface.errors.rx + iface.errors.tx) > 0 ? '#f85149' : '#8b949e', fontFamily: 'monospace' } }, (iface.errors.rx + iface.errors.tx) > 0 ? iface.errors.rx + '/' + iface.errors.tx : '-')))))))),
    activeTab === 'connections' && React.createElement("div", null, connections.length === 0 ? React.createElement("div", { style: { textAlign: 'center', padding: '32px', color: '#8b949e' } }, "No connection data found") : React.createElement("div", null, React.createElement("div", { style: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' } }, React.createElement("input", { type: "text", value: connFilter, onChange: e => setConnFilter(e.target.value), placeholder: "Filter by protocol, address, state...", style: { padding: '6px 10px', backgroundColor: '#0d1117', border: '1px solid #30363d', borderRadius: '6px', color: '#e6edf3', fontSize: '12px', flex: '1 1 200px', maxWidth: '300px' } }), stateSummary.slice(0, 5).map(function(entry) { return React.createElement("span", { key: entry[0], onClick: function() { setConnFilter(entry[0]); }, style: { padding: '2px 8px', borderRadius: '10px', backgroundColor: '#21262d', color: '#8b949e', fontSize: '11px', cursor: 'pointer' } }, entry[0] + ": " + entry[1]); })), React.createElement("div", { style: { overflowX: 'auto', maxHeight: '400px', overflowY: 'auto' } }, React.createElement("table", { style: { width: '100%', fontSize: '11px', borderCollapse: 'collapse' } }, React.createElement("thead", null, React.createElement("tr", { style: { borderBottom: '1px solid #30363d', position: 'sticky', top: 0, backgroundColor: '#0d1117', zIndex: 1 } }, ['Protocol', 'Local Address', 'Remote Address', 'State'].map(h => React.createElement("th", { key: h, style: { padding: '6px 8px', textAlign: 'left', color: '#8b949e', fontWeight: 500 } }, h)))), React.createElement("tbody", null, filteredConns.slice(0, 500).map((c, i) => React.createElement("tr", { key: i, style: { borderBottom: '1px solid #21262d' } }, React.createElement("td", { style: { padding: '4px 8px', color: '#bc8cff', fontFamily: 'monospace' } }, c.proto), React.createElement("td", { style: { padding: '4px 8px', color: '#e6edf3', fontFamily: 'monospace', fontSize: '10px' } }, c.local), React.createElement("td", { style: { padding: '4px 8px', color: '#e6edf3', fontFamily: 'monospace', fontSize: '10px' } }, c.remote), React.createElement("td", { style: { padding: '4px 8px', color: c.state === 'ESTABLISHED' ? '#3fb950' : c.state === 'LISTEN' ? '#58a6ff' : '#8b949e' } }, c.state)))))), filteredConns.length > 500 && React.createElement("div", { style: { fontSize: '11px', color: '#8b949e', marginTop: '8px' } }, "Showing first 500 of " + filteredConns.length + " connections"))),
    React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

// ===== GENERIC FILE EXPLORER DASHBOARD =====
// For sections that are primarily log/config files, show grouped by subdirectory with size breakdown
function FileExplorerDashboard({
  sectionFiles,
  title
}) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [groups, setGroups] = useState([]);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  useEffect(() => {
    // Group files by first directory level
    const groupMap = {};
    sectionFiles.forEach(f => {
      const parts = f.name.split('/');
      const group = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
      if (!groupMap[group]) groupMap[group] = {
        name: group,
        files: [],
        totalSize: 0
      };
      groupMap[group].files.push(f);
      groupMap[group].totalSize += f.size;
    });
    setGroups(Object.values(groupMap).sort((a, b) => b.totalSize - a.totalSize));
  }, [sectionFiles]);

  // Size breakdown chart
  useEffect(() => {
    if (!chartRef.current || groups.length === 0) return;
    if (chartInstance.current) chartInstance.current.destroy();
    const top = groups.slice(0, 10);
    const colors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#f778ba', '#6e7681', '#e6edf3', '#8b949e', '#388bfd'];
    chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top.map(g => g.name.split('/').pop()),
        datasets: [{
          label: 'Size',
          data: top.map(g => g.totalSize),
          backgroundColor: colors.slice(0, top.length),
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          x: {
            grid: {
              color: '#30363d'
            },
            ticks: {
              color: '#8b949e',
              callback: v => formatBytes(v)
            }
          },
          y: {
            grid: {
              display: false
            },
            ticks: {
              color: '#e6edf3',
              font: {
                size: 11
              }
            }
          }
        }
      }
    });
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [groups]);
  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '12px',
      marginBottom: '16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 14px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#8b949e'
    }
  }, "Total Files"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '18px',
      fontWeight: 600,
      color: '#e6edf3'
    }
  }, sectionFiles.length)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 14px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#8b949e'
    }
  }, "Total Size"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '18px',
      fontWeight: 600,
      color: '#58a6ff'
    }
  }, formatBytes(sectionFiles.reduce((s, f) => s + f.size, 0)))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 14px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#8b949e'
    }
  }, "Groups"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '18px',
      fontWeight: 600,
      color: '#3fb950'
    }
  }, groups.length))), groups.length > 1 && /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: Math.max(200, Math.min(groups.length, 10) * 28) + 'px',
      marginBottom: '16px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: chartRef
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: '400px',
      overflowY: 'auto'
    }
  }, groups.map((g, gi) => /*#__PURE__*/React.createElement("div", {
    key: gi,
    style: {
      marginBottom: '4px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: '6px 10px',
      backgroundColor: '#161b22',
      borderRadius: '6px',
      fontSize: '12px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#58a6ff',
      fontFamily: 'monospace'
    }
  }, g.name), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#8b949e'
    }
  }, g.files.length, " file", g.files.length !== 1 ? 's' : '', " \xB7 ", formatBytes(g.totalSize)))))), /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}

// ===== UNIFIED LOG CORRELATION DASHBOARD =====
const CORR_METRICS = [{
  key: 'soc',
  label: 'State of Charge %',
  field: 'StateOfCharge',
  source: 'sbc',
  transform: v => parseFloat(v),
  yAxisID: 'y-pct',
  color: '#58a6ff'
}, {
  key: 'temp',
  label: 'Temperature °C',
  field: 'Temperature',
  source: 'sbc',
  transform: v => parseFloat(v) / 100,
  yAxisID: 'y-temp',
  color: '#3fb950'
}, {
  key: 'voltage',
  label: 'Voltage (V)',
  field: 'Voltage',
  source: 'sbc',
  transform: v => parseFloat(v) / 1000,
  yAxisID: 'y-volt',
  color: '#d29922'
}, {
  key: 'amperage',
  label: 'Amperage (mA)',
  field: 'Amperage',
  source: 'sbc',
  transform: v => parseFloat(v),
  yAxisID: 'y-amp',
  color: '#f778ba'
}, {
  key: 'watts',
  label: 'Power (W)',
  field: 'Watts',
  source: 'sbc',
  transform: v => parseFloat(v),
  yAxisID: 'y-power',
  color: '#79c0ff'
}, {
  key: 'capacity',
  label: 'Current Capacity %',
  field: 'CurrentCapacity',
  source: 'sbc',
  transform: v => parseFloat(v),
  yAxisID: 'y-pct',
  color: '#bc8cff'
}, {
  key: 'maxcap',
  label: 'Max Capacity %',
  field: 'MaxCapacityPercent',
  source: 'daily',
  transform: v => parseFloat(v),
  yAxisID: 'y-pct',
  color: '#388bfd'
}, {
  key: 'cycles',
  label: 'Cycle Count',
  field: 'CycleCount',
  source: 'daily',
  transform: v => parseFloat(v),
  yAxisID: 'y-count',
  color: '#e6edf3'
}];
const CORR_EVENT_TYPES = [{
  type: 'CPU Resource',
  color: '#f85149',
  short: 'CPU'
}, {
  type: 'User Fault',
  color: '#58a6ff',
  short: 'Fault'
}, {
  type: 'Jetsam',
  color: '#3fb950',
  short: 'Jetsam'
}, {
  type: 'Disk Writes',
  color: '#d29922',
  short: 'Disk'
}, {
  type: 'Low Battery',
  color: '#f78166',
  short: 'LowBat'
}, {
  type: 'WiFi Metrics',
  color: '#a5d6ff',
  short: 'WiFi'
}, {
  type: 'Crash',
  color: '#bc8cff',
  short: 'Crash'
}];

// Apple does not publish an official bug_type reference.
// Codes marked * confirmed from actual sysdiagnose files; others are community-sourced.
const BUG_TYPE_MAP = {
  // Crashes
  '109': 'Crash (SIGABRT)',
  '119': 'Crash (SIGTERM)',
  '127': 'Crash (Watchdog SIGTERM)',
  '128': 'Crash (SIGKILL)',
  '131': 'Crash (Memory Limit)',
  '132': 'Bad Memory Access',
  '133': 'Bad Instruction',
  '134': 'Arithmetic Error',
  '137': 'Breakpoint',
  '198': 'Crash (Thermal SIGTERM)',
  '209': 'Crash (Memory Pressure)',
  '211': 'Crash (Watchdog SIGKILL)',
  '309': 'Guard Exception',
  '327': 'Bad Memory Access (ObjC)',
  '385': 'Crash (SIGABRT)',
  // Resource limits
  '145': 'Disk Writes Limit',
  '155': 'Hang / ANR',
  '202': 'CPU Limit',
  '206': 'Wakeup Limit',
  '288': 'Wakeup Limit',
  // System events
  '120': 'Low Battery',
  '298': 'Jetsam / OOM Kill'
};
function extractIpsDetail(fileData, type) {
  if (!fileData) return '';
  try {
    const decoder = new TextDecoder('utf-8', {
      fatal: false
    });
    const buf = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : fileData;
    const text = decoder.decode(buf.slice(0, 131072));
    const grab = key => {
      const m = text.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]+)"'));
      return m ? m[1] : '';
    };
    const bugType = grab('bug_type');
    const bugLabel = bugType ? BUG_TYPE_MAP[bugType] || 'bug_type ' + bugType : '';
    let detail = '';
    if (type === 'CPU Resource') {
      const m = text.match(/CPU:\s*(.+)/);
      if (bugLabel) detail = bugLabel + '\n';
      if (m) detail += m[1].trim();
    } else if (type === 'Disk Writes') {
      const m = text.match(/Writes:\s*(.+)/);
      if (bugLabel) detail = bugLabel + '\n';
      if (m) detail += m[1].trim();
    } else if (type === 'Jetsam') {
      const largest = grab('largestProcess');
      const reasons = [...text.matchAll(/"reason"\s*:\s*"([^"]+)"/g)].map(m => m[1]).filter(r => r !== 'long-idle-exit');
      if (bugLabel) detail = bugLabel;
      if (largest) detail += (detail ? '\nlargest: ' : 'largest: ') + largest;
      if (reasons.length) detail += (detail ? '\nreason: ' : 'reason: ') + reasons[0];
    } else {
      const excTypeM = text.match(/"exception"\s*:\s*\{[\s\S]{0,300}?"type"\s*:\s*"([^"]+)"/);
      const excSubM = text.match(/"exception"\s*:\s*\{[\s\S]{0,300}?"subtype"\s*:\s*"([^"]+)"/);
      const excMsgM = text.match(/"exception"\s*:\s*\{[\s\S]{0,300}?"message"\s*:\s*"([^"]+)"/);
      const termNSM = text.match(/"termination"\s*:\s*\{[\s\S]{0,300}?"namespace"\s*:\s*"([^"]+)"/);
      const notesM = text.match(/"reportNotes"\s*:\s*\[\s*"([^"]+)"/);
      const excType2 = excTypeM ? excTypeM[1] : '';
      const subtype = excSubM ? excSubM[1] : '';
      const termNS = termNSM ? termNSM[1] : '';
      if (bugLabel) detail = bugLabel;
      if (excType2 && excType2 !== bugLabel) detail += (detail ? '\n' : '') + excType2;
      if (subtype && subtype !== excType2) detail += (detail ? ' · ' : '') + subtype;
      if (termNS && termNS !== 'SIGNAL') detail += (detail ? '\nterminated by: ' : 'terminated by: ') + termNS;
      if (notesM && !detail.includes(notesM[1])) detail += (detail ? '\n' : '') + notesM[1];
      if (!detail && excMsgM) detail = excMsgM[1].slice(0, 80);
    }
    return detail;
  } catch (_) {
    return '';
  }
}
function groupEventMarkers(events) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
  const result = [];
  let i = 0;
  while (i < sorted.length) {
    const groupStartMs = new Date(sorted[i].TimeStamp).getTime();
    const group = [];
    let j = i;
    while (j < sorted.length && new Date(sorted[j].TimeStamp).getTime() - groupStartMs <= 60000) {
      group.push(sorted[j]);
      j++;
    }
    const MAX_VIS = 5;
    group.forEach((ev, idx) => {
      if (idx < MAX_VIS) {
        result.push({
          ...ev,
          offsetPx: idx * 8
        });
      } else if (idx === MAX_VIS) {
        result.push({
          ...ev,
          offsetPx: idx * 8,
          collapsedCount: group.length - MAX_VIS,
          collapsedEvents: group.slice(MAX_VIS)
        });
      }
    });
    i = j;
  }
  return result;
}
function UnifiedLogDashboard({
  allFiles,
  sectionFiles
}) {
  const mobile = useIsMobile();
  const [sbcData, setSbcData] = useState([]);
  const [dailyData, setDailyData] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedMetrics, setSelectedMetrics] = useState(new Set(['soc']));
  const [selectedEventTypes, setSelectedEventTypes] = useState(new Set(['Crash']));
  const [timeRange, setTimeRange] = useState('3d');
  const [refDate, setRefDate] = useState('');
  const [hoveredMarker, setHoveredMarker] = useState(null);
  const [hoveredDetail, setHoveredDetail] = useState('');
  const detailCache = useRef(new Map());
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const chartContainerRef = useRef(null);
  const markersRef = useRef([]);

  // Parse data from allFiles
  useEffect(() => {
    try {
      const safeDecodeFile = f => {
        const decoder = new TextDecoder('utf-8', {
          fatal: false
        });
        const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
        return decoder.decode(buf);
      };

      // SBC data
      const sbcFiles = allFiles.filter(f => f.name.includes('BDC_SBC_') && f.name.endsWith('.csv') && f.data);
      const sbcMap = new Map();
      sbcFiles.forEach(f => {
        parseCSV(safeDecodeFile(f)).forEach(row => {
          if (row.TimeStamp) sbcMap.set(row.TimeStamp, row);
        });
      });
      const sortedSbc = Array.from(sbcMap.values()).sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
      setSbcData(sortedSbc);

      // Daily data
      const dailyFiles = allFiles.filter(f => f.name.includes('BDC_Daily_') && f.name.endsWith('.csv') && f.data);
      const dailyMap = new Map();
      dailyFiles.forEach(f => {
        parseCSV(safeDecodeFile(f)).forEach(row => {
          if (row.TimeStamp) dailyMap.set(row.TimeStamp, row);
        });
      });
      const sortedDaily = Array.from(dailyMap.values()).sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
      setDailyData(sortedDaily);

      // Crash events
      const crashFiles = allFiles.filter(f => f.name.startsWith('crashes_and_spins/') && f.name.endsWith('.ips'));
      const parsed = crashFiles.map(f => {
        const basename = f.name.replace('crashes_and_spins/', '');
        const match = basename.match(/^(.+?)[-_](\d{4}-\d{2}-\d{2})[-_](\d{6})?\.ips$/);
        let process = basename,
          date = '',
          type = 'unknown';
        if (match) {
          const raw = match[1];
          date = match[2] + (match[3] ? ' ' + match[3].replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3') : '');
          if (raw.includes('.cpu_resource')) {
            type = 'CPU Resource';
            process = raw.replace('.cpu_resource', '');
          } else if (raw.includes('.diskwrites_resource')) {
            type = 'Disk Writes';
            process = raw.replace('.diskwrites_resource', '');
          } else if (raw.startsWith('ExcUserFault_')) {
            type = 'User Fault';
            process = raw.replace('ExcUserFault_', '');
          } else if (raw.startsWith('JetsamEvent')) {
            type = 'Jetsam';
            process = 'System';
          } else if (raw.startsWith('LowBatteryLog')) {
            type = 'Low Battery';
            process = 'System';
          } else if (raw.startsWith('WiFiLQM')) {
            type = 'WiFi Metrics';
            process = 'WiFi';
          } else {
            type = 'Crash';
            process = raw;
          }
        }
        const TimeStamp = date.includes(' ') ? date.replace(' ', 'T') : date;
        const eventDef = CORR_EVENT_TYPES.find(et => et.type === type);
        return {
          name: f.name,
          basename,
          process,
          date,
          TimeStamp,
          type,
          size: f.size,
          color: eventDef?.color || '#8b949e',
          shortLabel: eventDef?.short || type,
          fileData: f.data
        }; // fileData kept for lazy detail lookup
      }).filter(e => e.TimeStamp).sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
      setEvents(parsed);
    } catch (e) {
      console.error('UnifiedLogDashboard parse error:', e);
    }
  }, [allFiles]);

  // Determine which metrics have data
  const hasData = {
    sbc: sbcData.length > 0,
    daily: dailyData.length > 0,
    events: events.length > 0
  };

  // Latest timestamp for refDate hint
  const latestTs = sbcData.length > 0 ? sbcData[sbcData.length - 1].TimeStamp : dailyData.length > 0 ? dailyData[dailyData.length - 1].TimeStamp : events.length > 0 ? events[events.length - 1].TimeStamp : null;

  // Filtered data
  const filteredSbc = useMemo(() => filterByTimeRange(sbcData, timeRange, refDate || null), [sbcData, timeRange, refDate]);
  const filteredDaily = useMemo(() => filterByTimeRange(dailyData, timeRange, refDate || null), [dailyData, timeRange, refDate]);
  const filteredEvents = useMemo(() => filterByTimeRange(events.filter(e => selectedEventTypes.has(e.type)), timeRange, refDate || null), [events, selectedEventTypes, timeRange, refDate]);
  const markers = useMemo(() => groupEventMarkers(filteredEvents), [filteredEvents]);

  // Build and render chart
  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
      chartInstanceRef.current = null;
    }
    const datasets = [];
    const scales = {
      x: {
        type: 'time',
        time: {
          tooltipFormat: 'yyyy-MM-dd HH:mm',
          displayFormats: {
            hour: 'HH:mm',
            day: 'MMM d'
          }
        },
        grid: {
          color: '#30363d',
          drawBorder: false
        },
        ticks: {
          major: {
            enabled: true
          },
          font: ctx => ctx.tick?.major ? {
            weight: 'bold'
          } : {},
          color: ctx => ctx.tick?.major ? '#e6edf3' : '#8b949e'
        }
      }
    };
    const addAxis = (id, position, color, min, max) => {
      scales[id] = {
        type: 'linear',
        position,
        display: false,
        // toggled below
        grid: position === 'left' ? {
          color: '#30363d',
          drawBorder: false
        } : {
          drawOnChartArea: false,
          drawBorder: false
        },
        ticks: {
          color,
          callback: id === 'y-volt' ? v => v + 'V' : undefined
        },
        ...(min !== undefined ? {
          min
        } : {}),
        ...(max !== undefined ? {
          max
        } : {})
      };
    };
    addAxis('y-pct', 'left', '#58a6ff');
    addAxis('y-count', 'left', '#8b949e');
    addAxis('y-temp', 'right', '#3fb950');
    addAxis('y-volt', 'right', '#d29922', 0, 4.7);
    addAxis('y-amp', 'right', '#f778ba');
    addAxis('y-power', 'right', '#79c0ff');
    CORR_METRICS.forEach(m => {
      if (!selectedMetrics.has(m.key)) return;
      const data = m.source === 'sbc' ? filteredSbc : filteredDaily;
      if (!data.length || !hasColumn(data, m.field)) return;
      datasets.push({
        label: m.label,
        data: data.map(row => ({
          x: new Date(row.TimeStamp).getTime(),
          y: m.transform(row[m.field]) || null
        })),
        borderColor: m.color,
        backgroundColor: 'transparent',
        borderWidth: 2,
        yAxisID: m.yAxisID,
        parsing: false,
        tension: 0.1,
        pointRadius: 0
      });
      if (scales[m.yAxisID]) scales[m.yAxisID].display = true;
    });
    if (datasets.length === 0) return;
    markersRef.current = markers;
    try {
      chartInstanceRef.current = new Chart(canvasRef.current.getContext('2d'), {
        type: 'line',
        data: {
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            intersect: false,
            mode: 'index'
          },
          layout: {
            padding: {
              bottom: 32
            }
          },
          plugins: {
            legend: {
              labels: {
                color: '#e6edf3',
                usePointStyle: true,
                padding: 14
              }
            },
            eventMarkers: {
              events: markers
            }
          },
          scales
        }
      });
    } catch (e) {
      console.error('Correlation chart error:', e);
    }
    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [filteredSbc, filteredDaily, markers, selectedMetrics]);

  // Hover handling
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMouseMove = e => {
      const chart = chartInstanceRef.current;
      if (!chart || !chart.chartArea || !chart.scales.x) {
        setHoveredMarker(null);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const ca = chart.chartArea;
      if (mouseX < ca.left - 10 || mouseX > ca.right + 10) {
        setHoveredMarker(null);
        return;
      }
      const allMarkers = markersRef.current;
      const match = allMarkers.find(m => {
        const px = chart.scales.x.getPixelForValue(new Date(m.TimeStamp).getTime()) + (m.offsetPx || 0);
        return Math.abs(px - mouseX) <= 8;
      });
      if (match) {
        const px = chart.scales.x.getPixelForValue(new Date(match.TimeStamp).getTime()) + (match.offsetPx || 0);
        setHoveredMarker({
          ...match,
          pixelX: px,
          chartAreaTop: ca.top
        });
      } else {
        setHoveredMarker(null);
      }
    };
    const handleMouseLeave = () => setHoveredMarker(null);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [markers]); // Re-run when markers change (canvas may not exist on first mount)

  // Lazy detail extraction — look up file data from events state (avoids Chart.js config passthrough)
  useEffect(() => {
    if (!hoveredMarker) {
      setHoveredDetail('');
      return;
    }
    if (hoveredMarker.collapsedCount) {
      setHoveredDetail('');
      return;
    }
    const cacheKey = hoveredMarker.name;
    if (detailCache.current.has(cacheKey)) {
      setHoveredDetail(detailCache.current.get(cacheKey));
      return;
    }
    const src = events.find(e => e.name === cacheKey);
    const detail = extractIpsDetail(src?.fileData, hoveredMarker.type);
    detailCache.current.set(cacheKey, detail);
    setHoveredDetail(detail);
  }, [hoveredMarker, events]);
  const toggleMetric = key => {
    const next = new Set(selectedMetrics);
    next.has(key) ? next.delete(key) : next.add(key);
    setSelectedMetrics(next);
  };
  const toggleEventType = type => {
    const next = new Set(selectedEventTypes);
    next.has(type) ? next.delete(type) : next.add(type);
    setSelectedEventTypes(next);
  };
  const sidebarStyle = mobile ? {
    width: '100%',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: '8px',
    paddingBottom: '8px'
  } : {
    width: '190px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    paddingRight: '12px'
  };
  const panelStyle = {
    backgroundColor: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '8px',
    padding: '10px'
  };
  const panelHeaderStyle = {
    fontSize: '11px',
    fontWeight: 700,
    color: '#8b949e',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '6px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  };
  const linkStyle = {
    color: '#58a6ff',
    cursor: 'pointer',
    fontSize: '10px',
    fontWeight: 400,
    letterSpacing: 0
  };
  const checkRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 0',
    cursor: 'pointer',
    fontSize: '12px',
    color: '#e6edf3'
  };
  const swatchStyle = color => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: color,
    flexShrink: 0
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: mobile ? 'column' : 'row',
      gap: 0,
      minHeight: mobile ? 'auto' : '480px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: sidebarStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: panelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: panelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "\uD83D\uDCC8 Time-Series"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: linkStyle,
    onClick: () => setSelectedMetrics(new Set(CORR_METRICS.filter(m => hasData[m.source]).map(m => m.key)))
  }, "all"), ' · ', /*#__PURE__*/React.createElement("span", {
    style: linkStyle,
    onClick: () => setSelectedMetrics(new Set())
  }, "clear"))), CORR_METRICS.map(m => {
    const available = hasData[m.source];
    return /*#__PURE__*/React.createElement("label", {
      key: m.key,
      style: {
        ...checkRowStyle,
        opacity: available ? 1 : 0.4,
        cursor: available ? 'pointer' : 'default'
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: selectedMetrics.has(m.key),
      disabled: !available,
      onChange: () => available && toggleMetric(m.key),
      style: {
        margin: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: swatchStyle(m.color)
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1
      }
    }, m.label), !available && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '9px',
        color: '#6e7681'
      }
    }, "no data"));
  })), /*#__PURE__*/React.createElement("div", {
    style: panelStyle
  }, /*#__PURE__*/React.createElement("div", {
    style: panelHeaderStyle
  }, /*#__PURE__*/React.createElement("span", null, "\u26A1 Events"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: linkStyle,
    onClick: () => setSelectedEventTypes(new Set(CORR_EVENT_TYPES.map(e => e.type)))
  }, "all"), ' · ', /*#__PURE__*/React.createElement("span", {
    style: linkStyle,
    onClick: () => setSelectedEventTypes(new Set())
  }, "clear"))), !hasData.events ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#6e7681'
    }
  }, "No data available") : CORR_EVENT_TYPES.map(et => /*#__PURE__*/React.createElement("label", {
    key: et.type,
    style: checkRowStyle
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: selectedEventTypes.has(et.type),
    onChange: () => toggleEventType(et.type),
    style: {
      margin: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: swatchStyle(et.color)
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, et.type))))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dashboard-controls",
    style: {
      marginBottom: '10px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "control-group"
  }, /*#__PURE__*/React.createElement("div", {
    className: "control-label"
  }, "Time Range"), /*#__PURE__*/React.createElement("div", {
    className: "button-group"
  }, ['All', '7D', '3D', '1D', '12H'].map(label => /*#__PURE__*/React.createElement("button", {
    key: label,
    className: `time-button ${timeRange === label.toLowerCase() ? 'active' : ''}`,
    onClick: () => setTimeRange(label.toLowerCase())
  }, label)))), /*#__PURE__*/React.createElement("div", {
    className: "control-group"
  }, /*#__PURE__*/React.createElement("div", {
    className: "control-label"
  }, "Reference Date"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "datetime-local",
    value: refDate,
    onChange: e => setRefDate(e.target.value),
    style: {
      backgroundColor: '#21262d',
      border: '1px solid #30363d',
      borderRadius: '6px',
      color: '#e6edf3',
      padding: '4px 8px',
      fontSize: '12px'
    }
  }), !refDate && latestTs && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '11px',
      color: '#8b949e'
    }
  }, "Using latest: ", latestTs.replace('T', ' ').slice(0, 16)), refDate && /*#__PURE__*/React.createElement("button", {
    className: "time-button",
    onClick: () => setRefDate(''),
    style: {
      fontSize: '11px'
    }
  }, "Reset")))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      position: 'relative'
    },
    ref: chartContainerRef
  }, selectedMetrics.size === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: '#8b949e',
      fontSize: '14px'
    }
  }, "Select metrics from the sidebar to begin") : filteredSbc.length === 0 && filteredDaily.length === 0 && selectedMetrics.size > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: '#8b949e',
      fontSize: '14px',
      textAlign: 'center'
    }
  }, "No data in this time range \u2014", /*#__PURE__*/React.createElement("br", null), "try extending the range or adjusting the reference date.") : /*#__PURE__*/React.createElement("div", {
    className: "chart-container",
    style: {
      height: '420px'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef
  })), hoveredMarker && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: Math.min(hoveredMarker.pixelX + 8, (chartContainerRef.current?.offsetWidth || 500) - 180) + 'px',
      top: (hoveredMarker.chartAreaTop || 40) + 'px',
      backgroundColor: 'rgba(0,0,0,0.85)',
      border: 'none',
      borderRadius: '4px',
      padding: '8px 12px',
      fontSize: '13px',
      color: '#ffffff',
      zIndex: 10,
      pointerEvents: 'none',
      maxWidth: '260px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.5)'
    }
  }, hoveredMarker.collapsedCount ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      marginBottom: '6px',
      color: '#fff'
    }
  }, "+", hoveredMarker.collapsedCount, " more events"), (hoveredMarker.collapsedEvents || []).map((ev, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      marginBottom: '4px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: ev.color,
      fontWeight: 600
    }
  }, ev.type), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff'
    }
  }, " ", ev.process), ev.detail && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#ccc',
      marginTop: '1px',
      whiteSpace: 'pre-line'
    }
  }, ev.detail)))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      color: hoveredMarker.color,
      marginBottom: '5px',
      fontSize: '14px'
    }
  }, hoveredMarker.type), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#fff',
      marginBottom: '4px',
      fontWeight: 500
    }
  }, hoveredMarker.process), hoveredDetail && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#ccc',
      marginBottom: '4px',
      whiteSpace: 'pre-line',
      wordBreak: 'break-word'
    }
  }, hoveredDetail), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#aaa'
    }
  }, hoveredMarker.date), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#888',
      marginTop: '2px'
    }
  }, formatBytes(hoveredMarker.size)))))));
}

// ===== DEVICE HEALTH ANALYSIS =====
function analyzeDeviceHealth(files) {
  const findings = [];
  let batteryScore = 100,
    crashScore = 100,
    systemScore = 100;
  const decoder = new TextDecoder('utf-8', {
    fatal: false
  });
  const decodeFile = f => {
    if (!f || !f.data) return '';
    const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    return decoder.decode(buf);
  };
  const dailyFiles = files.filter(f => f.name.includes('BDC_Daily_') && f.name.endsWith('.csv') && f.data);
  let allDailyRows = [];
  dailyFiles.forEach(f => {
    const text = decodeFile(f);
    if (text) allDailyRows = allDailyRows.concat(parseCSV(text));
  });
  const dailyMap = new Map();
  allDailyRows.forEach(row => {
    if (row.TimeStamp) dailyMap.set(row.TimeStamp, row);
  });
  const sortedDaily = Array.from(dailyMap.values()).sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
  if (sortedDaily.length > 0) {
    const latest = sortedDaily[sortedDaily.length - 1];
    const maxCap = parseFloat(latest.MaxCapacityPercent);
    const cycleCount = parseInt(latest.CycleCount);
    const weightedRa = parseFloat(latest.WeightedRa);
    if (!isNaN(maxCap)) {
      if (maxCap <= 80) {
        findings.push({
          severity: 'critical',
          icon: '🔴',
          text: `Battery degraded to ${maxCap}% max capacity`,
          detail: 'Apple recommends replacement below 80%'
        });
        batteryScore -= 40;
      } else if (maxCap <= 85) {
        findings.push({
          severity: 'warning',
          icon: '🟠',
          text: `Battery at ${maxCap}% max capacity`,
          detail: 'Approaching service threshold'
        });
        batteryScore -= 20;
      } else if (maxCap <= 90) {
        findings.push({
          severity: 'info',
          icon: '🟡',
          text: `Battery at ${maxCap}% max capacity`,
          detail: 'Normal wear detected'
        });
        batteryScore -= 10;
      } else {
        findings.push({
          severity: 'good',
          icon: '🟢',
          text: `Battery health at ${maxCap}%`,
          detail: 'Good condition'
        });
      }
    }
    if (!isNaN(cycleCount) && cycleCount > 500) {
      findings.push({
        severity: 'warning',
        icon: '🔄',
        text: `${cycleCount} battery charge cycles`,
        detail: 'High cycle count'
      });
      batteryScore -= 15;
    } else if (!isNaN(cycleCount) && cycleCount > 300) {
      findings.push({
        severity: 'info',
        icon: '🔄',
        text: `${cycleCount} battery charge cycles`,
        detail: 'Moderate usage'
      });
      batteryScore -= 5;
    }
    if (!isNaN(weightedRa) && weightedRa > 150) {
      findings.push({
        severity: 'warning',
        icon: '⚡',
        text: `High battery impedance (${weightedRa} mOhm)`,
        detail: 'May cause unexpected shutdowns'
      });
      batteryScore -= 10;
    }
  }
  const crashFiles = files.filter(f => f.name.startsWith('crashes_and_spins/') && f.isFile && f.name.endsWith('.ips'));
  const crashCount = crashFiles.length;
  const crashTypes = {},
    crashProcesses = {};
  crashFiles.forEach(f => {
    const basename = f.name.replace('crashes_and_spins/', '');
    const match = basename.match(/^(.+?)[-_](\d{4}-\d{2}-\d{2})[-_](\d{6})?\.ips$/);
    if (match) {
      const raw = match[1];
      let type = 'Crash',
        process = raw;
      if (raw.includes('.cpu_resource')) {
        type = 'CPU Resource';
        process = raw.replace('.cpu_resource', '');
      } else if (raw.includes('.diskwrites_resource')) {
        type = 'Disk Writes';
        process = raw.replace('.diskwrites_resource', '');
      } else if (raw.startsWith('ExcUserFault_')) {
        type = 'User Fault';
        process = raw.replace('ExcUserFault_', '');
      } else if (raw.startsWith('JetsamEvent')) {
        type = 'Jetsam';
        process = 'System';
      } else if (raw.startsWith('LowBatteryLog')) {
        type = 'Low Battery';
        process = 'System';
      } else if (raw.startsWith('WiFiLQM')) {
        type = 'WiFi Metrics';
        process = 'WiFi';
      }
      crashTypes[type] = (crashTypes[type] || 0) + 1;
      crashProcesses[process] = (crashProcesses[process] || 0) + 1;
    }
  });
  if (crashCount > 20) {
    findings.push({
      severity: 'critical',
      icon: '💥',
      text: `${crashCount} crash/diagnostic events`,
      detail: 'Significantly above normal'
    });
    crashScore -= 35;
  } else if (crashCount > 10) {
    findings.push({
      severity: 'warning',
      icon: '💥',
      text: `${crashCount} crash/diagnostic events`,
      detail: 'Elevated event count'
    });
    crashScore -= 15;
  } else if (crashCount > 0) {
    findings.push({
      severity: 'info',
      icon: '💥',
      text: `${crashCount} crash/diagnostic event${crashCount > 1 ? 's' : ''}`,
      detail: 'Within normal range'
    });
    crashScore -= 5;
  }
  const jetsamCount = crashTypes['Jetsam'] || 0;
  if (jetsamCount > 5) {
    findings.push({
      severity: 'warning',
      icon: '🧠',
      text: `${jetsamCount} Jetsam (memory pressure) events`,
      detail: 'Frequent memory pressure'
    });
    systemScore -= 15;
  } else if (jetsamCount > 0) {
    findings.push({
      severity: 'info',
      icon: '🧠',
      text: `${jetsamCount} Jetsam event${jetsamCount > 1 ? 's' : ''}`,
      detail: 'Memory pressure detected'
    });
    systemScore -= 5;
  }
  const lowBatCount = crashTypes['Low Battery'] || 0;
  if (lowBatCount > 0) {
    findings.push({
      severity: 'info',
      icon: '🪫',
      text: `${lowBatCount} low battery event${lowBatCount > 1 ? 's' : ''}`,
      detail: 'Reached critically low battery'
    });
    batteryScore -= 5;
  }
  const topProcesses = Object.entries(crashProcesses).filter(([p]) => p !== 'System' && p !== 'WiFi').sort((a, b) => b[1] - a[1]);
  if (topProcesses.length > 0 && topProcesses[0][1] >= 3) {
    findings.push({
      severity: 'warning',
      icon: '🔁',
      text: `${topProcesses[0][0]} crashed ${topProcesses[0][1]} times`,
      detail: 'Repeated crashes'
    });
    crashScore -= 10;
  }
  batteryScore = Math.max(0, batteryScore);
  crashScore = Math.max(0, crashScore);
  systemScore = Math.max(0, systemScore);
  const overall = Math.round(batteryScore * 0.4 + crashScore * 0.35 + systemScore * 0.25);
  let grade, gradeColor, gradeLabel;
  if (overall >= 90) {
    grade = 'A';
    gradeColor = '#3fb950';
    gradeLabel = 'Excellent';
  } else if (overall >= 75) {
    grade = 'B';
    gradeColor = '#58a6ff';
    gradeLabel = 'Good';
  } else if (overall >= 60) {
    grade = 'C';
    gradeColor = '#d29922';
    gradeLabel = 'Fair';
  } else {
    grade = 'D';
    gradeColor = '#f85149';
    gradeLabel = 'Needs Attention';
  }
  const severityOrder = {
    critical: 0,
    warning: 1,
    info: 2,
    good: 3
  };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return {
    grade,
    gradeColor,
    gradeLabel,
    overall,
    batteryScore,
    crashScore,
    systemScore,
    findings: findings.slice(0, 6),
    topCrashProcesses: topProcesses.slice(0, 5),
    crashTypes
  };
}

// ===== DEVICE HEALTH BANNER =====
function DeviceHealthBanner({
  files
}) {
  const [analysis, setAnalysis] = useState(null);
  useEffect(() => {
    try {
      setAnalysis(analyzeDeviceHealth(files));
    } catch (e) {
      console.error('Health analysis error:', e);
    }
  }, [files]);
  if (!analysis) return null;
  const {
    grade,
    gradeColor,
    gradeLabel,
    overall,
    batteryScore,
    crashScore,
    systemScore,
    findings
  } = analysis;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: '20px',
      padding: '20px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '12px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '24px',
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '88px',
      height: '88px',
      borderRadius: '50%',
      border: `3px solid ${gradeColor}`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      background: `radial-gradient(circle, ${gradeColor}15 0%, transparent 70%)`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '36px',
      fontWeight: 700,
      color: gradeColor,
      lineHeight: 1
    }
  }, grade), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '10px',
      color: '#8b949e',
      fontWeight: 500
    }
  }, overall, "/100")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      minWidth: '140px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '15px',
      fontWeight: 600,
      color: gradeColor,
      marginBottom: '2px'
    }
  }, gradeLabel), [{
    label: 'Battery',
    score: batteryScore,
    color: batteryScore >= 80 ? '#3fb950' : batteryScore >= 60 ? '#d29922' : '#f85149'
  }, {
    label: 'Stability',
    score: crashScore,
    color: crashScore >= 80 ? '#3fb950' : crashScore >= 60 ? '#d29922' : '#f85149'
  }, {
    label: 'System',
    score: systemScore,
    color: systemScore >= 80 ? '#3fb950' : systemScore >= 60 ? '#d29922' : '#f85149'
  }].map(s => /*#__PURE__*/React.createElement("div", {
    key: s.label,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '12px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#8b949e',
      width: '52px'
    }
  }, s.label), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: '6px',
      backgroundColor: '#21262d',
      borderRadius: '3px',
      overflow: 'hidden',
      maxWidth: '80px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${s.score}%`,
      height: '100%',
      backgroundColor: s.color,
      borderRadius: '3px',
      transition: 'width 0.6s ease-out'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      color: s.color,
      fontWeight: 500,
      fontSize: '11px',
      width: '28px'
    }
  }, s.score)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: '250px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '12px',
      fontWeight: 600,
      color: '#8b949e',
      marginBottom: '8px',
      textTransform: 'uppercase',
      letterSpacing: '0.5px'
    }
  }, "Key Findings"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px'
    }
  }, findings.map((f, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '8px',
      fontSize: '13px',
      lineHeight: 1.4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flexShrink: 0,
      fontSize: '12px'
    }
  }, f.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      color: f.severity === 'critical' ? '#f85149' : f.severity === 'warning' ? '#d29922' : f.severity === 'good' ? '#3fb950' : '#e6edf3'
    }
  }, f.text, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6e7681',
      fontSize: '12px',
      marginLeft: '6px'
    }
  }, f.detail))))))));
}
// ===== BATTERY DRAIN DASHBOARD (Per-App) =====
function BatteryDrainDashboard({
  files,
  sectionFiles
}) {
  const [appUsage, setAppUsage] = useState([]);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  useEffect(() => {
    try {
      const batteryFiles = files.filter(f =>
        f.data && (f.name.includes('BatteryUI') || f.name.includes('BatteryLife'))
      );
      if (batteryFiles.length === 0) return;
      const apps = [];
      batteryFiles.forEach(f => {
        try {
          const decoder = new TextDecoder('utf-8', { fatal: false });
          const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
          const text = decoder.decode(buf);
          // Parse plist XML for app battery usage entries
          const entryRegex = /<dict>([\s\S]*?)<\/dict>/g;
          let match;
          while ((match = entryRegex.exec(text)) !== null) {
            const block = match[1];
            const getVal = key => {
              const m = block.match(new RegExp('<key>' + key + '</key>\\s*(?:<real>|<integer>|<string>)([^<]+)'));
              return m ? m[1].trim() : '';
            };
            const name = getVal('BundleName') || getVal('Name') || getVal('Identifier') || getVal('BundleID');
            const usage = parseFloat(getVal('Usage')) || parseFloat(getVal('Energy')) || parseFloat(getVal('BatteryUsage')) || 0;
            const screenOn = parseFloat(getVal('ScreenOnTime') || getVal('ForegroundTime')) || 0;
            const screenOff = parseFloat(getVal('ScreenOffTime') || getVal('BackgroundTime')) || 0;
            if (name && usage > 0) {
              apps.push({ name, usage, screenOn, screenOff });
            }
          }
        } catch (e) {
          console.warn('Failed to parse BatteryUI file:', f.name, e);
        }
      });
      // Merge duplicates
      const merged = {};
      apps.forEach(a => {
        if (!merged[a.name]) merged[a.name] = { name: a.name, usage: 0, screenOn: 0, screenOff: 0 };
        merged[a.name].usage += a.usage;
        merged[a.name].screenOn += a.screenOn;
        merged[a.name].screenOff += a.screenOff;
      });
      const sorted = Object.values(merged).sort((a, b) => b.usage - a.usage).slice(0, 20);
      setAppUsage(sorted);
    } catch (e) {
      console.error('Error parsing battery drain data:', e);
    }
  }, [files]);

  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }
    if (!chartRef.current || appUsage.length === 0) return;
    const labels = appUsage.map(a => a.name);
    const data = appUsage.map(a => a.usage);
    const maxUsage = Math.max(...data);
    chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Battery Usage %',
          data,
          backgroundColor: data.map(v => v / maxUsage > 0.7 ? '#f85149' : v / maxUsage > 0.4 ? '#d29922' : '#58a6ff'),
          borderColor: 'transparent',
          borderWidth: 0,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: (ctx) => {
                const app = appUsage[ctx.dataIndex];
                const fmtTime = s => {
                  if (!s) return '0s';
                  const m = Math.floor(s / 60);
                  const sec = Math.floor(s % 60);
                  return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
                };
                return 'Screen On: ' + fmtTime(app.screenOn) + '\nScreen Off: ' + fmtTime(app.screenOff);
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#30363d', drawBorder: false },
            ticks: { color: '#8b949e' },
            title: { display: true, text: 'Usage %', color: '#8b949e' }
          },
          y: {
            grid: { display: false },
            ticks: { color: '#e6edf3', font: { size: 11 } }
          }
        }
      }
    });
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [appUsage]);

  const [selectedFile, setSelectedFile] = useState(null);
  const fmtTime = s => {
    if (!s) return '0s';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, appUsage.length > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null,
    /*#__PURE__*/React.createElement("div", {
      style: { marginBottom: '12px' }
    }, /*#__PURE__*/React.createElement("span", {
      style: { fontSize: '14px', fontWeight: 600, color: '#e6edf3' }
    }, "Per-App Battery Usage"), /*#__PURE__*/React.createElement("span", {
      style: { fontSize: '11px', color: '#484f58', marginLeft: '12px' }
    }, appUsage.length, " apps")),
    /*#__PURE__*/React.createElement("div", {
      className: "chart-container",
      style: { height: Math.max(250, appUsage.length * 28) + 'px' }
    }, /*#__PURE__*/React.createElement("canvas", { ref: chartRef })),
    /*#__PURE__*/React.createElement("div", {
      style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }
    }, appUsage.map((a, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', padding: '4px 8px', borderBottom: '1px solid #21262d' }
    },
      /*#__PURE__*/React.createElement("span", { style: { flex: '1 1 auto', color: '#e6edf3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.name),
      /*#__PURE__*/React.createElement("span", { style: { color: '#58a6ff', fontWeight: 600, minWidth: '50px', textAlign: 'right' } }, a.usage.toFixed(1) + '%'),
      /*#__PURE__*/React.createElement("span", { style: { color: '#8b949e', minWidth: '80px', textAlign: 'right' } }, 'On: ' + fmtTime(a.screenOn)),
      /*#__PURE__*/React.createElement("span", { style: { color: '#6e7681', minWidth: '80px', textAlign: 'right' } }, 'Off: ' + fmtTime(a.screenOff))
    )))
  ) : /*#__PURE__*/React.createElement("div", {
    style: { textAlign: 'center', padding: '32px 16px', color: '#6e7681' }
  }, /*#__PURE__*/React.createElement("div", {
    style: { fontSize: '14px', fontWeight: 500, color: '#8b949e', marginBottom: '4px' }
  }, "No per-app battery data found"), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: '12px' }
  }, "BatteryUI plist files were not found in this archive.")),
  /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}

// ===== BATTERY GAUGE DASHBOARD (IOService) =====
function BatteryGaugeDashboard({
  files,
  sectionFiles
}) {
  const [gaugeData, setGaugeData] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  useEffect(() => {
    try {
      const ioFiles = files.filter(f =>
        f.data && (f.name.includes('IOService') || f.name.includes('ioreg'))
      );
      if (ioFiles.length === 0) return;
      let bestData = null;
      ioFiles.forEach(f => {
        try {
          const decoder = new TextDecoder('utf-8', { fatal: false });
          const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
          const text = decoder.decode(buf);
          const extracted = {};
          const grabInt = key => {
            const m = text.match(new RegExp('"' + key + '"\\s*=\\s*(\\d+)'));
            return m ? parseInt(m[1], 10) : null;
          };
          const grabStr = key => {
            const m = text.match(new RegExp('"' + key + '"\\s*=\\s*"?([^"\\n}]+)"?'));
            return m ? m[1].trim() : null;
          };
          extracted.Qmax = grabInt('Qmax');
          extracted.CycleCount = grabInt('CycleCount');
          extracted.DesignCapacity = grabInt('DesignCapacity');
          extracted.NominalChargeCapacity = grabInt('NominalChargeCapacity');
          extracted.LTQmaxUpdateCounter = grabInt('LTQmaxUpdateCounter');
          extracted.Temperature = grabInt('Temperature');
          extracted.Voltage = grabInt('Voltage');
          extracted.InstantAmperage = grabInt('InstantAmperage');
          extracted.FullyCharged = grabStr('FullyCharged');
          extracted.IsCharging = grabStr('IsCharging');
          extracted.ExternalConnected = grabStr('ExternalConnected');
          // Ra tables - extract if present
          const raMatch = text.match(/"Ra"[^{]*\{([^}]+)\}/);
          if (raMatch) {
            extracted.RaTable = raMatch[1].trim();
          }
          // Check if we got useful data
          const hasData = Object.values(extracted).some(v => v !== null && v !== undefined);
          if (hasData && (!bestData || (extracted.Qmax !== null))) {
            bestData = { ...extracted, source: f.name };
          }
        } catch (e) {
          console.warn('Failed to parse IOService file:', f.name, e);
        }
      });
      if (bestData) setGaugeData(bestData);
    } catch (e) {
      console.error('Error parsing battery gauge data:', e);
    }
  }, [files]);

  const metricCard = (label, value, unit, color) => {
    if (value === null || value === undefined) return null;
    return /*#__PURE__*/React.createElement("div", {
      style: { padding: '10px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', minWidth: '140px' }
    },
      /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e', marginBottom: '4px' } }, label),
      /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: color || '#e6edf3' } },
        typeof value === 'number' ? value.toLocaleString() : value,
        unit ? /*#__PURE__*/React.createElement("span", { style: { fontSize: '12px', color: '#8b949e', marginLeft: '4px' } }, unit) : null
      )
    );
  };

  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, gaugeData ? /*#__PURE__*/React.createElement(React.Fragment, null,
    /*#__PURE__*/React.createElement("div", {
      style: { marginBottom: '16px' }
    }, /*#__PURE__*/React.createElement("span", {
      style: { fontSize: '14px', fontWeight: 600, color: '#e6edf3' }
    }, "Battery Gauge Parameters"), /*#__PURE__*/React.createElement("span", {
      style: { fontSize: '11px', color: '#484f58', marginLeft: '12px' }
    }, "from ", gaugeData.source)),
    /*#__PURE__*/React.createElement("div", {
      style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }
    },
      metricCard('Qmax', gaugeData.Qmax, 'mAh', '#58a6ff'),
      metricCard('Cycle Count', gaugeData.CycleCount, null, '#3fb950'),
      metricCard('Design Capacity', gaugeData.DesignCapacity, 'mAh', '#bc8cff'),
      metricCard('Nominal Charge', gaugeData.NominalChargeCapacity, 'mAh', '#d29922'),
      metricCard('LT Qmax Updates', gaugeData.LTQmaxUpdateCounter, null, '#f778ba'),
      metricCard('Temperature', gaugeData.Temperature !== null ? (gaugeData.Temperature / 100).toFixed(1) : null, '\u00B0C', '#f85149'),
      metricCard('Voltage', gaugeData.Voltage !== null ? (gaugeData.Voltage / 1000).toFixed(3) : null, 'V', '#58a6ff'),
      metricCard('Instant Amperage', gaugeData.InstantAmperage, 'mA', '#d29922')
    ),
    /*#__PURE__*/React.createElement("div", {
      style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }
    },
      gaugeData.FullyCharged !== null && metricCard('Fully Charged', gaugeData.FullyCharged, null, gaugeData.FullyCharged === 'Yes' ? '#3fb950' : '#8b949e'),
      gaugeData.IsCharging !== null && metricCard('Is Charging', gaugeData.IsCharging, null, gaugeData.IsCharging === 'Yes' ? '#3fb950' : '#8b949e'),
      gaugeData.ExternalConnected !== null && metricCard('External Connected', gaugeData.ExternalConnected, null, gaugeData.ExternalConnected === 'Yes' ? '#3fb950' : '#8b949e')
    ),
    gaugeData.RaTable && /*#__PURE__*/React.createElement("div", {
      style: chartPanelStyle
    },
      /*#__PURE__*/React.createElement("div", { style: chartPanelHeaderStyle }, /*#__PURE__*/React.createElement("span", null, "Ra Table")),
      /*#__PURE__*/React.createElement("pre", {
        style: { fontSize: '11px', color: '#e6edf3', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }
      }, gaugeData.RaTable)
    ),
    gaugeData.NominalChargeCapacity && gaugeData.DesignCapacity && /*#__PURE__*/React.createElement("div", {
      style: { ...chartPanelStyle, marginTop: '12px' }
    },
      /*#__PURE__*/React.createElement("div", { style: chartPanelHeaderStyle }, /*#__PURE__*/React.createElement("span", null, "Capacity Health")),
      /*#__PURE__*/React.createElement("div", {
        style: { display: 'flex', alignItems: 'center', gap: '12px' }
      },
        /*#__PURE__*/React.createElement("div", {
          style: { flex: 1, height: '12px', backgroundColor: '#21262d', borderRadius: '6px', overflow: 'hidden' }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            width: Math.min(100, (gaugeData.NominalChargeCapacity / gaugeData.DesignCapacity * 100)) + '%',
            height: '100%',
            backgroundColor: (gaugeData.NominalChargeCapacity / gaugeData.DesignCapacity) > 0.8 ? '#3fb950' : (gaugeData.NominalChargeCapacity / gaugeData.DesignCapacity) > 0.5 ? '#d29922' : '#f85149',
            borderRadius: '6px'
          }
        })),
        /*#__PURE__*/React.createElement("span", {
          style: { fontSize: '14px', fontWeight: 600, color: '#e6edf3', minWidth: '50px' }
        }, (gaugeData.NominalChargeCapacity / gaugeData.DesignCapacity * 100).toFixed(1) + '%')
      )
    )
  ) : /*#__PURE__*/React.createElement("div", {
    style: { textAlign: 'center', padding: '32px 16px', color: '#6e7681' }
  }, /*#__PURE__*/React.createElement("div", {
    style: { fontSize: '14px', fontWeight: 500, color: '#8b949e', marginBottom: '4px' }
  }, "No IOService battery gauge data found"), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: '12px' }
  }, "ioreg or IOService files were not found in this archive.")),
  /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}

// ===== CHARGING BEHAVIOR DASHBOARD =====
function ChargingDashboard({
  files,
  sectionFiles
}) {
  const [chargingData, setChargingData] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const mobile = useIsMobile();
  const [timeRange, setTimeRange] = useState('all');
  useEffect(() => {
    try {
      const obcFiles = files.filter(f =>
        f.data && (f.name.includes('OBC') || f.name.includes('BDC')) && f.name.endsWith('.csv')
      );
      if (obcFiles.length === 0) return;
      let allRows = [];
      obcFiles.forEach(f => {
        try {
          const decoder = new TextDecoder('utf-8', { fatal: false });
          const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
          const text = decoder.decode(buf);
          if (text) {
            const rows = parseCSV(text);
            allRows = allRows.concat(rows);
          }
        } catch (e) {
          console.warn('Failed to parse OBC file:', f.name, e);
        }
      });
      // Deduplicate by timestamp
      const map = new Map();
      allRows.forEach(row => {
        if (row.TimeStamp) map.set(row.TimeStamp, row);
      });
      const sorted = Array.from(map.values()).sort((a, b) => new Date(a.TimeStamp) - new Date(b.TimeStamp));
      setChargingData(sorted);
    } catch (e) {
      console.error('Error parsing charging data:', e);
    }
  }, [files]);

  const TIME_RANGES = ['All', '1M', '2W', '1W'];
  const filteredData = useMemo(() => filterByTimeRange(chargingData, timeRange, null), [chargingData, timeRange]);

  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }
    if (!chartRef.current || filteredData.length === 0) return;
    try {
      const datasets = [];
      // Try common OBC column names
      const colDefs = [
        { col: 'SOC', label: 'State of Charge', color: '#58a6ff', axis: 'y-left' },
        { col: 'StateOfCharge', label: 'State of Charge', color: '#58a6ff', axis: 'y-left' },
        { col: 'Current', label: 'Current (mA)', color: '#3fb950', axis: 'y-right' },
        { col: 'Voltage', label: 'Voltage (mV)', color: '#d29922', axis: 'y-right' },
        { col: 'Temperature', label: 'Temperature', color: '#f85149', axis: 'y-right' },
        { col: 'ChargingCurrent', label: 'Charging Current', color: '#bc8cff', axis: 'y-right' },
        { col: 'ChargingVoltage', label: 'Charging Voltage', color: '#f778ba', axis: 'y-right' }
      ];
      colDefs.forEach(def => {
        if (hasColumn(filteredData, def.col)) {
          datasets.push({
            label: def.label,
            data: filteredData.map(row => ({
              x: new Date(row.TimeStamp).getTime(),
              y: parseFloat(row[def.col]) || null
            })),
            borderColor: def.color,
            backgroundColor: 'transparent',
            borderWidth: 2,
            yAxisID: def.axis,
            parsing: false,
            tension: 0.1,
            pointRadius: 0
          });
        }
      });
      if (datasets.length === 0) return;
      chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { labels: { color: '#e6edf3', usePointStyle: true, padding: 16 } },
            zoom: chartZoomOptions
          },
          scales: {
            x: {
              type: 'time',
              time: { unit: 'day' },
              grid: { color: '#30363d', drawBorder: false },
              ticks: { color: '#8b949e' }
            },
            'y-left': {
              type: 'linear',
              position: 'left',
              grid: { color: '#30363d', drawBorder: false },
              ticks: { color: '#8b949e' }
            },
            'y-right': {
              type: 'linear',
              position: 'right',
              grid: { drawOnChartArea: false, drawBorder: false },
              ticks: { color: '#8b949e' }
            }
          }
        }
      });
    } catch (e) {
      console.error('ChargingDashboard chart error:', e);
    }
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, [filteredData]);

  return /*#__PURE__*/React.createElement("div", {
    className: "dashboard-container"
  }, chargingData.length > 0 ? /*#__PURE__*/React.createElement(React.Fragment, null,
    /*#__PURE__*/React.createElement("div", {
      style: getChartLayoutStyle(mobile)
    },
      /*#__PURE__*/React.createElement("div", {
        style: getChartSidebarStyle(mobile)
      }, /*#__PURE__*/React.createElement("div", {
        style: chartPanelStyle
      }, /*#__PURE__*/React.createElement("div", {
        style: chartPanelHeaderStyle
      }, /*#__PURE__*/React.createElement("span", null, "Time Range")),
        /*#__PURE__*/React.createElement("div", {
          style: { display: 'flex', flexWrap: 'wrap', gap: '4px' }
        }, TIME_RANGES.map(label => /*#__PURE__*/React.createElement("button", {
          key: label,
          className: 'time-button ' + (timeRange === label.toLowerCase() ? 'active' : ''),
          onClick: () => setTimeRange(label.toLowerCase())
        }, label)))
      )),
      /*#__PURE__*/React.createElement("div", {
        style: { flex: 1, minWidth: 0 }
      },
        /*#__PURE__*/React.createElement("div", {
          style: { marginBottom: '8px' }
        }, /*#__PURE__*/React.createElement("span", {
          style: { fontSize: '14px', fontWeight: 600, color: '#e6edf3' }
        }, "Charging Curves Over Time"), /*#__PURE__*/React.createElement("span", {
          style: { fontSize: '11px', color: '#484f58', marginLeft: '12px' }
        }, filteredData.length, " data points \u00B7 Scroll to zoom \u00B7 drag to pan")),
        /*#__PURE__*/React.createElement("div", {
          className: "chart-container"
        }, /*#__PURE__*/React.createElement("canvas", { ref: chartRef }))
      )
    )
  ) : /*#__PURE__*/React.createElement("div", {
    style: { textAlign: 'center', padding: '32px 16px', color: '#6e7681' }
  }, /*#__PURE__*/React.createElement("div", {
    style: { fontSize: '14px', fontWeight: 500, color: '#8b949e', marginBottom: '4px' }
  }, "No charging behavior data found"), /*#__PURE__*/React.createElement("div", {
    style: { fontSize: '12px' }
  }, "BDC_OBC CSV files were not found in this archive.")),
  /*#__PURE__*/React.createElement(CollapsibleFileList, {
    files: sectionFiles,
    selectedFile: selectedFile,
    setSelectedFile: setSelectedFile
  }));
}

// ===== WIFI HISTORY DASHBOARD =====
function WiFiDashboard({ files, sectionFiles }) {
  const [networks, setNetworks] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const decode = f => {
    const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    return decoder.decode(buf);
  };
  useEffect(() => {
    const wifiFiles = files.filter(f => f.isFile && f.data && (
      /wifi/i.test(f.name) || /wireless/i.test(f.name)
    ));
    const nets = [];
    const seen = new Set();
    wifiFiles.forEach(f => {
      try {
        const text = decode(f);
        const ssidMatches = text.matchAll(/<key>SSID_STR<\/key>\s*<string>([^<]+)<\/string>/gi);
        for (const m of ssidMatches) {
          const ssid = m[1];
          if (!seen.has(ssid)) {
            seen.add(ssid);
            const secMatch = text.match(new RegExp(ssid + '[\\s\\S]{0,500}?<key>WPA[^<]*<\\/key>', 'i'));
            const secType = secMatch ? 'WPA' : 'Unknown';
            const dateMatch = text.match(new RegExp(ssid + '[\\s\\S]{0,1000}?<key>lastJoined<\\/key>\\s*<date>([^<]+)<\\/date>', 'i'));
            const lastConnected = dateMatch ? dateMatch[1] : '';
            nets.push({ ssid, securityType: secType, lastConnected, source: f.name });
          }
        }
        const lines = text.split('\n');
        lines.forEach(line => {
          const parts = line.split(/[,\t]/);
          if (parts.length >= 2) {
            const candidate = parts[0].trim();
            if (candidate && candidate.length > 1 && candidate.length < 64 && !candidate.startsWith('#') && !candidate.startsWith('<') && !seen.has(candidate)) {
              const hasSignal = parts.some(p => /^-?\d+\s*d?B?m?$/i.test(p.trim()));
              if (hasSignal) {
                seen.add(candidate);
                const signal = parts.find(p => /^-?\d+/.test(p.trim()));
                nets.push({ ssid: candidate, securityType: 'N/A', lastConnected: '', signalStrength: parseInt(signal) || 0, source: f.name });
              }
            }
          }
        });
      } catch (e) { /* skip */ }
    });
    if (nets.length === 0) {
      wifiFiles.forEach(f => {
        try {
          const text = decode(f);
          const ssidPattern = /(?:SSID|ssid|network)[:\s=]+["']?([A-Za-z0-9_\-\s]{2,32})["']?/gi;
          let m;
          while ((m = ssidPattern.exec(text)) !== null) {
            const ssid = m[1].trim();
            if (!seen.has(ssid)) { seen.add(ssid); nets.push({ ssid, securityType: 'N/A', lastConnected: '', source: f.name }); }
          }
        } catch (e) { /* skip */ }
      });
    }
    setNetworks(nets.sort((a, b) => (b.lastConnected || '').localeCompare(a.lastConnected || '')));
  }, [files]);
  useEffect(() => {
    if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; }
    if (!chartRef.current) return;
    const withSignal = networks.filter(n => n.signalStrength);
    if (withSignal.length === 0) return;
    const sorted = withSignal.sort((a, b) => b.signalStrength - a.signalStrength).slice(0, 15);
    chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: sorted.map(n => n.ssid),
        datasets: [{ label: 'Signal (dBm)', data: sorted.map(n => n.signalStrength),
          backgroundColor: sorted.map(n => n.signalStrength > -50 ? '#3fb950' : n.signalStrength > -70 ? '#d29922' : '#f85149'),
          borderRadius: 4 }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', callback: v => v + ' dBm' } },
          y: { grid: { display: false }, ticks: { color: '#e6edf3', font: { size: 11 } } }
        }
      }
    });
    return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } };
  }, [networks]);
  return /*#__PURE__*/React.createElement("div", { className: "dashboard-container" },
    /*#__PURE__*/React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Known Networks"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#58a6ff' } }, networks.length))),
    networks.some(n => n.signalStrength) && /*#__PURE__*/React.createElement("div", { className: "chart-container", style: { height: '250px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("canvas", { ref: chartRef })),
    networks.length > 0 && /*#__PURE__*/React.createElement("div", { style: { overflowX: 'auto' } },
      /*#__PURE__*/React.createElement("table", { style: { width: '100%', fontSize: '12px', borderCollapse: 'collapse' } },
        /*#__PURE__*/React.createElement("thead", null,
          /*#__PURE__*/React.createElement("tr", { style: { borderBottom: '1px solid #30363d' } },
            ['SSID', 'Security', 'Last Connected', 'Source'].map(h =>
              /*#__PURE__*/React.createElement("th", { key: h, style: { padding: '6px 8px', textAlign: 'left', color: '#8b949e', fontWeight: 500 } }, h)))),
        /*#__PURE__*/React.createElement("tbody", null,
          networks.map((n, i) => /*#__PURE__*/React.createElement("tr", { key: i, style: { borderBottom: '1px solid #21262d' } },
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: '#e6edf3', fontFamily: 'monospace' } }, n.ssid),
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: '#8b949e' } },
              /*#__PURE__*/React.createElement("span", { style: { padding: '1px 6px', borderRadius: '8px', backgroundColor: '#21262d', fontSize: '11px' } }, n.securityType)),
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: '#8b949e', fontSize: '11px' } }, n.lastConnected || 'N/A'),
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: '#6e7681', fontSize: '11px', fontFamily: 'monospace' } }, n.source.split('/').pop())))))),
    networks.length === 0 && /*#__PURE__*/React.createElement("div", { style: { textAlign: 'center', padding: '24px', color: '#6e7681', fontSize: '13px' } },
      "No WiFi network data could be parsed from the available files."),
    /*#__PURE__*/React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

// ===== JETSAM DEEP DIVE DASHBOARD =====
function JetsamDashboard({ files, sectionFiles }) {
  const [events, setEvents] = useState([]);
  const [killedProcesses, setKilledProcesses] = useState([]);
  const [activeTab, setActiveTab] = useState('summary');
  const [selectedFile, setSelectedFile] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const timelineRef = useRef(null);
  const timelineInstance = useRef(null);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const decode = f => {
    const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    return decoder.decode(buf);
  };
  useEffect(() => {
    const jetsamFiles = files.filter(f => f.isFile && f.data && /JetsamEvent/i.test(f.name) && f.name.endsWith('.ips'));
    const allEvents = [];
    const allKilled = [];
    jetsamFiles.forEach(f => {
      try {
        const text = decode(f);
        let jsonStr = text;
        const braceIdx = text.indexOf('{');
        if (braceIdx > 0) jsonStr = text.substring(braceIdx);
        const data = JSON.parse(jsonStr);
        const timestamp = data.timestamp || data.date || f.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
        const reason = data.event || data.reason || 'memory pressure';
        const pageSize = data.pageSize || 16384;
        allEvents.push({ timestamp, reason, source: f.name });
        const procs = data.largestProcesses || data.processes || [];
        procs.forEach(p => {
          const name = p.name || p.processName || 'unknown';
          const rpages = p.rpages || p.residentPages || 0;
          const memBytes = rpages * pageSize;
          const limit = (p.memoryLimit || p.footprintLimit || 0) * pageSize;
          allKilled.push({ name, reason: p.reason || p.state || '', memoryUsage: memBytes, memoryLimit: limit, timestamp, source: f.name });
        });
      } catch (e) {
        try {
          const text = decode(f);
          text.split('\n').forEach(line => {
            try {
              if (line.trim().startsWith('{')) {
                const obj = JSON.parse(line);
                if (obj.largestProcesses || obj.processes) {
                  (obj.largestProcesses || obj.processes || []).forEach(p => {
                    allKilled.push({ name: p.name || 'unknown', reason: p.reason || p.state || '',
                      memoryUsage: (p.rpages || 0) * 16384, memoryLimit: (p.memoryLimit || 0) * 16384,
                      timestamp: obj.timestamp || '', source: f.name });
                  });
                }
              }
            } catch (e2) { /* skip */ }
          });
        } catch (e2) { /* skip */ }
      }
    });
    setEvents(allEvents.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')));
    setKilledProcesses(allKilled.sort((a, b) => b.memoryUsage - a.memoryUsage));
  }, [files]);
  useEffect(() => {
    if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; }
    if (!chartRef.current || killedProcesses.length === 0 || activeTab !== 'summary') return;
    const procMap = {};
    killedProcesses.forEach(p => {
      if (!procMap[p.name]) procMap[p.name] = { totalMem: 0, count: 0 };
      procMap[p.name].totalMem += p.memoryUsage; procMap[p.name].count += 1;
    });
    const top = Object.entries(procMap).sort((a, b) => b[1].totalMem - a[1].totalMem).slice(0, 12);
    const colors = ['#f85149', '#d29922', '#58a6ff', '#3fb950', '#bc8cff', '#f778ba', '#6e7681', '#e6edf3', '#8b949e', '#388bfd', '#56d364', '#db6d28'];
    chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top.map(([name]) => name.length > 20 ? name.slice(0, 18) + '..' : name),
        datasets: [{ label: 'Total Memory', data: top.map(([, v]) => v.totalMem),
          backgroundColor: colors.slice(0, top.length), borderRadius: 4 }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => formatBytes(ctx.raw) } } },
        scales: {
          x: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', callback: v => formatBytes(v) } },
          y: { grid: { display: false }, ticks: { color: '#e6edf3', font: { size: 11 } } }
        }
      }
    });
    return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } };
  }, [killedProcesses, activeTab]);
  useEffect(() => {
    if (timelineInstance.current) { timelineInstance.current.destroy(); timelineInstance.current = null; }
    if (!timelineRef.current || events.length === 0 || activeTab !== 'timeline') return;
    const dateCounts = {};
    events.filter(e => e.timestamp).forEach(e => {
      const day = (e.timestamp || '').slice(0, 10);
      dateCounts[day] = (dateCounts[day] || 0) + 1;
    });
    const labels = Object.keys(dateCounts).sort();
    if (labels.length === 0) return;
    timelineInstance.current = new Chart(timelineRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Jetsam Events', data: labels.map(l => dateCounts[l]),
          backgroundColor: '#f8514988', borderColor: '#f85149', borderWidth: 1, borderRadius: 4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8b949e', maxRotation: 45, font: { size: 10 } } },
          y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', stepSize: 1 }, beginAtZero: true }
        }
      }
    });
    return () => { if (timelineInstance.current) { timelineInstance.current.destroy(); timelineInstance.current = null; } };
  }, [events, activeTab]);
  return /*#__PURE__*/React.createElement("div", { className: "dashboard-container" },
    /*#__PURE__*/React.createElement("div", { className: "tab-bar" },
      ['summary', 'timeline', 'processes'].map(tab =>
        /*#__PURE__*/React.createElement("div", { key: tab, className: `tab ${activeTab === tab ? 'active' : ''}`, onClick: () => setActiveTab(tab) },
          tab === 'summary' ? 'Summary' : tab === 'timeline' ? 'Event Timeline' : 'Killed Processes'))),
    /*#__PURE__*/React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Jetsam Events"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#f85149' } }, events.length)),
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Processes Affected"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#d29922' } }, new Set(killedProcesses.map(p => p.name)).size)),
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Total Terminations"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#e6edf3' } }, killedProcesses.length))),
    activeTab === 'summary' && killedProcesses.length > 0 && /*#__PURE__*/React.createElement("div", { className: "chart-container",
      style: { height: Math.max(200, Math.min(12, new Set(killedProcesses.map(p => p.name)).size) * 28) + 'px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("canvas", { ref: chartRef })),
    activeTab === 'timeline' && /*#__PURE__*/React.createElement("div", { className: "chart-container", style: { height: '250px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("canvas", { ref: timelineRef })),
    activeTab === 'processes' && /*#__PURE__*/React.createElement("div", { style: { overflowX: 'auto', maxHeight: '500px', overflowY: 'auto' } },
      /*#__PURE__*/React.createElement("table", { style: { width: '100%', fontSize: '12px', borderCollapse: 'collapse' } },
        /*#__PURE__*/React.createElement("thead", null,
          /*#__PURE__*/React.createElement("tr", { style: { borderBottom: '1px solid #30363d', position: 'sticky', top: 0, backgroundColor: '#0d1117' } },
            ['Process', 'Reason', 'Memory Usage', 'Memory Limit', 'Timestamp'].map(h =>
              /*#__PURE__*/React.createElement("th", { key: h, style: { padding: '6px 8px', textAlign: 'left', color: '#8b949e', fontWeight: 500 } }, h)))),
        /*#__PURE__*/React.createElement("tbody", null,
          killedProcesses.slice(0, 100).map((p, i) => /*#__PURE__*/React.createElement("tr", { key: i, style: { borderBottom: '1px solid #21262d' } },
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: '#e6edf3', fontFamily: 'monospace' } }, p.name),
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px' } },
              /*#__PURE__*/React.createElement("span", { style: { padding: '1px 6px', borderRadius: '8px', backgroundColor: '#f8514922', color: '#f85149', fontSize: '11px' } }, p.reason || 'killed')),
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: p.memoryUsage > 500 * 1024 * 1024 ? '#f85149' : '#e6edf3', fontFamily: 'monospace' } }, formatBytes(p.memoryUsage)),
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: '#8b949e', fontFamily: 'monospace' } }, p.memoryLimit ? formatBytes(p.memoryLimit) : 'N/A'),
            /*#__PURE__*/React.createElement("td", { style: { padding: '6px 8px', color: '#8b949e', fontSize: '11px' } }, p.timestamp)))))),
    /*#__PURE__*/React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

// ===== THERMAL DASHBOARD =====
function ThermalDashboard({ files, sectionFiles }) {
  const [thermalEvents, setThermalEvents] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const decode = f => {
    const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    return decoder.decode(buf);
  };
  useEffect(() => {
    const thermalFiles = files.filter(f => f.isFile && f.data && /thermal/i.test(f.name));
    const events = [];
    thermalFiles.forEach(f => {
      try {
        const text = decode(f);
        const statePattern = /(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})[^\n]*?thermal[^\n]*?(nominal|fair|serious|critical|light|moderate|heavy|trapping)/gi;
        let m;
        while ((m = statePattern.exec(text)) !== null) {
          events.push({ timestamp: m[1], state: m[2].toLowerCase(), source: f.name });
        }
        const tempPattern = /(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})[^\n]*?(\d{2,3}(?:\.\d+)?)\s*(?:C|degrees|celsius)/gi;
        while ((m = tempPattern.exec(text)) !== null) {
          const temp = parseFloat(m[2]);
          if (temp > 20 && temp < 120) events.push({ timestamp: m[1], temperature: temp, source: f.name });
        }
        const lines = text.split('\n');
        if (lines.length > 1 && /thermal|temp/i.test(lines[0])) {
          const headers = lines[0].split(/[,\t]/);
          const tempIdx = headers.findIndex(h => /temp|thermal|celsius/i.test(h));
          const timeIdx = headers.findIndex(h => /time|date|timestamp/i.test(h));
          if (tempIdx >= 0) {
            lines.slice(1).forEach(line => {
              const cols = line.split(/[,\t]/);
              const temp = parseFloat(cols[tempIdx]);
              if (temp > 20 && temp < 120) events.push({ timestamp: timeIdx >= 0 ? cols[timeIdx] : '', temperature: temp, source: f.name });
            });
          }
        }
      } catch (e) { /* skip */ }
    });
    const plsqlFile = files.find(f => f.isFile && f.data && f.name.endsWith('.plsql'));
    if (plsqlFile) {
      try {
        getSqlJs().then(SQL => {
          try {
            const buf = plsqlFile.data instanceof ArrayBuffer ? new Uint8Array(plsqlFile.data) : plsqlFile.data;
            const db = new SQL.Database(buf);
            const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%thermal%'");
            if (tables.length > 0 && tables[0].values.length > 0) {
              tables[0].values.forEach(([tableName]) => {
                try {
                  const result = db.exec(`SELECT * FROM "${tableName}" LIMIT 500`);
                  if (result.length > 0) {
                    const cols = result[0].columns;
                    const tempCol = cols.findIndex(c => /temp|thermal|celsius/i.test(c));
                    const timeCol = cols.findIndex(c => /time|date|timestamp/i.test(c));
                    const stateCol = cols.findIndex(c => /state|level|pressure/i.test(c));
                    result[0].values.forEach(row => {
                      const evt = { source: tableName };
                      if (timeCol >= 0) evt.timestamp = String(row[timeCol]);
                      if (tempCol >= 0) { const t = parseFloat(row[tempCol]); if (t > 20 && t < 120) evt.temperature = t; }
                      if (stateCol >= 0) evt.state = String(row[stateCol]).toLowerCase();
                      if (evt.temperature || evt.state) events.push(evt);
                    });
                    setThermalEvents([...events].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || '')));
                  }
                } catch (e2) { /* skip */ }
              });
            }
            db.close();
          } catch (e) { /* skip */ }
        });
      } catch (e) { /* skip */ }
    }
    setThermalEvents(events.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || '')));
  }, [files]);
  useEffect(() => {
    if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; }
    if (!chartRef.current || thermalEvents.length === 0) return;
    const withTemp = thermalEvents.filter(e => e.temperature && e.timestamp);
    const withState = thermalEvents.filter(e => e.state && e.timestamp);
    if (withTemp.length > 0) {
      chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
        type: 'line',
        data: {
          labels: withTemp.map(e => e.timestamp),
          datasets: [{ label: 'Temperature (\u00B0C)', data: withTemp.map(e => e.temperature),
            borderColor: '#f85149', backgroundColor: '#f8514922', fill: true, tension: 0.3, pointRadius: 2 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#e6edf3' } }, ...chartZoomOptions.plugins },
          scales: {
            x: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', maxTicksLimit: 10, maxRotation: 45, font: { size: 10 } } },
            y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e', callback: v => v + '\u00B0C' } }
          }
        }
      });
    } else if (withState.length > 0) {
      const stateMap = { nominal: 0, light: 1, fair: 1, moderate: 2, serious: 3, heavy: 3, critical: 4, trapping: 4 };
      const stateColors = { 0: '#3fb950', 1: '#58a6ff', 2: '#d29922', 3: '#f85149', 4: '#ff0000' };
      chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
        type: 'bar',
        data: {
          labels: withState.map(e => e.timestamp),
          datasets: [{ label: 'Thermal State', data: withState.map(e => stateMap[e.state] ?? 0),
            backgroundColor: withState.map(e => stateColors[stateMap[e.state] ?? 0] + '88'),
            borderColor: withState.map(e => stateColors[stateMap[e.state] ?? 0]), borderWidth: 1, borderRadius: 2 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => withState[ctx.dataIndex]?.state || '' } } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#8b949e', maxTicksLimit: 10, maxRotation: 45, font: { size: 10 } } },
            y: { grid: { color: '#30363d' }, min: 0, max: 4,
              ticks: { color: '#8b949e', stepSize: 1, callback: v => ['Nominal', 'Fair', 'Moderate', 'Serious', 'Critical'][v] || '' } }
          }
        }
      });
    }
    return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } };
  }, [thermalEvents]);
  const stateCounts = {};
  thermalEvents.filter(e => e.state).forEach(e => { stateCounts[e.state] = (stateCounts[e.state] || 0) + 1; });
  const stateColorMap = { nominal: '#3fb950', fair: '#58a6ff', light: '#58a6ff', moderate: '#d29922', serious: '#f85149', heavy: '#f85149', critical: '#ff0000', trapping: '#ff0000' };
  return /*#__PURE__*/React.createElement("div", { className: "dashboard-container" },
    /*#__PURE__*/React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Thermal Events"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#e6edf3' } }, thermalEvents.length)),
      Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).map(([state, count]) =>
        /*#__PURE__*/React.createElement("div", { key: state, style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e', textTransform: 'capitalize' } }, state),
          /*#__PURE__*/React.createElement("div", { style: { fontSize: '16px', fontWeight: 600, color: stateColorMap[state] || '#e6edf3' } }, count)))),
    thermalEvents.length > 0 && /*#__PURE__*/React.createElement("div", { className: "chart-container", style: { height: '280px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("canvas", { ref: chartRef })),
    thermalEvents.length > 0 && /*#__PURE__*/React.createElement("div", { style: { maxHeight: '300px', overflowY: 'auto' } },
      thermalEvents.slice(0, 100).map((e, i) =>
        /*#__PURE__*/React.createElement("div", { key: i, style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 10px', borderBottom: '1px solid #21262d', fontSize: '12px' } },
          /*#__PURE__*/React.createElement("span", { style: { color: '#8b949e', fontSize: '11px', minWidth: '140px' } }, e.timestamp || 'N/A'),
          e.state && /*#__PURE__*/React.createElement("span", { style: { padding: '1px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
            backgroundColor: (stateColorMap[e.state] || '#8b949e') + '22', color: stateColorMap[e.state] || '#8b949e', textTransform: 'capitalize' } }, e.state),
          e.temperature && /*#__PURE__*/React.createElement("span", { style: { color: e.temperature > 80 ? '#f85149' : e.temperature > 60 ? '#d29922' : '#e6edf3', fontFamily: 'monospace' } }, e.temperature.toFixed(1) + '\u00B0C'),
          /*#__PURE__*/React.createElement("span", { style: { color: '#6e7681', fontSize: '11px', marginLeft: 'auto' } }, e.source.split('/').pop())))),
    /*#__PURE__*/React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

// ===== SECURITY OVERVIEW DASHBOARD =====
function SecurityDashboard({ files, sectionFiles }) {
  const [securityInfo, setSecurityInfo] = useState({ profiles: [], certificates: [], codeSigning: [], general: [] });
  const [selectedFile, setSelectedFile] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const decode = f => {
    const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    return decoder.decode(buf);
  };
  useEffect(() => {
    const secFiles = files.filter(f => f.isFile && f.data && (
      /security/i.test(f.name) || /ckks/i.test(f.name) || /otctl/i.test(f.name) || /pcsstatus/i.test(f.name) || /transparency/i.test(f.name)
    ));
    const info = { profiles: [], certificates: [], codeSigning: [], general: [] };
    secFiles.forEach(f => {
      try {
        const text = decode(f);
        if (/security/i.test(f.name)) {
          const profilePattern = /(?:profile|Profile)[:\s]+([^\n]+)/gi;
          let m;
          while ((m = profilePattern.exec(text)) !== null) info.profiles.push({ name: m[1].trim(), source: f.name });
          const certPattern = /(?:certificate|cert|Certificate)[:\s]+["']?([^\n"']+)/gi;
          while ((m = certPattern.exec(text)) !== null) info.certificates.push({ name: m[1].trim(), source: f.name });
          const csPattern = /(?:codesign|code.signing|signature)[:\s]+([^\n]+)/gi;
          while ((m = csPattern.exec(text)) !== null) info.codeSigning.push({ status: m[1].trim(), source: f.name });
          text.split('\n').filter(l => l.trim().length > 0).slice(0, 50).forEach(line => {
            if (line.trim() && !line.startsWith('#')) info.general.push({ text: line.trim(), source: f.name });
          });
        }
        if (/ckks/i.test(f.name)) {
          text.split('\n').filter(l => l.trim()).forEach(line => {
            if (/view|zone|status|sync/i.test(line)) info.general.push({ text: line.trim(), source: f.name, category: 'CKKS' });
          });
        }
        if (/otctl/i.test(f.name)) {
          text.split('\n').filter(l => l.trim()).forEach(line => {
            info.general.push({ text: line.trim(), source: f.name, category: 'Octagon Trust' });
          });
        }
      } catch (e) { /* skip */ }
    });
    setSecurityInfo(info);
  }, [files]);
  const totalItems = securityInfo.profiles.length + securityInfo.certificates.length + securityInfo.codeSigning.length;
  return /*#__PURE__*/React.createElement("div", { className: "dashboard-container" },
    /*#__PURE__*/React.createElement("div", { className: "tab-bar" },
      ['overview', 'details'].map(tab =>
        /*#__PURE__*/React.createElement("div", { key: tab, className: `tab ${activeTab === tab ? 'active' : ''}`, onClick: () => setActiveTab(tab) },
          tab === 'overview' ? 'Overview' : 'Raw Details'))),
    /*#__PURE__*/React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Profiles"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#58a6ff' } }, securityInfo.profiles.length)),
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Certificates"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#3fb950' } }, securityInfo.certificates.length)),
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Code Signing"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#d29922' } }, securityInfo.codeSigning.length)),
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Security Files"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#e6edf3' } }, sectionFiles.length))),
    activeTab === 'overview' && /*#__PURE__*/React.createElement(React.Fragment, null,
      securityInfo.profiles.length > 0 && /*#__PURE__*/React.createElement("div", { style: { marginBottom: '16px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 600, color: '#e6edf3', marginBottom: '8px' } }, "Installed Profiles"),
        securityInfo.profiles.map((p, i) =>
          /*#__PURE__*/React.createElement("div", { key: i, style: { display: 'flex', gap: '8px', padding: '6px 10px', borderBottom: '1px solid #21262d', fontSize: '12px' } },
            /*#__PURE__*/React.createElement("span", { style: { color: '#58a6ff' } }, p.name),
            /*#__PURE__*/React.createElement("span", { style: { color: '#6e7681', marginLeft: 'auto', fontSize: '11px' } }, p.source.split('/').pop())))),
      securityInfo.certificates.length > 0 && /*#__PURE__*/React.createElement("div", { style: { marginBottom: '16px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 600, color: '#e6edf3', marginBottom: '8px' } }, "Certificates"),
        securityInfo.certificates.map((c, i) =>
          /*#__PURE__*/React.createElement("div", { key: i, style: { display: 'flex', gap: '8px', padding: '6px 10px', borderBottom: '1px solid #21262d', fontSize: '12px' } },
            /*#__PURE__*/React.createElement("span", { style: { color: '#3fb950' } }, c.name),
            /*#__PURE__*/React.createElement("span", { style: { color: '#6e7681', marginLeft: 'auto', fontSize: '11px' } }, c.source.split('/').pop())))),
      securityInfo.codeSigning.length > 0 && /*#__PURE__*/React.createElement("div", { style: { marginBottom: '16px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 600, color: '#e6edf3', marginBottom: '8px' } }, "Code Signing Status"),
        securityInfo.codeSigning.map((cs, i) =>
          /*#__PURE__*/React.createElement("div", { key: i, style: { padding: '6px 10px', borderBottom: '1px solid #21262d', fontSize: '12px', color: /valid|pass/i.test(cs.status) ? '#3fb950' : '#d29922' } }, cs.status))),
      totalItems === 0 && securityInfo.general.length > 0 && /*#__PURE__*/React.createElement("div", { style: { maxHeight: '400px', overflowY: 'auto' } },
        securityInfo.general.slice(0, 50).map((g, i) =>
          /*#__PURE__*/React.createElement("div", { key: i, style: { display: 'flex', gap: '8px', padding: '4px 10px', borderBottom: '1px solid #21262d', fontSize: '12px' } },
            g.category && /*#__PURE__*/React.createElement("span", { style: { padding: '1px 6px', borderRadius: '8px', backgroundColor: '#21262d', color: '#8b949e', fontSize: '11px', flexShrink: 0 } }, g.category),
            /*#__PURE__*/React.createElement("span", { style: { color: '#e6edf3', fontFamily: 'monospace', fontSize: '11px' } }, g.text))))),
    activeTab === 'details' && /*#__PURE__*/React.createElement("div", { style: { maxHeight: '500px', overflowY: 'auto' } },
      securityInfo.general.map((g, i) =>
        /*#__PURE__*/React.createElement("div", { key: i, style: { display: 'flex', gap: '8px', padding: '4px 10px', borderBottom: '1px solid #21262d', fontSize: '12px' } },
          g.category && /*#__PURE__*/React.createElement("span", { style: { padding: '1px 6px', borderRadius: '8px', backgroundColor: '#21262d', color: '#8b949e', fontSize: '11px', flexShrink: 0 } }, g.category),
          /*#__PURE__*/React.createElement("span", { style: { color: '#e6edf3', fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all' } }, g.text),
          /*#__PURE__*/React.createElement("span", { style: { color: '#6e7681', fontSize: '10px', marginLeft: 'auto', flexShrink: 0 } }, g.source.split('/').pop())))),
    /*#__PURE__*/React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

// ===== SOFTWARE UPDATE HISTORY DASHBOARD =====
function UpdateHistoryDashboard({ files, sectionFiles }) {
  const [updates, setUpdates] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const decode = f => {
    const buf = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
    return decoder.decode(buf);
  };
  useEffect(() => {
    const updateFiles = files.filter(f => f.isFile && f.data && (
      /update/i.test(f.name) || /MobileSoftwareUpdate/i.test(f.name) || /OTAUpdate/i.test(f.name) || /StagingLogs/i.test(f.name)
    ));
    const allUpdates = [];
    const seen = new Set();
    updateFiles.forEach(f => {
      try {
        const text = decode(f);
        const versionPattern = /(?:iOS|iPadOS|version|Version|build|Build)[:\s]*(\d+\.\d+(?:\.\d+)?)\s*(?:\((\w+)\))?/gi;
        let m;
        while ((m = versionPattern.exec(text)) !== null) {
          const version = m[1]; const build = m[2] || ''; const key = version + build;
          if (!seen.has(key)) {
            seen.add(key);
            const context = text.substring(Math.max(0, m.index - 200), m.index + 200);
            const dateMatch = context.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
            allUpdates.push({ version, build, date: dateMatch ? dateMatch[1] : '', source: f.name, status: 'detected' });
          }
        }
        const attemptPattern = /(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})[^\n]*?(update|download|install|upgrade)[^\n]*?(success|succeed|fail|error|complete|abort|cancel)/gi;
        while ((m = attemptPattern.exec(text)) !== null) {
          const status = /fail|error|abort|cancel/i.test(m[3]) ? 'failed' : 'success';
          allUpdates.push({ version: '', build: '', date: m[1], source: f.name, status, action: m[2].toLowerCase() });
        }
      } catch (e) { /* skip */ }
    });
    setUpdates(allUpdates.sort((a, b) => (b.date || '').localeCompare(a.date || '')));
  }, [files]);
  useEffect(() => {
    if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; }
    if (!chartRef.current || updates.length === 0) return;
    const dated = updates.filter(u => u.date);
    if (dated.length === 0) return;
    const dateCounts = { success: {}, failed: {} };
    dated.forEach(u => {
      const day = (u.date || '').slice(0, 10);
      if (u.status === 'failed') dateCounts.failed[day] = (dateCounts.failed[day] || 0) + 1;
      else dateCounts.success[day] = (dateCounts.success[day] || 0) + 1;
    });
    const allDays = [...new Set([...Object.keys(dateCounts.success), ...Object.keys(dateCounts.failed)])].sort();
    chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
      type: 'bar',
      data: {
        labels: allDays,
        datasets: [
          { label: 'Success', data: allDays.map(d => dateCounts.success[d] || 0), backgroundColor: '#3fb95088', borderColor: '#3fb950', borderWidth: 1, borderRadius: 4 },
          { label: 'Failed', data: allDays.map(d => dateCounts.failed[d] || 0), backgroundColor: '#f8514988', borderColor: '#f85149', borderWidth: 1, borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#e6edf3' } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: '#8b949e', maxRotation: 45, font: { size: 10 } } },
          y: { stacked: true, grid: { color: '#30363d' }, ticks: { color: '#8b949e', stepSize: 1 }, beginAtZero: true }
        }
      }
    });
    return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } };
  }, [updates]);
  const versions = updates.filter(u => u.version);
  const attempts = updates.filter(u => u.action);
  const successCount = attempts.filter(u => u.status === 'success').length;
  const failCount = attempts.filter(u => u.status === 'failed').length;
  return /*#__PURE__*/React.createElement("div", { className: "dashboard-container" },
    /*#__PURE__*/React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Versions Detected"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#58a6ff' } }, versions.length)),
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Successful Updates"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: '#3fb950' } }, successCount)),
      /*#__PURE__*/React.createElement("div", { style: { padding: '8px 14px', backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px' } },
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '11px', color: '#8b949e' } }, "Failed Updates"),
        /*#__PURE__*/React.createElement("div", { style: { fontSize: '20px', fontWeight: 600, color: failCount > 0 ? '#f85149' : '#3fb950' } }, failCount))),
    updates.filter(u => u.date).length > 0 && /*#__PURE__*/React.createElement("div", { className: "chart-container", style: { height: '220px', marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("canvas", { ref: chartRef })),
    versions.length > 0 && /*#__PURE__*/React.createElement("div", { style: { marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 600, color: '#e6edf3', marginBottom: '8px' } }, "Version History"),
      /*#__PURE__*/React.createElement("div", { style: { maxHeight: '300px', overflowY: 'auto' } },
        versions.map((v, i) =>
          /*#__PURE__*/React.createElement("div", { key: i, style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 10px', borderBottom: '1px solid #21262d', fontSize: '12px' } },
            /*#__PURE__*/React.createElement("span", { style: { padding: '2px 10px', borderRadius: '12px', backgroundColor: '#58a6ff22', color: '#58a6ff', fontWeight: 600, fontSize: '12px', fontFamily: 'monospace' } }, 'v' + v.version),
            v.build && /*#__PURE__*/React.createElement("span", { style: { padding: '1px 6px', borderRadius: '8px', backgroundColor: '#21262d', color: '#8b949e', fontSize: '11px', fontFamily: 'monospace' } }, v.build),
            /*#__PURE__*/React.createElement("span", { style: { color: '#8b949e', fontSize: '11px' } }, v.date || 'Unknown date'),
            /*#__PURE__*/React.createElement("span", { style: { color: '#6e7681', fontSize: '11px', marginLeft: 'auto' } }, v.source.split('/').pop()))))),
    attempts.length > 0 && /*#__PURE__*/React.createElement("div", { style: { marginBottom: '16px' } },
      /*#__PURE__*/React.createElement("div", { style: { fontSize: '13px', fontWeight: 600, color: '#e6edf3', marginBottom: '8px' } }, "Update Attempts"),
      /*#__PURE__*/React.createElement("div", { style: { maxHeight: '300px', overflowY: 'auto' } },
        attempts.map((a, i) =>
          /*#__PURE__*/React.createElement("div", { key: i, style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 10px', borderBottom: '1px solid #21262d', fontSize: '12px' } },
            /*#__PURE__*/React.createElement("span", { style: { padding: '1px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
              backgroundColor: a.status === 'success' ? '#3fb95022' : '#f8514922', color: a.status === 'success' ? '#3fb950' : '#f85149' } }, a.status),
            a.action && /*#__PURE__*/React.createElement("span", { style: { color: '#8b949e', textTransform: 'capitalize' } }, a.action),
            /*#__PURE__*/React.createElement("span", { style: { color: '#8b949e', fontSize: '11px' } }, a.date),
            /*#__PURE__*/React.createElement("span", { style: { color: '#6e7681', fontSize: '11px', marginLeft: 'auto' } }, a.source.split('/').pop()))))),
    /*#__PURE__*/React.createElement(CollapsibleFileList, { files: sectionFiles, selectedFile: selectedFile, setSelectedFile: setSelectedFile }));
}

const sectionConfig = [{
  id: 1,
  title: 'Unified System Log',
  icon: '📋',
  prefixes: ['system_logs.logarchive/'],
  description: 'Searchable system-wide log entries with timestamps and filtering'
}, {
  id: 2,
  title: 'Power & Battery',
  icon: '🔋',
  prefixes: ['logs/powerlogs/', 'logs/BatteryBDC/', 'logs/BatteryUIPlist/', 'logs/BatteryHealth/'],
  description: 'Battery health trends, charge cycles, and power consumption data'
}, {
  id: 3,
  title: 'System Performance',
  icon: '⚡',
  prefixes: ['spindump-nosymbols.txt', 'taskinfo.txt', 'microstackshots', 'ltop.txt', 'ps.txt', 'zprint.txt', 'vm_stat.txt', 'jetsam_priority.txt', 'jetsam_priority.csv', 'taskSummary.csv'],
  description: 'Memory usage, CPU-heavy processes, and app terminations'
}, {
  id: 4,
  title: 'Crashes & Diagnostics',
  icon: '💥',
  prefixes: ['crashes_and_spins/'],
  description: 'App crashes, hangs, and system fault reports'
}, {
  id: 5,
  title: 'Networking',
  icon: '🌐',
  prefixes: ['logs/Networking/', 'logs/NetworkRelay/', 'WiFi/', 'ifconfig.txt', 'netstat.txt', 'netstat'],
  description: 'Wi-Fi connections, cellular data, and network diagnostics'
}, {
  id: 6,
  title: 'Storage & File System',
  icon: '💾',
  prefixes: ['lsaw.csstoredump', 'swcutil_show.txt', 'apfs_stats.txt', 'disks.txt', 'mount.txt', 'brctl/', 'FileProvider/'],
  description: 'Disk usage, storage volumes, and file system health'
}, {
  id: 7,
  title: 'App & Software Management',
  icon: '📦',
  prefixes: ['logs/MobileAsset/', 'logs/itunesstored/', 'logs/MobileInstallation/', 'logs/MobileSoftwareUpdate/', 'logs/OTAUpdateLogs/', 'logs/StagingLogs/', 'ASPSnapshots/'],
  description: 'App installs, updates, and software management activity'
}, {
  id: 8,
  title: 'Security & Privacy',
  icon: '🔒',
  prefixes: ['security-sysdiagnose.txt', 'ckksctl_status.txt', 'otctl_status.txt', 'pcsstatus.txt', 'transparency.log'],
  description: 'Keychain status, security policies, and privacy logs'
}, {
  id: 9,
  title: 'Hardware & Sensors',
  icon: '🔧',
  prefixes: ['ioreg/', 'hidutil.plist', 'smcDiagnose.txt', 'hpmDiagnose.txt', 'logs/pmudiagnose/'],
  description: 'Hardware registry, sensor data, and thermal diagnostics'
}, {
  id: 10,
  title: 'Bluetooth & Accessories',
  icon: '📡',
  prefixes: ['logs/Bluetooth/', 'logs/UARPEndpointPacketCaptures/', 'logs/AirPodPowerMetrics/'],
  description: 'Bluetooth connections, AirPods, and accessory logs'
}, {
  id: 11,
  title: 'User & Account Management',
  icon: '👤',
  prefixes: ['logs/UserManagement/'],
  description: 'User account and profile management logs'
}, {
  id: 12,
  title: 'Preferences & Settings',
  icon: '⚙️',
  prefixes: ['Preferences/'],
  description: 'System and app preference files'
}, {
  id: 13,
  title: 'Accessibility',
  icon: '♿',
  prefixes: ['logs/Accessibility/', 'logs/AccessibilityPrefs/'],
  description: 'Accessibility feature settings and logs'
}, {
  id: 14,
  title: 'Media & Communication',
  icon: '🎥',
  prefixes: ['logs/AVConference/', 'logs/MobileSlideShow/'],
  description: 'FaceTime, camera, and media playback logs'
}, {
  id: 15,
  title: 'AI & Intelligence',
  icon: '🧠',
  prefixes: ['logs/GenerativeExperiences/', 'logs/ProactiveInputPredictions/', 'Personalization/', 'logs/ModelCatalog/', 'logs/ModelManager/'],
  description: 'On-device AI, Siri suggestions, and personalization data'
}, {
  id: 16,
  title: 'Activation & Provisioning',
  icon: '🔑',
  prefixes: ['logs/MobileActivation/', 'logs/FDR/', 'logs/MobileLockdown/'],
  description: 'Device activation, provisioning, and lockdown state'
}, {
  id: 18,
  title: 'Per-App Battery Drain',
  icon: '📊',
  prefixes: ['logs/BatteryUIPlist/', 'logs/BatteryLife/'],
  description: 'Per-app battery usage breakdown from BatteryUI plist data'
}, {
  id: 19,
  title: 'Battery Gauge (IOService)',
  icon: '🔌',
  prefixes: ['ioreg/'],
  description: 'Battery gauge parameters from IOService registry (Qmax, Ra, CycleCount)'
}, {
  id: 20,
  title: 'Charging Behavior',
  icon: '⚡',
  prefixes: ['logs/BatteryBDC/'],
  description: 'Charging curves and behavior from BDC_OBC CSV data'
}, {
  id: 21,
  title: 'WiFi History',
  icon: '📶',
  prefixes: ['WiFi/', 'logs/Networking/'],
  description: 'Known WiFi networks, connection history, and signal strength'
}, {
  id: 22,
  title: 'Jetsam Deep Dive',
  icon: '🧹',
  prefixes: ['crashes_and_spins/JetsamEvent'],
  description: 'Memory pressure events, killed processes, and memory usage analysis'
}, {
  id: 23,
  title: 'Thermal Monitor',
  icon: '🌡️',
  prefixes: ['logs/pmudiagnose/', 'smcDiagnose.txt'],
  description: 'Thermal state timeline, CPU/GPU temperatures, and throttling events'
}, {
  id: 24,
  title: 'Security Overview',
  icon: '🛡️',
  prefixes: ['security-sysdiagnose.txt', 'ckksctl_status.txt', 'otctl_status.txt', 'pcsstatus.txt', 'transparency.log'],
  description: 'Security profiles, certificates, code signing, and trust status'
}, {
  id: 25,
  title: 'Software Update History',
  icon: '🔄',
  prefixes: ['logs/MobileSoftwareUpdate/', 'logs/OTAUpdateLogs/', 'logs/StagingLogs/'],
  description: 'iOS version timeline, update attempts, success and failure history'
}, {
  id: 26,
  title: 'PowerLog SQL Explorer',
  icon: '\uD83D\uDD0C',
  prefixes: ['logs/powerlogs/'],
  description: 'Query the PowerLog PLSQL database directly with preset or custom SQL queries'
}, {
  id: 27,
  title: 'Process Resource Analysis',
  icon: '\uD83D\uDCCA',
  prefixes: ['taskinfo.txt'],
  description: 'Per-process CPU time, memory usage, and thread counts from taskinfo'
}, {
  id: 17,
  title: 'Other Logs & Data',
  icon: '📁',
  prefixes: [],
  description: 'Files not categorized in other sections'
}];

// ===== SECTION COMPONENT =====
function SectionComponent({
  config,
  files,
  defaultExpanded,
  allFiles
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [selectedFile, setSelectedFile] = useState(null);
  let sectionFiles;
  if (config.id === 17) {
    const matchedPrefixes = new Set();
    sectionConfig.filter(c => c.id !== 17).forEach(c => {
      c.prefixes.forEach(p => matchedPrefixes.add(p));
    });
    sectionFiles = files.filter(f => {
      if (!f.isFile) return false;
      return !config.prefixes.some(p => f.name.startsWith(p)) && !Array.from(matchedPrefixes).some(p => f.name.startsWith(p));
    });
  } else {
    sectionFiles = getSectionFiles(files, config.prefixes);
  }
  const totalSize = sectionFiles.reduce((sum, f) => sum + f.size, 0);
  return /*#__PURE__*/React.createElement("div", {
    className: `section ${expanded ? 'expanded' : ''}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-header",
    onClick: () => setExpanded(!expanded)
  }, /*#__PURE__*/React.createElement("span", {
    className: "section-icon"
  }, config.icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flexGrow: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "section-title",
    style: {
      display: 'block'
    }
  }, config.title), config.description && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '11px',
      color: '#6e7681',
      display: 'block',
      marginTop: '1px',
      lineHeight: 1.3
    }
  }, config.description)), /*#__PURE__*/React.createElement("div", {
    className: "section-info"
  }, sectionFiles.length === 0 ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6e7681'
    }
  }, "No data") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", null, sectionFiles.length, " file", sectionFiles.length !== 1 ? 's' : ''), /*#__PURE__*/React.createElement("span", null, formatBytes(totalSize)))), /*#__PURE__*/React.createElement("span", {
    className: "section-chevron"
  }, "\u203A")), expanded && /*#__PURE__*/React.createElement("div", {
    className: "section-body"
  }, sectionFiles.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      padding: '32px 16px',
      color: '#6e7681'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '32px',
      marginBottom: '12px',
      opacity: 0.5
    }
  }, config.icon), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '14px',
      fontWeight: 500,
      color: '#8b949e',
      marginBottom: '4px'
    }
  }, "No ", config.title.toLowerCase(), " data found"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '12px'
    }
  }, "This sysdiagnose archive does not contain files for this section. This is normal \u2014 not every archive includes all data types.")) : config.id === 1 ? /*#__PURE__*/React.createElement(UnifiedLogDashboard, {
    allFiles: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 2 ? /*#__PURE__*/React.createElement(PowerBatteryDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 3 ? /*#__PURE__*/React.createElement(SystemPerformanceDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 4 ? /*#__PURE__*/React.createElement(CrashesDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 6 ? /*#__PURE__*/React.createElement(StorageDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 18 ? /*#__PURE__*/React.createElement(BatteryDrainDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 19 ? /*#__PURE__*/React.createElement(BatteryGaugeDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 20 ? /*#__PURE__*/React.createElement(ChargingDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 21 ? /*#__PURE__*/React.createElement(WiFiDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 22 ? /*#__PURE__*/React.createElement(JetsamDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 23 ? /*#__PURE__*/React.createElement(ThermalDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 24 ? /*#__PURE__*/React.createElement(SecurityDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 25 ? /*#__PURE__*/React.createElement(UpdateHistoryDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 5 ? /*#__PURE__*/React.createElement(NetworkDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 26 ? /*#__PURE__*/React.createElement(PowerLogDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : config.id === 27 ? /*#__PURE__*/React.createElement(ProcessDashboard, {
    files: allFiles,
    sectionFiles: sectionFiles
  }) : /*#__PURE__*/React.createElement(FileExplorerDashboard, {
    sectionFiles: sectionFiles,
    title: config.title
  })));
}

// ===== MAIN APP COMPONENT =====
function SysdiagnoseExplorer() {
  const [phase, setPhase] = useState('upload');
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');
  const [archiveName, setArchiveName] = useState('');
  const [savedArchives, setSavedArchives] = useState([]);
  const fileInputRef = useRef(null);
  const ipsInputRef = useRef(null);
  const addIpsFiles = async e => {
    const picked = Array.from(e.target.files).filter(f => f.name.endsWith('.ips'));
    e.target.value = '';
    if (!picked.length) return;
    const newEntries = await Promise.all(picked.map(f => f.arrayBuffer().then(buf => ({
      name: 'crashes_and_spins/' + f.name,
      size: f.size,
      isFile: true,
      data: new Uint8Array(buf)
    }))));
    setFiles(prev => {
      const existingNames = new Set(prev.map(f => f.name));
      const fresh = newEntries.filter(f => !existingNames.has(f.name));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  };

  // Load saved archives list on mount
  useEffect(() => {
    listSavedArchives().then(setSavedArchives);
  }, []);
  const loadSaved = async archive => {
    setPhase('extracting');
    setProgress(30);
    setProgressPhase('Loading from cache...');
    setArchiveName(archive.name);
    try {
      const result = await loadFromIndexedDB(archive.id);
      if (result) {
        setFiles(result.files);
        setProgress(100);
        setPhase('ready');
      } else {
        setProgressPhase('Archive not found in cache');
        setTimeout(() => setPhase('upload'), 2000);
      }
    } catch (e) {
      console.error('Load error:', e);
      setProgressPhase('Failed to load: ' + e.message);
      setTimeout(() => setPhase('upload'), 3000);
    }
  };
  const removeSaved = async (e, archiveId) => {
    e.stopPropagation();
    await deleteSavedArchive(archiveId);
    setSavedArchives(prev => prev.filter(a => a.id !== archiveId));
  };
  const handleDragOver = e => {
    e.preventDefault();
    e.currentTarget.classList.add('dragover');
  };
  const handleDragLeave = e => {
    e.currentTarget.classList.remove('dragover');
  };
  const handleDrop = e => {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };
  const handleFileSelect = e => {
    const file = e.target.files[0];
    if (file) processFile(file);
  };
  const processFile = async file => {
    setPhase('extracting');
    setProgress(0);
    setProgressPhase('Decompressing...');
    setArchiveName(file.name);
    try {
      const entries = await TarParser.extract(file, (pct, msg) => {
        setProgress(pct);
        setProgressPhase(msg);
      });

      // Strip the top-level sysdiagnose_* folder prefix
      const processedFiles = entries.map(entry => {
        let name = entry.name;
        const parts = name.split('/');
        if (parts.length > 1) {
          name = parts.slice(1).join('/');
        }
        return {
          ...entry,
          name
        };
      }).filter(f => f.name.length > 0);

      // Parse PLSQL files for performance management data
      const plsqlFiles = processedFiles.filter(f => f.isPLSQL && f.data);
      let plsqlParsed = {
        cpmsData: [],
        batteryEvents: []
      };
      for (const pf of plsqlFiles) {
        try {
          const parsed = await parsePLSQL(pf.data);
          if (parsed.cpmsData.length > plsqlParsed.cpmsData.length) {
            plsqlParsed.cpmsData = parsed.cpmsData;
          }
          if (parsed.batteryEvents.length > plsqlParsed.batteryEvents.length) {
            plsqlParsed.batteryEvents = parsed.batteryEvents;
          }
        } catch (e) {
          console.warn('PLSQL parse failed for', pf.name, e);
        }
      }

      // Store parsed PLSQL data as a synthetic JSON file entry
      if (plsqlParsed.cpmsData.length > 0 || plsqlParsed.batteryEvents.length > 0) {
        const jsonData = new TextEncoder().encode(JSON.stringify(plsqlParsed));
        processedFiles.push({
          name: 'logs/powerlogs/_parsed_plsql.json',
          size: jsonData.byteLength,
          isFile: true,
          data: jsonData.buffer
        });
      }

      // Null out raw PLSQL data before saving (too large for IndexedDB)
      processedFiles.forEach(f => {
        if (f.isPLSQL) {
          f.data = null;
        }
      });
      setFiles(processedFiles);
      setProgress(100);
      setPhase('ready');

      // Persist to IndexedDB so refresh doesn't lose data
      saveToIndexedDB(file.name, processedFiles);
    } catch (err) {
      console.error('Extraction error:', err);
      setProgressPhase('Error: ' + err.message);
      setTimeout(() => setPhase('upload'), 3000);
    }
  };
  if (phase === 'upload') {
    return /*#__PURE__*/React.createElement("div", {
      className: "container"
    }, /*#__PURE__*/React.createElement("div", {
      className: "header"
    }, /*#__PURE__*/React.createElement("h1", null, "Sysdiagnose Explorer"), /*#__PURE__*/React.createElement("p", null, "Understand what's happening on your iPhone \u2014 battery drain, crashes, performance issues, and more")), /*#__PURE__*/React.createElement("div", {
      className: "upload-zone",
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onClick: () => fileInputRef.current?.click()
    }, /*#__PURE__*/React.createElement("div", {
      className: "upload-zone-content"
    }, /*#__PURE__*/React.createElement("div", {
      className: "upload-icon"
    }, "\uD83D\uDCE4"), /*#__PURE__*/React.createElement("h2", null, "Drag and drop your sysdiagnose file"), /*#__PURE__*/React.createElement("p", null, "or click to browse"), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: '12px',
        color: '#6e7681'
      }
    }, "Supports .tar.gz and .tar files"), /*#__PURE__*/React.createElement("p", {
      className: "privacy-note"
    }, "Everything is processed locally \u2014 no data leaves your device")), /*#__PURE__*/React.createElement("input", {
      ref: fileInputRef,
      type: "file",
      accept: ".tar.gz,.tgz,.tar",
      onChange: handleFileSelect
    })), /*#__PURE__*/React.createElement("details", {
      style: {
        marginTop: '16px',
        padding: '16px',
        backgroundColor: '#161b22',
        border: '1px solid #30363d',
        borderRadius: '8px'
      }
    }, /*#__PURE__*/React.createElement("summary", {
      style: {
        fontSize: '14px',
        fontWeight: 500,
        color: '#58a6ff',
        outline: 'none',
        cursor: 'pointer'
      }
    }, "How do I get a sysdiagnose file from my iPhone?"), /*#__PURE__*/React.createElement("ol", {
      style: {
        marginTop: '12px',
        paddingLeft: '20px',
        fontSize: '13px',
        color: '#8b949e',
        lineHeight: 1.8
      }
    }, /*#__PURE__*/React.createElement("li", null, "On your iPhone, press and hold ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: '#e6edf3'
      }
    }, "both volume buttons + the side button"), " for about 1.5 seconds until you feel a short vibration"), /*#__PURE__*/React.createElement("li", null, "Wait about 10 minutes for the diagnostic file to be generated"), /*#__PURE__*/React.createElement("li", null, "Go to ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: '#e6edf3'
      }
    }, "Settings > Privacy & Security > Analytics & Improvements > Analytics Data")), /*#__PURE__*/React.createElement("li", null, "Find the file starting with ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: '#e6edf3'
      }
    }, "sysdiagnose_"), " and share/AirDrop it to this computer"), /*#__PURE__*/React.createElement("li", null, "Drop the ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: '#e6edf3'
      }
    }, ".tar.gz / .tar"), " file above to begin analysis"))), savedArchives.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: '24px'
      }
    }, /*#__PURE__*/React.createElement("h3", {
      style: {
        fontSize: '16px',
        fontWeight: 600,
        marginBottom: '12px',
        color: '#e6edf3'
      }
    }, "Previously Opened Archives"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }
    }, savedArchives.map(archive => /*#__PURE__*/React.createElement("div", {
      key: archive.id,
      onClick: () => loadSaved(archive),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 16px',
        backgroundColor: '#161b22',
        border: '1px solid #30363d',
        borderRadius: '8px',
        cursor: 'pointer',
        transition: 'all 0.2s'
      },
      onMouseEnter: e => e.currentTarget.style.borderColor = '#58a6ff',
      onMouseLeave: e => e.currentTarget.style.borderColor = '#30363d'
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: '24px'
      }
    }, "\uD83D\uDCF1"), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '14px',
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, archive.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '12px',
        color: '#8b949e'
      }
    }, archive.fileCount, " files \xB7 ", formatBytes(archive.totalSize), " \xB7 Saved ", new Date(archive.savedAt).toLocaleDateString())), /*#__PURE__*/React.createElement("button", {
      onClick: e => removeSaved(e, archive.id),
      style: {
        background: 'none',
        border: '1px solid #30363d',
        borderRadius: '6px',
        color: '#8b949e',
        padding: '4px 8px',
        cursor: 'pointer',
        fontSize: '11px',
        flexShrink: 0
      },
      onMouseEnter: e => {
        e.currentTarget.style.borderColor = '#f85149';
        e.currentTarget.style.color = '#f85149';
      },
      onMouseLeave: e => {
        e.currentTarget.style.borderColor = '#30363d';
        e.currentTarget.style.color = '#8b949e';
      }
    }, "Remove"))))));
  }
  if (phase === 'extracting') {
    return /*#__PURE__*/React.createElement("div", {
      className: "container"
    }, /*#__PURE__*/React.createElement("div", {
      className: "header"
    }, /*#__PURE__*/React.createElement("h1", null, "Extracting Sysdiagnose"), archiveName && /*#__PURE__*/React.createElement("p", {
      style: {
        color: '#8b949e',
        fontSize: '13px'
      }
    }, archiveName)), /*#__PURE__*/React.createElement("div", {
      className: "progress-container"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: '8px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "progress-label",
      style: {
        marginBottom: 0
      }
    }, progressPhase), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: '13px',
        color: '#58a6ff',
        fontWeight: 500
      }
    }, Math.round(progress), "%")), /*#__PURE__*/React.createElement("div", {
      className: "progress-bar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "progress-fill",
      style: {
        width: `${progress}%`
      }
    })), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: '12px',
        color: '#6e7681',
        marginTop: '12px'
      }
    }, "This may take a moment for large archives. Everything stays on your device.")));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "container"
  }, /*#__PURE__*/React.createElement("div", {
    className: "header",
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", null, "Sysdiagnose Explorer"), /*#__PURE__*/React.createElement("p", null, archiveName ? archiveName + ' — ' : '', files.filter(f => f.isFile).length, " files \xB7 ", formatBytes(files.reduce((sum, f) => sum + f.size, 0)), " uncompressed")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '8px',
      marginTop: '4px',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("input", {
    ref: ipsInputRef,
    type: "file",
    accept: ".ips",
    multiple: true,
    style: {
      display: 'none'
    },
    onChange: addIpsFiles
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => ipsInputRef.current.click(),
    style: {
      background: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '6px',
      color: '#8b949e',
      padding: '6px 14px',
      cursor: 'pointer',
      fontSize: '13px'
    }
  }, "+ Add .ips files"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setPhase('upload');
      setFiles([]);
      listSavedArchives().then(setSavedArchives);
    },
    style: {
      background: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '6px',
      color: '#8b949e',
      padding: '6px 14px',
      cursor: 'pointer',
      fontSize: '13px'
    }
  }, "Load Another"))), /*#__PURE__*/React.createElement(DeviceHealthBanner, {
    files: files
  }), /*#__PURE__*/React.createElement("div", {
    className: "summary-cards"
  }, /*#__PURE__*/React.createElement("div", {
    className: "summary-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "summary-card-label"
  }, "Crash Reports"), /*#__PURE__*/React.createElement("div", {
    className: "summary-card-value",
    style: {
      color: (() => {
        const count = files.filter(f => f.isFile && f.name.startsWith('crashes_and_spins/')).length;
        return count > 20 ? '#f85149' : count > 0 ? '#d29922' : '#3fb950';
      })()
    }
  }, files.filter(f => f.isFile && f.name.startsWith('crashes_and_spins/')).length), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#6e7681',
      marginTop: '4px'
    }
  }, (() => {
    const count = files.filter(f => f.isFile && f.name.startsWith('crashes_and_spins/')).length;
    return count > 20 ? 'High number — check Crashes section' : count > 0 ? 'Some events found' : 'No crash reports';
  })())), /*#__PURE__*/React.createElement("div", {
    className: "summary-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "summary-card-label"
  }, "Battery Data"), /*#__PURE__*/React.createElement("div", {
    className: "summary-card-value",
    style: {
      color: files.some(f => f.name.includes('BDC_') && f.name.endsWith('.csv')) ? '#3fb950' : '#6e7681'
    }
  }, files.some(f => f.name.includes('BDC_') && f.name.endsWith('.csv')) ? 'Available' : 'None'), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#6e7681',
      marginTop: '4px'
    }
  }, files.some(f => f.name.includes('BDC_') && f.name.endsWith('.csv')) ? 'Open Power & Battery below' : 'No battery logs in this archive')), /*#__PURE__*/React.createElement("div", {
    className: "summary-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "summary-card-label"
  }, "Total Files"), /*#__PURE__*/React.createElement("div", {
    className: "summary-card-value"
  }, files.filter(f => f.isFile).length), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      color: '#6e7681',
      marginTop: '4px'
    }
  }, formatBytes(files.reduce((sum, f) => sum + f.size, 0)), " uncompressed"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px',
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px',
      marginBottom: '24px',
      fontSize: '13px',
      color: '#8b949e'
    }
  }, "Start by looking at the sections below. Sections with the most data are listed first. Click any section to expand it and see charts and details."), /*#__PURE__*/React.createElement("div", {
    className: "sections-container"
  }, sectionConfig.map(config => /*#__PURE__*/React.createElement(SectionComponent, {
    key: config.id,
    config: config,
    files: files,
    defaultExpanded: config.id === 2,
    allFiles: files
  }))));
}

// ===== RENDER =====
try {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('Root element not found');
  if (!ReactDOM || !ReactDOM.createRoot) throw new Error('ReactDOM.createRoot not available');
  const root = ReactDOM.createRoot(rootEl);
  root.render(/*#__PURE__*/React.createElement(ErrorBoundary, null, /*#__PURE__*/React.createElement(SysdiagnoseExplorer, null)));
} catch (renderErr) {
  console.error('Fatal render error:', renderErr);
  const rootEl = document.getElementById('root');
  if (rootEl) {
    rootEl.innerHTML = '<div style="padding:32px;color:#f85149;font-family:monospace;background:#161b22;border:1px solid #f85149;border-radius:8px;margin:24px;">' + '<h3>Render Error</h3><pre style="margin-top:8px;color:#8b949e;white-space:pre-wrap;">' + renderErr.message + '\n' + (renderErr.stack || '') + '</pre></div>';
  }
}

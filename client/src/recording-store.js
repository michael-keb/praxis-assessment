// Keep unacknowledged frames across reloads. A request succeeding is not enough:
// transactions must finish before a frame is considered durably stored/removed.
export function createRecordingStore(caseId) {
  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
          reject(new Error('This browser cannot save recordings. Enable site storage in Google Chrome.'));
          return;
        }
        const request = indexedDB.open('praxis-recordings', 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('frames', { keyPath: 'id' });
          store.createIndex('caseId', 'caseId');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Recording storage is busy. Close other assessment tabs and retry.'));
      }).catch(error => { opening = null; throw error; });
    }
    return opening;
  }
  async function transaction(mode, operate) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('frames', mode);
      const request = operate(tx.objectStore('frames'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || request?.error || new Error('Could not save the recording.'));
      tx.onabort = () => reject(tx.error || new Error('Recording storage was interrupted.'));
    });
  }
  return {
    ready: open,
    list: () => transaction('readonly', store => store.index('caseId').getAll(caseId)),
    put: frame => transaction('readwrite', store => store.put({ ...frame, caseId })),
    remove: ids => transaction('readwrite', store => { ids.forEach(id => store.delete(id)); }),
  };
}

// Runs Bluetooth connections one at a time. A single adapter handles
// concurrent GATT connections poorly - and the Homebridge host may share it
// with other Bluetooth plugins - so sensors take turns.
class ConnectionQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}

// Rejects if `promise` hasn't settled within `ms`. hap-controller has no
// timeouts of its own for BLE operations, and a sensor that walks out of
// range mid-read would otherwise hold the queue forever.
function withTimeout(promise, ms, description) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${description} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { ConnectionQueue, withTimeout };

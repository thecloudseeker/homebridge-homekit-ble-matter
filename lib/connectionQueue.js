// Runs Bluetooth connections one at a time. A single adapter handles
// concurrent GATT connections poorly - and the Homebridge host may share it
// with other Bluetooth plugins - so sensors take turns.
//
// `pause`/`resume` wrap the tasks: scanning is paused while connected.
// BlueZ aborts LE connection attempts ("le-connection-abort-by-local") while
// discovery runs on the same adapter - on a Raspberry Pi every pairing
// attempt failed that way, while connecting with scanning stopped worked.
// Tasks queued back to back share one pause: scanning only resumes once the
// queue is empty, instead of restarting between connections (each restart
// also replays BlueZ's cached advertisements).
class ConnectionQueue {
  constructor({ pause, resume } = {}) {
    this.tail = Promise.resolve();
    this.pause = pause;
    this.resume = resume;
    this.queued = 0;
    this.paused = false;
  }

  run(task) {
    this.queued += 1;
    const wrapped = async () => {
      try {
        if (!this.paused) {
          this.paused = true;
          await this.pause?.();
        }
        return await task();
      } finally {
        this.queued -= 1;
        if (this.queued === 0) {
          this.paused = false;
          await this.resume?.();
        }
      }
    };
    const result = this.tail.then(wrapped, wrapped);
    this.tail = result.catch(() => {});
    return result;
  }
}

class TimeoutError extends Error {}

// Rejects with a TimeoutError if `promise` hasn't settled within `ms`. Only
// stops waiting: the operation itself keeps running (see
// BleSensor.bounded for what that means for a Bluetooth connection).
function withTimeout(promise, ms, description) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new TimeoutError(`${description} timed out after ${ms / 1000}s`),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Waits at most `ms` for `promise`: {status: "fulfilled", value},
// {status: "rejected", reason}, or {status: "pending"} if it didn't settle.
async function settleWithin(promise, ms) {
  try {
    return { status: "fulfilled", value: await withTimeout(promise, ms, "") };
  } catch (reason) {
    return reason instanceof TimeoutError
      ? { status: "pending" }
      : { status: "rejected", reason };
  }
}

module.exports = { ConnectionQueue, withTimeout, settleWithin, TimeoutError };

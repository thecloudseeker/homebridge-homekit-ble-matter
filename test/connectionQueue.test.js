const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ConnectionQueue } = require("../lib/connectionQueue");

test("queued tasks run one at a time and share one pause/resume", async () => {
  const events = [];
  const queue = new ConnectionQueue({
    pause: async () => events.push("pause"),
    resume: async () => events.push("resume"),
  });
  const task = (name) => async () => {
    events.push(`${name}:start`);
    await new Promise((r) => setImmediate(r));
    events.push(`${name}:end`);
    return name;
  };

  const results = await Promise.all([
    queue.run(task("a")),
    queue.run(task("b")),
  ]);

  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(events, [
    "pause",
    "a:start",
    "a:end",
    "b:start",
    "b:end",
    "resume",
  ]);
});

test("a task queued after the queue emptied pauses again", async () => {
  const events = [];
  const queue = new ConnectionQueue({
    pause: async () => events.push("pause"),
    resume: async () => events.push("resume"),
  });
  await queue.run(async () => events.push("a"));
  await queue.run(async () => events.push("b"));
  assert.deepEqual(events, ["pause", "a", "resume", "pause", "b", "resume"]);
});

test("a failing task still resumes scanning once the queue is empty", async () => {
  const events = [];
  const queue = new ConnectionQueue({
    pause: async () => events.push("pause"),
    resume: async () => events.push("resume"),
  });
  await assert.rejects(
    queue.run(async () => {
      throw new Error("boom");
    }),
  );
  assert.deepEqual(events, ["pause", "resume"]);
});

test("a failing task still resumes, rejects, and doesn't block the next one", async () => {
  const events = [];
  const queue = new ConnectionQueue({
    pause: () => events.push("pause"),
    resume: () => events.push("resume"),
  });

  await assert.rejects(
    queue.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await queue.run(async () => "next"), "next");
  assert.deepEqual(events, ["pause", "resume", "pause", "resume"]);
});

test("without hooks it just serializes", async () => {
  assert.equal(await new ConnectionQueue().run(async () => 42), 42);
});

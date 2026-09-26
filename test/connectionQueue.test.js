const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ConnectionQueue } = require("../lib/connectionQueue");

test("tasks run one at a time, each wrapped in pause/resume", async () => {
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
    "resume",
    "pause",
    "b:start",
    "b:end",
    "resume",
  ]);
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

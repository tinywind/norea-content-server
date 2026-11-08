import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildApp } from "../src/app.ts";
import { digest } from "../src/packages.ts";
import { chapterCompositionCatalog, type ChapterCompositionV1 } from "../src/chapter-composition.ts";
import { deviceHeaders } from "./access.ts";

function composition(): ChapterCompositionV1 {
  return { version: 1, updatedAt: 20, entries: [1, 2, 3].map(number => ({
    id: "entry-" + number, path: "/chapter/" + number, storageChapterNumber: String(number),
    sources: [{ pluginId: number === 2 ? "other-source" : "source", novelId: "book", novelPath: "/book",
      chapterPath: "/raw/" + number, chapterNumber: String(number + 10), name: "Source " + number,
      position: number, page: "1", contentType: "html", releaseTime: null }],
    primarySource: 0,
    user: { included: number !== 3, order: number === 3 ? 0 : 3 - number, name: number === 2 ? "My opening" : null,
      chapterNumber: number === 3 ? null : String(3 - number) },
  })) };
}
function metadata(chapterComposition?: ChapterCompositionV1) {
  return { schemaVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book" },
    novel: { name: "Book" }, cover: null,
    chapters: chapterComposition ? chapterCompositionCatalog(chapterComposition) : { "1": "Raw changed", "3": "Excluded upstream" },
    ...(chapterComposition ? { chapterComposition } : {}) };
}

test("preserves chapter sources, custom order and exclusions through HTTP, sparse uploads and restart", async () => {
  await mkdir(".tmp", { recursive: true });
  const dataDir = await mkdtemp(resolve(".tmp/composition-work-"));
  let app = await buildApp({ dataDir, anonymousRead: false });
  const id = digest(JSON.stringify(["source", "/book"]));
  try {
    const headers = await deviceHeaders(app);
    const first = await app.inject({ method: "PUT", url: "/api/v1/works/" + id, headers, payload: metadata(composition()) });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json().metadata.chapterComposition, composition());
    const sparse = await app.inject({ method: "PUT", url: "/api/v1/works/" + id, headers, payload: metadata() });
    assert.equal(sparse.statusCode, 200, sparse.body);
    assert.deepEqual(sparse.json().metadata.chapterComposition, composition());
    assert.deepEqual(sparse.json().metadata.chapters, { "1": "Source 1", "2": "My opening" });
    const older = composition(); older.updatedAt = 10; older.entries[1]!.user.name = "Older";
    const stale = await app.inject({ method: "PUT", url: "/api/v1/works/" + id, headers, payload: metadata(older) });
    assert.equal(stale.statusCode, 200, stale.body);
    assert.deepEqual(stale.json().metadata.chapterComposition, composition());
    const file = JSON.parse(await readFile(join(dataDir, "contents/source/book/novel.json"), "utf8"));
    assert.deepEqual(file.chapterComposition, composition());
    await app.close();
    app = await buildApp({ dataDir, anonymousRead: true });
    const reopened = await app.inject("/api/v1/works/" + id);
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.deepEqual(reopened.json().metadata.chapterComposition, composition());
    assert.deepEqual(reopened.json().metadata.chapters, { "1": "Source 1", "2": "My opening" });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("rejects malformed or contradictory composition uploads without replacing the stored document", async () => {
  await mkdir(".tmp", { recursive: true });
  const dataDir = await mkdtemp(resolve(".tmp/composition-reject-"));
  const app = await buildApp({ dataDir, anonymousRead: false });
  const id = digest(JSON.stringify(["source", "/book"]));
  try {
    const headers = await deviceHeaders(app);
    const first = await app.inject({ method: "PUT", url: "/api/v1/works/" + id, headers, payload: metadata(composition()) });
    assert.equal(first.statusCode, 200);
    const before = await readFile(join(dataDir, "contents/source/book/novel.json"), "utf8");
    const malformed = composition(); malformed.entries[1]!.primarySource = 99;
    const badSource = await app.inject({ method: "PUT", url: "/api/v1/works/" + id, headers, payload: {
      ...metadata(composition()), chapterComposition: malformed,
    } });
    assert.equal(badSource.statusCode, 400, badSource.body);
    const resurrected = await app.inject({ method: "PUT", url: "/api/v1/works/" + id, headers, payload: {
      ...metadata(composition()), chapters: { "1": "Source 1", "2": "My opening", "3": "Excluded" },
    } });
    assert.equal(resurrected.statusCode, 400, resurrected.body);
    assert.equal(await readFile(join(dataDir, "contents/source/book/novel.json"), "utf8"), before);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

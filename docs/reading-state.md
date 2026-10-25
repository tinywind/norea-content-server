# Private reading-state exchange, version 1

Implemented for the 2026-10-25 request to restore server reading records into the
app and exchange them between devices. This extends the earlier content-only
design; account-free device admission and original-file content transfers remain.

## Access and ownership

Both endpoints require `Authorization: Bearer <deviceKey>` for a registered,
unblocked device. Anonymous catalog access and console sessions do not authorize
reading-state access. The request body also contains `syncKey`, an independent
random 32-byte lowercase hexadecimal secret. Devices sharing that secret share
one private reading profile. The server stores only the SHA-256 key digest and
provides no profile-list endpoint. Keep the key out of URLs and logs. Responses
use `Cache-Control: no-store`; use HTTPS for non-loopback deployments.

Possession of the sync key grants access to the profile through any admitted
device. It is separate from the device key, so admitting a new device alone does
not expose another person's records. The records in the server database are not
encrypted at rest; the data-directory owner and backups can read them.

## Protocol

`GET /api/v1/capabilities` includes `personalStateSync: true` and
`readingStateVersion: 1`, alongside the existing protocol and authentication
fields. A content-only older server can still be used for content; clients must
check the reading-state capability before exchanging personal records. Update
clients before deploying this server: app builds that require
`personalStateSync: false` reject the new capability response. Current app builds
accept either a content-only server or reading-state protocol version 1.

`POST /api/v1/reading-state/read` accepts:

```json
{"syncKey":"<64 lowercase hex characters>","offset":0,"limit":500}
```

The response is `{entries,total,nextOffset}`. `nextOffset` is null after the last
page. Omitted offset and limit default to 0 and 500. Limit must be 1–500 and offset
a nonnegative safe integer. Rows are ordered by immutable insertion sequence;
updates do not reorder pages and newly inserted records append. A concurrent
sync may add more rows while reading, so this is incremental page consumption,
not a frozen snapshot. Repeating a transfer is safe.

`POST /api/v1/reading-state/merge` accepts `{syncKey,entries}` and returns
`{received,updated,total}`. A batch contains at most 200 entries and the existing
1 MiB request-body limit applies. The complete batch is validated before an
atomic transaction; an invalid entry does not leave a partially applied batch.
`updated` counts changed records in that batch, including inserts. Unchanged
retries return zero updates. An empty batch is valid.

Each entry has this shape:

```json
{
  "pluginId":"source-id",
  "sourceNovelId":"stable-source-work-id",
  "novelPath":"/work/123",
  "chapterPath":"/chapter/456",
  "chapterNumber":"12",
  "page":"1",
  "unread":false,
  "progress":100,
  "bookmark":true,
  "readAt":1792900000
}
```

`sourceNovelId`, `chapterNumber`, and `readAt` may be null. All other fields are
required. Progress is a finite percentage from 0 through 100; `readAt` is Unix
seconds, not milliseconds, and must be a nonnegative safe integer when present.
Boolean fields are `unread` and `bookmark`. String limits are 200 characters for
plugin ID, chapter number and page, 2,048 for source novel ID, and 16,384 for each
path. Empty or whitespace-only strings are invalid. The app uses page `"1"` for
legacy missing pages and null for missing source IDs or chapter numbers.

Work identity is plugin ID plus the stable source novel ID when present (trimmed
and lowercased), otherwise the original novel path. Chapter identity is the
chapter number plus page when present, otherwise chapter path. Source-ID/path
and number/path identities are explicitly namespaced. Local database row IDs
are never sent. Different plugins, pages and private profiles remain separate.
The client must avoid a number fallback when local chapter numbers are ambiguous.

## Conflict behavior

Merging preserves already accumulated reading information:

| Field | Merge |
| --- | --- |
| `unread` | Logical AND: read on either side remains read |
| `progress` | Maximum percentage |
| `bookmark` | Logical OR: a bookmark on either side remains set |
| `readAt` | Latest non-null timestamp |

A progress value of 100 also marks the record read. Identity descriptors come
from the newer reading timestamp (the incoming descriptor wins equal timestamps).
This protocol supports recovery and combining progress. It intentionally does
not propagate a reading reset, an earlier rereading position, or removal of a
bookmark. Those actions remain local; a later merge can restore the server's
more complete state. Library membership, categories, appearance, content files,
and download selection are outside this endpoint.

## Existing data and verification

The `reading_state_entries` table and index are additive extensions applied only
after the original current-format schema checksum is verified. That checksum
and existing content tables are unchanged. Restarting creates a missing extension
without resetting catalog rows, device credentials, settings or original files.
Unknown legacy database formats still fail startup without modification.
Existing content-only installations start with an empty reading profile. A device
that still holds the user's history must send it before another device can import
it; chapter content alone does not contain historical personal reading records.

`test/reading-state.test.ts` covers authorization, profile isolation, hashed keys,
safe and repeated merges, identity separation, pagination, restart, validation,
and preservation of a current-format database during the additive upgrade.

// Check.id is a Postgres bigint, which Prisma hands back as a JS BigInt, and
// JSON.stringify throws on BigInt values. Serialize them as strings — Number()
// would silently lose precision past 2^53.
//
// Imported for its side effect by BOTH process entrypoints (app.ts and
// worker.ts). The worker needs it too: BullMQ JSON-serializes a job's return
// value into Redis, and the check processor returns a Check row.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function (): string {
  return this.toString();
};

export {};

// Check.id is a bigint and JSON.stringify throws on BigInt, so send it as a
// string (Number() would lose precision). Imported by both app.ts and worker.ts,
// since BullMQ also JSON-encodes the Check row a job returns.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function (): string {
  return this.toString();
};

export {};

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
);

export function sameDirectoryIdentity(left: string, right: string, platform: NodeJS.Platform) {
  if (left === right) return true;
  if (platform !== "darwin") return false;
  const a = decode(left);
  const b = decode(right);
  if (Option.isNone(a) || Option.isNone(b)) return false;
  const [, leftIno, leftBirthtime] = a.value;
  const [, rightIno, rightBirthtime] = b.value;
  // macOS device numbers can change on remount without replacing the directory.
  return (
    leftIno !== "null" &&
    Number(leftIno) > 0 &&
    leftIno === rightIno &&
    Number(leftBirthtime) > 0 &&
    leftBirthtime === rightBirthtime
  );
}
